//! Rollback and race regressions for the identity atomicity audit.
//!
//! Each test forces the second write of a multi-write operation to fail (a
//! trigger raising an exception) or runs the same race concurrently. The
//! pre-fix implementations committed the first write on its own connection, so
//! these assertions failed; the `_on` implementations now roll the whole unit
//! back or serialize it.

use std::sync::Arc;

use orbitid_core::http::now;
use orbitid_core::ids::{id_prefix, new_id};
use orbitid_core::models::VerificationRow;
use orbitid_identity::external_identity::{link_external_account, ExternalProfile};
use orbitid_identity::testing::{
    create_test_client_session, create_test_user, test_app_state, test_app_state_with,
};
use orbitid_identity::users::guards::record_failed_attempt;
use orbitid_identity::verifications::{issue_verification, IssueVerificationInput};

async fn raise_on(
    state: &orbitid_core::AppState,
    trigger_name: &str,
    table: &str,
    when: &str,
    condition: &str,
) {
    let function = format!("{trigger_name}_fn");
    sqlx::query(&format!(
        "CREATE OR REPLACE FUNCTION {function}() RETURNS trigger AS $$ \
         BEGIN IF {condition} THEN RAISE EXCEPTION 'forced failure'; END IF; RETURN NEW; END; \
         $$ LANGUAGE plpgsql"
    ))
    .execute(&state.pool)
    .await
    .expect("trigger function");
    sqlx::query(&format!(
        "CREATE TRIGGER {trigger_name} {when} ON {table} FOR EACH ROW EXECUTE FUNCTION {function}()"
    ))
    .execute(&state.pool)
    .await
    .expect("trigger");
}

#[tokio::test]
async fn failed_attempt_lockout_rolls_back_with_its_device_revocation() {
    let app = test_app_state().await;
    let state = app.state();
    let user = create_test_user(state, "lockout@example.com", "Sup3r-secret!")
        .await
        .unwrap();
    let max = state.settings.get().mfa.max_attempts;
    sqlx::query("UPDATE users SET failed_attempts = $1 WHERE id = $2")
        .bind(max - 1)
        .bind(&user.user.id)
        .execute(&state.pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO trusted_devices (id, user_id, token_hash, label, expires_at, created_at, updated_at) \
         VALUES ($1,$2,'hash','browser',$3,$3,$3)",
    )
    .bind(new_id(id_prefix::TRUSTED_DEVICE))
    .bind(&user.user.id)
    .bind(now() + 60_000)
    .execute(&state.pool)
    .await
    .unwrap();
    raise_on(
        state,
        "fail_trusted_update",
        "trusted_devices",
        "BEFORE UPDATE",
        "true",
    )
    .await;

    let result = record_failed_attempt(state, &user.user.id).await;
    assert!(
        result.is_err(),
        "the forced revocation failure must surface"
    );
    let (locked, attempts): (bool, i64) =
        sqlx::query_as("SELECT locked, failed_attempts FROM users WHERE id = $1")
            .bind(&user.user.id)
            .fetch_one(&state.pool)
            .await
            .unwrap();
    assert!(
        !locked,
        "the lockout must roll back with the failed revocation"
    );
    assert_eq!(attempts, max - 1, "the increment must roll back too");
}

#[tokio::test]
async fn lockout_triggers_exactly_at_the_threshold() {
    let app = test_app_state().await;
    let state = app.state();
    let user = create_test_user(state, "threshold@example.com", "Sup3r-secret!")
        .await
        .unwrap();
    let max = state.settings.get().mfa.max_attempts;
    for _ in 0..max - 1 {
        record_failed_attempt(state, &user.user.id).await.unwrap();
    }
    let (locked, attempts): (bool, i64) =
        sqlx::query_as("SELECT locked, failed_attempts FROM users WHERE id = $1")
            .bind(&user.user.id)
            .fetch_one(&state.pool)
            .await
            .unwrap();
    assert!(!locked);
    assert_eq!(attempts, max - 1);
    record_failed_attempt(state, &user.user.id).await.unwrap();
    let (locked, attempts): (bool, i64) =
        sqlx::query_as("SELECT locked, failed_attempts FROM users WHERE id = $1")
            .bind(&user.user.id)
            .fetch_one(&state.pool)
            .await
            .unwrap();
    assert!(locked, "the threshold attempt locks the account");
    assert_eq!(attempts, 0, "the counter resets as part of the lockout");
}

#[tokio::test]
async fn concurrent_external_link_creation_never_fails_the_loser() {
    let app = test_app_state().await;
    let state = Arc::new(app.state().clone());
    let user = create_test_user(state.as_ref(), "link@example.com", "Sup3r-secret!")
        .await
        .unwrap();
    let profile = ExternalProfile {
        provider: "github".into(),
        provider_user_id: "gh-42".into(),
        email: Some("link@example.com".into()),
        email_verified: Some(true),
        ..Default::default()
    };
    let left = {
        let state = state.clone();
        let user_id = user.user.id.clone();
        let profile = profile.clone();
        tokio::spawn(async move { link_external_account(&state, &user_id, &profile).await })
    };
    let right = {
        let state = state.clone();
        let user_id = user.user.id.clone();
        let profile = profile.clone();
        tokio::spawn(async move { link_external_account(&state, &user_id, &profile).await })
    };
    let left = left.await.unwrap();
    let right = right.await.unwrap();
    assert!(left.is_ok(), "first link failed: {left:?}");
    assert!(
        right.is_ok(),
        "the losing link must converge, not 500: {right:?}"
    );
    let rows: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM external_accounts WHERE provider = 'github' \
         AND provider_user_id = 'gh-42'",
    )
    .fetch_one(&state.pool)
    .await
    .unwrap();
    assert_eq!(rows, 1);
}

#[tokio::test]
async fn issuing_a_verification_rolls_back_the_invalidation_on_failure() {
    let app = test_app_state().await;
    let state = app.state();
    let user = create_test_user(state, "issue@example.com", "Sup3r-secret!")
        .await
        .unwrap();
    let first = issue_verification(
        state,
        IssueVerificationInput::new(
            "sign_in_first_factor",
            "email_code",
            "issue@example.com",
            &user.user.id,
            300,
        ),
    )
    .await
    .unwrap();
    raise_on(
        state,
        "fail_verification_insert",
        "verifications",
        "BEFORE INSERT",
        "true",
    )
    .await;
    let result = issue_verification(
        state,
        IssueVerificationInput::new(
            "sign_in_first_factor",
            "email_code",
            "issue@example.com",
            &user.user.id,
            300,
        ),
    )
    .await;
    assert!(result.is_err(), "the forced insert failure must surface");
    let (expires_at,): (i64,) =
        sqlx::query_as("SELECT expires_at FROM verifications WHERE id = $1")
            .bind(&first.row.id)
            .fetch_one(&state.pool)
            .await
            .unwrap();
    assert!(expires_at > now(), "the previous code must stay valid");
}

#[tokio::test]
async fn concurrent_issues_leave_exactly_one_live_verification() {
    // Two issues run at once, each in its own transaction, so the pool needs a
    // connection for each. On one connection the second waits out the first and
    // can hit the acquire timeout on a slow runner.
    let app = test_app_state_with(orbitid_core::testing::test_pool_exemption(2)).await;
    let state = Arc::new(app.state().clone());
    let user = create_test_user(state.as_ref(), "race-issue@example.com", "Sup3r-secret!")
        .await
        .unwrap();
    let left = {
        let state = state.clone();
        let owner = user.user.id.clone();
        tokio::spawn(async move {
            issue_verification(
                &state,
                IssueVerificationInput::new(
                    "sign_in_first_factor",
                    "email_code",
                    "race-issue@example.com",
                    owner,
                    300,
                ),
            )
            .await
        })
    };
    let right = {
        let state = state.clone();
        let owner = user.user.id.clone();
        tokio::spawn(async move {
            issue_verification(
                &state,
                IssueVerificationInput::new(
                    "sign_in_first_factor",
                    "email_code",
                    "race-issue@example.com",
                    owner,
                    300,
                ),
            )
            .await
        })
    };
    left.await.unwrap().unwrap();
    right.await.unwrap().unwrap();
    let live: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM verifications WHERE owner_id = $1 \
         AND purpose = 'sign_in_first_factor' AND expires_at > $2",
    )
    .bind(&user.user.id)
    .bind(now())
    .fetch_one(&state.pool)
    .await
    .unwrap();
    assert_eq!(live, 1);
}

#[tokio::test]
async fn a_correct_code_transitions_to_verified_only_once() {
    let app = test_app_state().await;
    let state = Arc::new(app.state().clone());
    let user = create_test_user(state.as_ref(), "code@example.com", "Sup3r-secret!")
        .await
        .unwrap();
    let issued = issue_verification(
        state.as_ref(),
        IssueVerificationInput::new(
            "sign_in_first_factor",
            "email_code",
            "code@example.com",
            &user.user.id,
            300,
        ),
    )
    .await
    .unwrap();
    let code = issued.code.clone().unwrap();
    sqlx::query("CREATE TABLE code_transitions (id bigint GENERATED ALWAYS AS IDENTITY)")
        .execute(&state.pool)
        .await
        .unwrap();
    sqlx::query(
        "CREATE FUNCTION log_verification_transition() RETURNS trigger AS $$ \
         BEGIN INSERT INTO code_transitions DEFAULT VALUES; RETURN NEW; END; $$ LANGUAGE plpgsql",
    )
    .execute(&state.pool)
    .await
    .unwrap();
    sqlx::query(
        "CREATE TRIGGER log_verification_transition AFTER UPDATE OF verified_at ON verifications \
         FOR EACH ROW WHEN (NEW.verified_at IS NOT NULL) \
         EXECUTE FUNCTION log_verification_transition()",
    )
    .execute(&state.pool)
    .await
    .unwrap();

    let mut tasks = Vec::new();
    for _ in 0..8 {
        let state = state.clone();
        let row: VerificationRow = issued.row.clone();
        let code = code.clone();
        tasks.push(tokio::spawn(async move {
            orbitid_identity::verifications::check_code(&state, Some(&row), Some(&code)).await
        }));
    }
    let mut accepted = 0;
    for task in tasks {
        let result = task.await.unwrap();
        if result.is_ok() {
            accepted += 1;
        } else {
            // The attempt budget is intentionally shared by concurrent callers;
            // a caller that cannot claim an attempt is a legitimate loser.
            assert_eq!(
                result.unwrap_err().code,
                "too_many_attempts",
                "only the attempt budget may reject a correct code"
            );
        }
    }
    assert!(accepted >= 1, "at least one correct submission is accepted");
    let transitions: i64 = sqlx::query_scalar("SELECT count(*) FROM code_transitions")
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(transitions, 1, "only one request may transition the row");
}

#[tokio::test]
async fn deleting_a_user_rolls_back_when_an_organization_cannot_be_deleted() {
    let app = test_app_state().await;
    let state = app.state();
    let user = create_test_user(state, "delete-me@example.com", "Sup3r-secret!")
        .await
        .unwrap();
    let org =
        orbitid_identity::testing::create_test_organization(state, "Solo", None, &user.user.id)
            .await
            .unwrap();
    raise_on(
        state,
        "fail_org_delete",
        "organizations",
        "BEFORE DELETE",
        "true",
    )
    .await;
    let result = orbitid_identity::orgs::on_user_deleted(state, &user.user.id).await;
    assert!(
        result.is_err(),
        "the forced organization delete failure surfaces"
    );
    let membership: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM organization_memberships WHERE organization_id = $1 AND user_id = $2",
    )
    .bind(&org.id)
    .bind(&user.user.id)
    .fetch_one(&state.pool)
    .await
    .unwrap();
    assert_eq!(membership, 1, "the membership deletion must roll back");
}

#[tokio::test]
async fn domain_enrollment_rolls_back_every_membership_when_a_later_one_fails() {
    let app = test_app_state().await;
    let state = app.state();
    let first = create_test_user(state, "a@enroll.test", "Sup3r-secret!")
        .await
        .unwrap();
    let second = create_test_user(state, "b@enroll.test", "Sup3r-secret!")
        .await
        .unwrap();
    let org =
        orbitid_identity::testing::create_test_organization(state, "Enroll", None, &first.user.id)
            .await
            .unwrap();
    // Remove the creator so both users are fresh candidates.
    sqlx::query("DELETE FROM organization_memberships WHERE organization_id = $1")
        .bind(&org.id)
        .execute(&state.pool)
        .await
        .unwrap();
    let now_ms = now();
    sqlx::query(
        "INSERT INTO organization_domains (id, organization_id, name, enrollment_mode, verified, \
         created_at, updated_at) VALUES ($1,$2,'enroll.test','automatic_invitation',true,$3,$3)",
    )
    .bind(new_id(id_prefix::DOMAIN))
    .bind(&org.id)
    .bind(now_ms)
    .execute(&state.pool)
    .await
    .unwrap();
    let domain: orbitid_core::models::OrganizationDomainRow =
        sqlx::query_as("SELECT * FROM organization_domains WHERE organization_id = $1")
            .bind(&org.id)
            .fetch_one(&state.pool)
            .await
            .unwrap();
    sqlx::query("CREATE SEQUENCE enroll_inserts")
        .execute(&state.pool)
        .await
        .unwrap();
    sqlx::query(
        "CREATE FUNCTION fail_second_membership() RETURNS trigger AS $$ \
         BEGIN IF nextval('enroll_inserts') > 1 THEN RAISE EXCEPTION 'forced failure'; END IF; \
         RETURN NEW; END; $$ LANGUAGE plpgsql",
    )
    .execute(&state.pool)
    .await
    .unwrap();
    sqlx::query(
        "CREATE TRIGGER fail_second_membership BEFORE INSERT ON organization_memberships \
         FOR EACH ROW EXECUTE FUNCTION fail_second_membership()",
    )
    .execute(&state.pool)
    .await
    .unwrap();
    let result = orbitid_identity::orgs::apply_domain_enrollment(
        state,
        &domain,
        &[first.user.id.clone(), second.user.id.clone()],
    )
    .await;
    assert!(result.is_err(), "the forced second insert failure surfaces");
    let members: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM organization_memberships WHERE organization_id = $1",
    )
    .bind(&org.id)
    .fetch_one(&state.pool)
    .await
    .unwrap();
    assert_eq!(members, 0, "no partial domain enrollment may commit");
}

#[tokio::test]
async fn email_verification_rolls_back_an_accepted_invitation_when_enrollment_fails() {
    let app = test_app_state().await;
    let state = app.state();
    let user = create_test_user(state, "invite@enroll.test", "Sup3r-secret!")
        .await
        .unwrap();
    let inviter = create_test_user(state, "inviter@other.test", "Sup3r-secret!")
        .await
        .unwrap();
    let invited_org = orbitid_identity::testing::create_test_organization(
        state,
        "Invited",
        None,
        &inviter.user.id,
    )
    .await
    .unwrap();
    let domain_org = orbitid_identity::testing::create_test_organization(
        state,
        "Domain",
        None,
        &inviter.user.id,
    )
    .await
    .unwrap();
    let now_ms = now();
    sqlx::query(
        "INSERT INTO organization_invitations (id, organization_id, email, role_key, status, \
         token_hash, public_metadata, private_metadata, expires_at, created_at, updated_at) \
         VALUES ($1,$2,'invite@enroll.test','org:member','pending',$3,'{}'::jsonb,'{}'::jsonb, \
                 $4,$4,$4)",
    )
    .bind(new_id(id_prefix::INVITATION))
    .bind(&invited_org.id)
    .bind("hash_invite")
    .bind(now_ms + 60_000)
    .execute(&state.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO organization_domains (id, organization_id, name, enrollment_mode, verified, \
         created_at, updated_at) VALUES ($1,$2,'enroll.test','automatic_invitation',true,$3,$3)",
    )
    .bind(new_id(id_prefix::DOMAIN))
    .bind(&domain_org.id)
    .bind(now_ms)
    .execute(&state.pool)
    .await
    .unwrap();
    raise_on(
        state,
        "fail_domain_membership",
        "organization_memberships",
        "BEFORE INSERT",
        &format!("NEW.organization_id = '{}'", domain_org.id),
    )
    .await;
    let result =
        orbitid_identity::orgs::on_user_email_verified(state, &user.user.id, "invite@enroll.test")
            .await;
    assert!(
        result.is_err(),
        "the forced domain enrollment failure surfaces"
    );
    let status: String = sqlx::query_scalar(
        "SELECT status FROM organization_invitations WHERE organization_id = $1",
    )
    .bind(&invited_org.id)
    .fetch_one(&state.pool)
    .await
    .unwrap();
    assert_eq!(
        status, "pending",
        "the invitation acceptance must roll back"
    );
    let membership: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM organization_memberships WHERE organization_id = $1 AND user_id = $2",
    )
    .bind(&invited_org.id)
    .bind(&user.user.id)
    .fetch_one(&state.pool)
    .await
    .unwrap();
    assert_eq!(membership, 0);
}

#[tokio::test]
async fn concurrent_identifier_deletes_never_remove_the_last_identification() {
    let app = test_app_state().await;
    let state = Arc::new(app.state().clone());
    let user = create_test_user(state.as_ref(), "ids@example.com", "Sup3r-secret!")
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO external_accounts (id, user_id, provider, provider_user_id, \
         email_address, first_name, last_name, approved_scopes, public_metadata, created_at, updated_at) \
         VALUES ($1,$2,'github','gh-ids','ids@example.com','','','','{}',$3,$3)",
    )
    .bind(new_id(id_prefix::EXTERNAL))
    .bind(&user.user.id)
    .bind(now())
    .execute(&state.pool)
    .await
    .unwrap();
    let email_id: String = sqlx::query_scalar("SELECT id FROM email_addresses WHERE user_id = $1")
        .bind(&user.user.id)
        .fetch_one(&state.pool)
        .await
        .unwrap();
    let external_id: String =
        sqlx::query_scalar("SELECT id FROM external_accounts WHERE user_id = $1")
            .bind(&user.user.id)
            .fetch_one(&state.pool)
            .await
            .unwrap();
    let left = {
        let state = state.clone();
        let user_id = user.user.id.clone();
        let email_id = email_id.clone();
        tokio::spawn(async move {
            orbitid_identity::users::delete_email_address(&state, &user_id, &email_id).await
        })
    };
    let right = {
        let state = state.clone();
        let user_id = user.user.id.clone();
        let external_id = external_id.clone();
        tokio::spawn(async move {
            orbitid_identity::external_identity::delete_external_account(
                &state,
                &user_id,
                &external_id,
            )
            .await
        })
    };
    let left = left.await.unwrap();
    let right = right.await.unwrap();
    assert_eq!(
        usize::from(left.is_ok()) + usize::from(right.is_ok()),
        1,
        "exactly one deletion may win: {left:?} / {right:?}"
    );
    let remaining: i64 = sqlx::query_scalar(
        "SELECT (SELECT count(*) FROM email_addresses WHERE user_id = $1) \
              + (SELECT count(*) FROM external_accounts WHERE user_id = $1)",
    )
    .bind(&user.user.id)
    .fetch_one(&state.pool)
    .await
    .unwrap();
    assert_eq!(remaining, 1, "the last identification survives");
}

#[tokio::test]
async fn concurrent_anonymous_upgrades_converge_on_a_regular_account() {
    let app = test_app_state().await;
    let state = Arc::new(app.state().clone());
    let guest = orbitid_identity::users::create_user(
        state.as_ref(),
        &orbitid_identity::users::CreateUserInput {
            is_anonymous: true,
            silent: true,
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let now_ms = now();
    sqlx::query(
        "INSERT INTO email_addresses (id, user_id, email, verified, verified_at, created_at, updated_at) \
         VALUES ($1,$2,'guest@example.com',true,$3,$3,$3)",
    )
    .bind(new_id(id_prefix::EMAIL))
    .bind(&guest.id)
    .bind(now_ms)
    .execute(&state.pool)
    .await
    .unwrap();
    let left = {
        let state = state.clone();
        let id = guest.id.clone();
        tokio::spawn(
            async move { orbitid_identity::users::upgrade_anonymous_user(&state, &id).await },
        )
    };
    let right = {
        let state = state.clone();
        let id = guest.id.clone();
        tokio::spawn(
            async move { orbitid_identity::users::upgrade_anonymous_user(&state, &id).await },
        )
    };
    assert!(!left.await.unwrap().unwrap().unwrap().is_anonymous);
    assert!(!right.await.unwrap().unwrap().unwrap().is_anonymous);
    let anonymous: bool = sqlx::query_scalar("SELECT is_anonymous FROM users WHERE id = $1")
        .bind(&guest.id)
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert!(!anonymous);
}

#[tokio::test]
async fn ending_other_sessions_keeps_the_current_one() {
    let app = test_app_state().await;
    let state = app.state();
    let user = create_test_user(state, "sessions@example.com", "Sup3r-secret!")
        .await
        .unwrap();
    let first = create_test_client_session(state, &user.user.id)
        .await
        .unwrap();
    let second = create_test_client_session(state, &user.user.id)
        .await
        .unwrap();
    let mut tx = state.pool.begin().await.unwrap();
    orbitid_identity::sessions::end_other_sessions_on(
        &mut tx,
        state,
        &user.user.id,
        &second.session.id,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let kept: String = sqlx::query_scalar("SELECT status FROM sessions WHERE id = $1")
        .bind(&second.session.id)
        .fetch_one(&state.pool)
        .await
        .unwrap();
    let ended: String = sqlx::query_scalar("SELECT status FROM sessions WHERE id = $1")
        .bind(&first.session.id)
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(kept, "active");
    assert_eq!(ended, "revoked");
}

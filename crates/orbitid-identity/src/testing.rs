//! Test fixtures for the identity layer (`test-util` feature).
//!
//! [`test_app_state`] builds a fully installed state (services, RBAC seed,
//! signing-key check, operator hook) on an ephemeral database. The other
//! helpers are the domain-level equivalents of the TypeScript `signUpUser` /
//! `createOrg` / `seedAuth` test helpers: they create the same rows through the
//! real services, so upper-crate tests exercise production code paths.

use std::path::PathBuf;

use orbitid_core::config::EnvOverrides;
use orbitid_core::error::{OrbitError, Result};
use orbitid_core::http::now;
use orbitid_core::ids::{id_prefix, new_id};
use orbitid_core::models::{ClientRow, OperatorSessionRow, OrganizationRow, SessionRow, UserRow};
use orbitid_core::state::AppState;
use orbitid_core::testing::{test_state_with, TestContext};

/// Re-exported so identity-level tests can state that they need more than one
/// connection (`test_pool_exemption(n)`) or inspect the suite-wide gate.
pub use orbitid_core::testing::{test_pool_exemption, test_pool_limits};
use orbitid_credentials::mfa::{finish_totp_setup, start_totp_setup};
use orbitid_credentials::passwords::hash_password;

use crate::client_auth::create_client;
use crate::install::{install_without_workers, InstallHandles};
use crate::orgs::creator_role_key;
use crate::sessions::{create_session, CreateSessionInput};
use crate::tokens::{sign_session_token, SignSessionTokenOptions};
use crate::users::{create_user, CreateUserInput};

/// A migrated, fully installed state plus its ephemeral database.
pub struct TestApp {
    pub context: TestContext,
    pub handles: InstallHandles,
}

impl TestApp {
    pub fn state(&self) -> &AppState {
        &self.context.state
    }

    /// Cloned state for services; the database lives in `self.context.db`.
    pub fn app_state(&self) -> AppState {
        self.context.state.clone()
    }

    pub fn data_dir(&self) -> PathBuf {
        self.context.data_dir.clone()
    }
}

/// Builds a fully installed test state on an ephemeral database.
pub async fn test_app_state() -> TestApp {
    test_app_state_with(EnvOverrides::default()).await
}

/// Same as [`test_app_state`] with environment overrides (base URL, keys, …).
pub async fn test_app_state_with(overrides: EnvOverrides) -> TestApp {
    let context = test_state_with(overrides).await;
    let handles = match install_without_workers(&context.state).await {
        Ok(handles) => handles,
        Err(error) => panic!("could not install identity layer: {error}"),
    };
    TestApp { context, handles }
}

/// A verified user with an email and password (the `signUpUser` shape).
#[derive(Debug, Clone)]
pub struct TestUser {
    pub user: UserRow,
    pub email: String,
    pub password: String,
}

impl TestUser {
    pub fn id(&self) -> &str {
        &self.user.id
    }
}

/// Creates a user whose email is already verified and whose password is a real
/// argon2 hash.
pub async fn create_test_user(state: &AppState, email: &str, password: &str) -> Result<TestUser> {
    let hash = hash_password(password).await?;
    let user = create_user(
        state,
        &CreateUserInput {
            email: Some(email.to_string()),
            password_hash: Some(hash),
            email_verified: true,
            email_verified_strategy: Some("email_code".into()),
            silent: true,
            ..Default::default()
        },
    )
    .await?;
    Ok(TestUser {
        user,
        email: email.trim().to_lowercase(),
        password: password.to_string(),
    })
}

/// Creates a user row with no verified identifier (unverified email).
pub async fn create_test_unverified_user(state: &AppState, email: &str) -> Result<TestUser> {
    let user = create_user(
        state,
        &CreateUserInput {
            email: Some(email.to_string()),
            silent: true,
            ..Default::default()
        },
    )
    .await?;
    Ok(TestUser {
        user,
        email: email.trim().to_lowercase(),
        password: String::new(),
    })
}

/// Creates a guest account (no identifier) for anonymous-flow tests.
pub async fn create_test_guest(state: &AppState) -> Result<UserRow> {
    create_user(
        state,
        &CreateUserInput {
            is_anonymous: true,
            silent: true,
            ..Default::default()
        },
    )
    .await
}

/// A client, its opaque token/cookie, and the active session it owns.
#[derive(Debug, Clone)]
pub struct TestSession {
    pub client: ClientRow,
    pub token: String,
    /// `__client=<token>` ready for a `Cookie` header.
    pub cookie: String,
    pub session: SessionRow,
    pub jwt: String,
}

/// Creates a client and an active session for `user_id`, then mints its JWT.
pub async fn create_test_client_session(state: &AppState, user_id: &str) -> Result<TestSession> {
    let (client, token) = create_client(state, Some("127.0.0.1"), Some("test-agent/1.0")).await?;
    let created = create_session(
        state,
        CreateSessionInput {
            method: Some("password".into()),
            ..CreateSessionInput::new(client.id.clone(), user_id.to_string())
        },
    )
    .await?;
    let session = crate::sessions::get_session(state, &created.id)
        .await?
        .ok_or_else(|| OrbitError::internal("test session disappeared"))?;
    let jwt = sign_session_token(state, &session.id, SignSessionTokenOptions::default()).await?;
    Ok(TestSession {
        cookie: format!("__client={token}"),
        client,
        token,
        session,
        jwt,
    })
}

/// An owner signed in on a browser with the dashboard console open.
#[derive(Debug, Clone)]
pub struct TestConsole {
    pub user: TestUser,
    pub auth: TestSession,
    pub operator: OperatorSessionRow,
    /// The plaintext console cookie token.
    pub token: String,
    /// `__client=…; __orbit_operator=…`, ready for a `Cookie` header.
    pub cookie: String,
}

/// Creates a user with the Owner role, signs it in and opens its console
/// session: the only way into the dashboard now that the secret key is not one.
pub async fn create_test_console(state: &AppState, email: &str) -> Result<TestConsole> {
    let user = create_test_user(state, email, "correct horse battery staple").await?;
    let mut tx = state.pool.begin().await?;
    crate::locks::lock_user_on(&mut tx, user.id()).await?;
    crate::authorization::replace_user_roles(
        &mut tx,
        user.id(),
        &[crate::rbac::OWNER_ROLE_KEY.to_string()],
        now(),
    )
    .await?;
    tx.commit().await?;
    let auth = create_test_client_session(state, user.id()).await?;
    let (operator, token) = crate::operator_session::issue_user_operator_session(
        state,
        crate::operator_session::ConsoleUser {
            user_id: user.id(),
            session_id: &auth.session.id,
        },
        None,
        None,
    )
    .await?;
    Ok(TestConsole {
        cookie: format!("{}; __orbit_operator={token}", auth.cookie),
        user,
        auth,
        operator,
        token,
    })
}

/// A signed-up user plus their first browser session.
#[derive(Debug, Clone)]
pub struct SignedUpUser {
    pub user: TestUser,
    pub auth: TestSession,
}

/// The domain-level equivalent of `signUpUser(app)`.
pub async fn sign_up_user(state: &AppState, email: &str, password: &str) -> Result<SignedUpUser> {
    let user = create_test_user(state, email, password).await?;
    let auth = create_test_client_session(state, &user.user.id).await?;
    Ok(SignedUpUser { user, auth })
}

/// Creates an organization owned by `creator_id` with the instance's creator
/// role (the `createOrg` helper).
pub async fn create_test_organization(
    state: &AppState,
    name: &str,
    slug: Option<&str>,
    creator_id: &str,
) -> Result<OrganizationRow> {
    let slug = match slug {
        Some(slug) => crate::org_shared::normalize_slug(slug)?,
        None => crate::org_shared::slugify(name),
    };
    let now_ms = now();
    let id = new_id(id_prefix::ORG);
    let row = sqlx::query_as::<_, OrganizationRow>(
        "INSERT INTO organizations (id, name, slug, has_image, max_allowed_memberships, \
         admin_delete_enabled, public_metadata, private_metadata, created_by, created_at, \
         updated_at) VALUES ($1,$2,$3,false,0,true,'{}','{}',$4,$5,$5) RETURNING *",
    )
    .bind(&id)
    .bind(name)
    .bind(&slug)
    .bind(creator_id)
    .bind(now_ms)
    .fetch_one(&state.pool)
    .await?;
    let role_key = creator_role_key(state).await?;
    crate::orgs::add_membership(state, &id, creator_id, &role_key, None, None).await?;
    Ok(row)
}

/// Adds an existing user to an organization with the given role.
pub async fn add_test_member(
    state: &AppState,
    org_id: &str,
    user_id: &str,
    role_key: &str,
) -> Result<()> {
    crate::orgs::add_membership(state, org_id, user_id, role_key, None, None).await?;
    Ok(())
}

/// Enables TOTP for a user and returns the shared secret (the
/// `enableTotp(client)` helper).
pub async fn enable_totp(state: &AppState, user_id: &str) -> Result<String> {
    let user = crate::users::require_user(state, user_id).await?;
    let setup = start_totp_setup(state, &user).await?;
    let code = orbitid_credentials::mfa::totp_code_at(&setup.secret, now() / 1000)
        .ok_or_else(|| OrbitError::internal("could not compute a TOTP code"))?;
    finish_totp_setup(state, &user, &code).await?;
    // Enrollment consumed this step. Real users sign in later; tests run in the
    // same second, so clear the marker to keep fixture-generated codes usable.
    sqlx::query("UPDATE users SET totp_last_used_step = NULL WHERE id = $1")
        .bind(user_id)
        .execute(&state.pool)
        .await?;
    Ok(setup.secret)
}

/// Enables instance trusted devices with the given lifetime.
pub async fn enable_trusted_devices(state: &AppState, days: i64) -> Result<()> {
    state
        .settings
        .update(serde_json::json!({
            "session": { "trustedDevicesEnabled": true, "trustedDeviceDays": days }
        }))
        .await
        .map(|_| ())
        .map_err(|error| OrbitError::internal(error.to_string()))
}

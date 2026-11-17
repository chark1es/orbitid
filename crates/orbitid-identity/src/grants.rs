//! OIDC grant revocation primitives owned by the session lifecycle, ported from
//! `services/oidc/revocation.ts` (the parts sessions call).
//!
//! Ending a session must end every OIDC grant it authorized. Revocation and
//! issuance of one rotation family are serialized with an advisory transaction
//! lock, so a refresh rotation can never insert a live token into a family that
//! was just revoked.

use orbitid_core::error::Result;
use orbitid_core::state::AppState;

/// Advisory lock key for a grant family (matches the TypeScript lock helper).
async fn lock_family(conn: &mut sqlx::PgConnection, family: &str) -> Result<()> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)")
        .bind(family)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Revokes access, refresh and code grants minted from one browser session.
pub async fn revoke_grants_for_session(state: &AppState, session_id: &str) -> Result<()> {
    if session_id.is_empty() {
        return Ok(());
    }
    let mut conn = state.pool.acquire().await?;
    revoke_grants_for_session_on(&mut conn, session_id).await
}

/// [`revoke_grants_for_session`] on a caller-supplied connection. Safe to call
/// inside a transaction: the advisory locks are transaction-scoped and no
/// second pool connection is acquired.
pub async fn revoke_grants_for_session_on(
    conn: &mut sqlx::PgConnection,
    session_id: &str,
) -> Result<()> {
    if session_id.is_empty() {
        return Ok(());
    }
    let families: Vec<Option<String>> = sqlx::query_scalar(
        "SELECT DISTINCT family_id FROM oauth_grants \
         WHERE session_id = $1 AND kind IN ('access', 'refresh', 'code')",
    )
    .bind(session_id)
    .fetch_all(&mut *conn)
    .await?;
    let mut families: Vec<String> = families.into_iter().flatten().collect();
    families.sort();
    families.dedup();
    for family in families {
        lock_family(conn, &family).await?;
    }
    sqlx::query(
        "UPDATE oauth_grants SET revoked = true \
         WHERE session_id = $1 AND kind IN ('access', 'refresh', 'code')",
    )
    .bind(session_id)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// [`revoke_grants_for_session_on`] for a bounded batch of sessions in one
/// write, used by the bulk sign-out path so ending N sessions is not N
/// statements.
pub async fn revoke_grants_for_sessions_on(
    conn: &mut sqlx::PgConnection,
    session_ids: &[String],
) -> Result<()> {
    if session_ids.is_empty() {
        return Ok(());
    }
    let families: Vec<Option<String>> = sqlx::query_scalar(
        "SELECT DISTINCT family_id FROM oauth_grants \
         WHERE session_id = ANY($1) AND kind IN ('access', 'refresh', 'code')",
    )
    .bind(session_ids)
    .fetch_all(&mut *conn)
    .await?;
    let mut families: Vec<String> = families.into_iter().flatten().collect();
    families.sort();
    families.dedup();
    for family in families {
        lock_family(conn, &family).await?;
    }
    sqlx::query(
        "UPDATE oauth_grants SET revoked = true \
         WHERE session_id = ANY($1) AND kind IN ('access', 'refresh', 'code')",
    )
    .bind(session_ids)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Revokes every grant a user holds, including device-flow grants with no
/// browser session. Used when a user is deleted or banned.
pub async fn revoke_grants_for_user(state: &AppState, user_id: &str) -> Result<()> {
    if user_id.is_empty() {
        return Ok(());
    }
    let mut tx = state.pool.begin().await?;
    revoke_grants_for_user_on(&mut tx, user_id).await?;
    tx.commit().await?;
    Ok(())
}

/// [`revoke_grants_for_user`] on a caller-owned transaction, so a ban or a
/// deletion commits with the revocation.
pub async fn revoke_grants_for_user_on(conn: &mut sqlx::PgConnection, user_id: &str) -> Result<()> {
    if user_id.is_empty() {
        return Ok(());
    }
    let families: Vec<Option<String>> = sqlx::query_scalar(
        "SELECT DISTINCT family_id FROM oauth_grants \
         WHERE user_id = $1 AND kind IN ('access', 'refresh', 'code')",
    )
    .bind(user_id)
    .fetch_all(&mut *conn)
    .await?;
    let mut families: Vec<String> = families.into_iter().flatten().collect();
    families.sort();
    families.dedup();
    for family in families {
        lock_family(conn, &family).await?;
    }
    sqlx::query(
        "UPDATE oauth_grants SET revoked = true \
         WHERE user_id = $1 AND kind IN ('access', 'refresh', 'code')",
    )
    .bind(user_id)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Revokes the grants of applications whose tokens can carry organization-
/// derived claims: an application with the `organizations` scope (whatever its
/// `groups_claim`, since `org_*`/`organizations` claims ignore it), or with the
/// `groups` scope and a `groups_claim` other than `none` (an empty value means
/// `all`).
///
/// Deliberately leaves the browser session signed in. This is the canonical
/// implementation shared by the org Backend API, the org Frontend API and the
/// OIDC provider, so a membership change revokes the same grants everywhere.
pub async fn revoke_organization_authority_grants(state: &AppState, user_id: &str) -> Result<()> {
    if user_id.is_empty() {
        return Ok(());
    }
    let mut tx = state.pool.begin().await?;
    // Precondition of the set-based revocation: the user row is held FOR UPDATE.
    crate::locks::lock_user_on(&mut tx, user_id).await?;
    revoke_organization_authority_grants_on(&mut tx, user_id).await?;
    tx.commit().await?;
    Ok(())
}

/// [`revoke_organization_authority_grants`] on a caller-owned transaction, for
/// membership changes that must commit with the revocation. The caller must
/// hold `user_id` `FOR UPDATE` (see the set-based function).
pub async fn revoke_organization_authority_grants_on(
    conn: &mut sqlx::PgConnection,
    user_id: &str,
) -> Result<()> {
    if user_id.is_empty() {
        return Ok(());
    }
    revoke_organization_authority_grants_for_users_on(conn, &[user_id.to_string()]).await
}

/// [`revoke_organization_authority_grants_on`] for many users at once: one read
/// of `oauth_applications` and one `UPDATE`, however many users there are
/// (organization deletion).
///
/// No per-family advisory locks are taken. **Precondition:** the caller holds
/// every `user_ids` row `FOR UPDATE` (rank 3) in its transaction. Every
/// `oauth_grants` inserter (code exchange, refresh rotation, device poll,
/// consent) takes the user's key-share lock first, which conflicts with that
/// lock, so no issuer can add a live row to these users' families until the
/// transaction ends; the `UPDATE` therefore sees every row it must revoke. One
/// lock per family would also exhaust the shared lock table for a large
/// organization. See `docs/LOCK_ORDER.md`.
pub async fn revoke_organization_authority_grants_for_users_on(
    conn: &mut sqlx::PgConnection,
    user_ids: &[String],
) -> Result<()> {
    if user_ids.is_empty() {
        return Ok(());
    }
    let applications = sqlx::query_as::<_, orbitid_core::models::OauthApplicationRow>(
        "SELECT * FROM oauth_applications",
    )
    .fetch_all(&mut *conn)
    .await?;
    let application_ids: Vec<String> = applications
        .into_iter()
        .filter(|application| {
            let mode = if application.groups_claim.is_empty() {
                "all"
            } else {
                application.groups_claim.as_str()
            };
            let scopes = || {
                application
                    .scopes
                    .split([' ', ',', '\t', '\n', '\r'])
                    .map(str::trim)
            };
            scopes().any(|scope| scope == "organizations")
                || (mode != "none" && scopes().any(|scope| scope == "groups"))
        })
        .map(|application| application.id)
        .collect();
    // A grant is revoked when its application currently exposes authority
    // claims OR the grant itself was issued with such a scope: an application
    // may have dropped `organizations`/`groups` (or switched `groups_claim` to
    // `none`) after issuing tokens that still carry the claims, and refresh
    // keeps using the grant's own stored scopes. Separators match
    // `parse_scopes`. Any `groups` scope revokes (over-revoking self-heals on
    // re-authentication).
    sqlx::query(
        "UPDATE oauth_grants SET revoked = true \
         WHERE user_id = ANY($1) AND kind IN ('access', 'refresh', 'code') \
         AND (application_id = ANY($2) \
              OR regexp_split_to_array(scopes, '[ ,\t\n\r]+') \
                 && ARRAY['organizations', 'groups']::text[])",
    )
    .bind(user_ids)
    .bind(&application_ids)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

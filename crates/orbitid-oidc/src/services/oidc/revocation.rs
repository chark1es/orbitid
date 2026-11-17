//! Revocation primitives for the OIDC provider, ported from
//! `services/oidc/revocation.ts`.
//!
//! Every family revocation and every scoped revocation takes the family
//! advisory locks before updating, so issuance and revocation of one family are
//! serialized: a refresh rotation either commits before the revocation's UPDATE
//! (whose fresh snapshot then includes the new rows) or waits until the
//! revocation is done and finds its token revoked.

use orbitid_core::error::Result;
use orbitid_core::state::AppState;

/// Advisory lock key for a grant family (matches the TypeScript lock helper).
pub(crate) async fn lock_family(conn: &mut sqlx::PgConnection, family: &str) -> Result<()> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)")
        .bind(family)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Revokes every token in a rotation family (refresh reuse detection / RFC 7009
/// on a refresh token).
pub async fn revoke_grant_family(state: &AppState, family: &str) -> Result<()> {
    if family.is_empty() {
        return Ok(());
    }
    let mut tx = state.pool.begin().await?;
    lock_family(&mut tx, family).await?;
    sqlx::query(
        "UPDATE oauth_grants SET revoked = true \
         WHERE kind IN ('access', 'refresh') AND family_id = $1",
    )
    .bind(family)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

/// Revokes the grants of applications whose tokens assert organization or group
/// authority. The transaction lives in `orbitid_identity::grants` so every
/// surface revokes the same grants; this re-export keeps the OIDC service API.
pub use orbitid_identity::grants::revoke_organization_authority_grants;

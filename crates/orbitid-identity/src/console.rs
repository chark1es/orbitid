//! First-run ownership of an instance.
//!
//! A fresh instance has no accounts. The first person to open the dashboard
//! creates the owner account there instead of pasting the secret key: the
//! account gets the seeded [`OWNER_ROLE_KEY`] role, whose
//! [`crate::rbac::DASHBOARD_ACCESS`] permission opens the admin console.
//!
//! Setup is offered only while the instance is unclaimed (no owner was ever
//! created, see `console_owner_setup`) and has no (non-guest) user at all.
//! Claiming is permanent: deleting every account later does not reopen setup.
//! An instance that existed before owners is claimed by its migration and
//! never offers it. Whoever runs the server grants the Owner
//! role to an existing account instead (`orbitid owner <email>`, see
//! [`grant_owner`]); shell access to the server is the proof of control. The
//! secret key never opens the dashboard.

use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::now;
use orbitid_core::models::UserRow;
use orbitid_core::state::AppState;
use orbitid_platform::webhooks::emit_event_on;

use crate::authorization::replace_user_roles;
use crate::locks::lock_user_on;
use crate::rbac::{DASHBOARD_ACCESS, OWNER_ROLE_KEY};
use crate::serializers::{serialize_user_on, UserSerializeOptions};
use crate::users::{
    after_user_created, create_user_on, emit_user_created_on, find_user_by_verified_email,
    get_user_by_id, CreateUserInput,
};

const SETUP_OPEN: &str = "SELECT NOT EXISTS (SELECT 1 FROM console_owner_setup) \
     AND NOT EXISTS (SELECT 1 FROM users WHERE NOT is_anonymous)";

/// Records that the instance is claimed. Never removed. Returns the row only
/// when this statement claimed it; a claim another transaction holds makes it
/// wait for that transaction, then return nothing if it committed.
const CLAIM: &str = "INSERT INTO console_owner_setup (id, claimed_at) VALUES ('default', $1) \
     ON CONFLICT (id) DO NOTHING RETURNING id";

/// True while the instance has no account yet, so the dashboard offers owner setup.
pub async fn setup_required(state: &AppState) -> Result<bool> {
    Ok(sqlx::query_scalar::<_, bool>(SETUP_OPEN)
        .fetch_one(&state.pool)
        .await?)
}

/// True when no account can open the console: nobody active holds a role that
/// grants [`DASHBOARD_ACCESS`]. The sign-in screen then explains how to grant
/// the Owner role from the server.
pub async fn console_unclaimed(state: &AppState) -> Result<bool> {
    Ok(sqlx::query_scalar::<_, bool>(
        "SELECT NOT EXISTS (SELECT 1 FROM user_roles ur \
         JOIN users u ON u.id = ur.user_id AND NOT u.banned \
         JOIN roles r ON r.key = ur.role_key AND r.key IN ('app:sys_owner', 'app:sys_admin') \
         JOIN role_permissions rp ON rp.role_id = r.id \
         JOIN permissions p ON p.id = rp.permission_id AND p.key = $1)",
    )
    .bind(DASHBOARD_ACCESS)
    .fetch_one(&state.pool)
    .await?)
}

/// The owner account typed into the dashboard's setup form.
#[derive(Clone)]
pub struct OwnerInput {
    pub email: String,
    /// Already hashed and checked against the password policy by the caller.
    pub password_hash: String,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
}

impl std::fmt::Debug for OwnerInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OwnerInput")
            .field("email", &self.email)
            .field("password_hash", &"<redacted>")
            .field("first_name", &self.first_name)
            .field("last_name", &self.last_name)
            .finish()
    }
}

/// Creates the owner account and assigns it the Owner role, atomically.
/// Returns `None` when the instance already has an account (somebody finished
/// setup first), in which case nothing was written.
///
/// Concurrent setups serialize on a dedicated advisory lock taken first in its
/// own transaction. No other transaction takes it, so it cannot join a lock
/// cycle; after it the transaction follows the global order (user rows, then
/// `user_roles`).
pub async fn create_owner(state: &AppState, input: &OwnerInput) -> Result<Option<UserRow>> {
    let mut tx = state.pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext('orbitid_owner_setup')::bigint)")
        .execute(&mut *tx)
        .await?;
    let available: bool = sqlx::query_scalar(SETUP_OPEN).fetch_one(&mut *tx).await?;
    // Winning the claim is what makes this the owner: a sign-up that created the
    // first account meanwhile claimed it first (its `users` trigger), and the
    // insert then finds the row and returns nothing.
    let claimed: Option<String> = if available {
        sqlx::query_scalar(CLAIM)
            .bind(now())
            .fetch_optional(&mut *tx)
            .await?
    } else {
        None
    };
    if claimed.is_none() {
        // Release the advisory lock now rather than when the connection is
        // recycled (docs/LOCK_ORDER.md, explicit rollback).
        tx.rollback().await?;
        return Ok(None);
    }
    let create = CreateUserInput {
        email: Some(input.email.clone()),
        first_name: input.first_name.clone(),
        last_name: input.last_name.clone(),
        password_hash: Some(input.password_hash.clone()),
        // The owner typed this address while setting up their own instance,
        // which may not be able to send mail yet. Treat it like an address an
        // operator adds through the Backend API.
        email_verified: true,
        ..Default::default()
    };
    let user = create_user_on(state, &mut tx, &create).await?;
    emit_user_created_on(&mut tx, state, &user, &create).await?;
    lock_user_on(&mut tx, &user.id).await?;
    replace_user_roles(&mut tx, &user.id, &[OWNER_ROLE_KEY.to_string()], now()).await?;
    tx.commit().await?;
    after_user_created(state, &user, &create).await?;
    Ok(Some(user))
}

/// What [`grant_owner`] did.
#[derive(Debug, Clone)]
pub enum OwnerGrant {
    Granted(UserRow),
    /// The account already held the Owner role; nothing changed.
    AlreadyOwner(UserRow),
}

/// Adds the Owner role to an existing account, keeping its other roles. The
/// account is named by user id or by a *verified* email address, so an
/// unverified address someone else added cannot be promoted.
///
/// This is the server-side way in for an instance whose accounts predate
/// owners, or whose owners lost access (`orbitid owner <email>`). It runs with
/// the server's own configuration, never over HTTP.
pub async fn grant_owner(state: &AppState, account: &str) -> Result<OwnerGrant> {
    let account = account.trim();
    let found = if account.starts_with("user_") {
        get_user_by_id(state, account).await?
    } else {
        find_user_by_verified_email(state, account).await?
    };
    let Some(user) = found else {
        return Err(OrbitError::not_found(
            error_codes::RESOURCE_NOT_FOUND,
            format!("No account has the user id or verified email address {account}."),
        ));
    };
    // The claim first, like owner setup (claim, then user, then `user_roles`):
    // granting an owner claims the instance, so setup can never reopen.
    let mut tx = state.pool.begin().await?;
    sqlx::query(CLAIM)
        .bind(now())
        .fetch_optional(&mut *tx)
        .await?;
    // Rank 3 (user row) before rank 10 (`user_roles`), like every role change.
    lock_user_on(&mut tx, &user.id).await?;
    // Read under the lock, so a ban that lands meanwhile is honoured.
    let banned: bool = sqlx::query_scalar("SELECT banned FROM users WHERE id = $1")
        .bind(&user.id)
        .fetch_one(&mut *tx)
        .await?;
    if banned {
        tx.rollback().await?;
        return Err(OrbitError::unprocessable(
            error_codes::USER_BANNED,
            format!(
                "{} is banned. Lift the ban before making it an owner.",
                user.id
            ),
        ));
    }
    let mut roles: Vec<String> =
        sqlx::query_scalar("SELECT role_key FROM user_roles WHERE user_id = $1 ORDER BY role_key")
            .bind(&user.id)
            .fetch_all(&mut *tx)
            .await?;
    if roles.iter().any(|role| role == OWNER_ROLE_KEY) {
        tx.rollback().await?;
        return Ok(OwnerGrant::AlreadyOwner(user));
    }
    roles.push(OWNER_ROLE_KEY.to_string());
    replace_user_roles(&mut tx, &user.id, &roles, now()).await?;
    let json = serialize_user_on(
        &mut tx,
        state,
        &user,
        UserSerializeOptions { backend: true },
    )
    .await?;
    emit_event_on(
        &mut tx,
        "user.updated",
        serde_json::to_value(json).unwrap_or_default(),
    )
    .await?;
    tx.commit().await?;
    Ok(OwnerGrant::Granted(user))
}

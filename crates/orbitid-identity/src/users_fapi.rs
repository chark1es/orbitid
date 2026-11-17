//! Transactional identification guards used by the Frontend API crates.
//!
//! [`crate::users::guards`] has the canonical helpers; these join a caller's
//! transaction so a "last identification" decision and the delete that follows
//! it are serialized by the same user-row lock.

use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::models::EmailAddressRow;

use crate::users::guards::{count_identifications_on, lock_user_identifications};

/// Refuses to remove the last way a user can be identified (email, phone,
/// external account or non-pending passkey). Locks the user row first so two
/// concurrent deletes of the last two identifications cannot both pass.
pub async fn assert_not_last_identification_on(
    conn: &mut sqlx::PgConnection,
    user_id: &str,
) -> Result<()> {
    lock_user_identifications(conn, user_id).await?;
    if count_identifications_on(conn, user_id).await? <= 1 {
        return Err(OrbitError::unprocessable(
            error_codes::LAST_IDENTIFICATION_CANNOT_BE_REMOVED,
            "You cannot remove your last identification",
        ));
    }
    Ok(())
}

/// [`crate::users::list_emails`] on a caller's connection, for a flow that
/// must not acquire another pool connection while its transaction is open.
pub async fn list_emails_on(
    conn: &mut sqlx::PgConnection,
    user_id: &str,
) -> Result<Vec<EmailAddressRow>> {
    Ok(
        sqlx::query_as::<_, EmailAddressRow>("SELECT * FROM email_addresses WHERE user_id = $1")
            .bind(user_id)
            .fetch_all(&mut *conn)
            .await?,
    )
}

//! Canonical uploaded-image storage in the `uploads` table.
//!
//! The TypeScript server wrote avatars to `<dataDir>/uploads` and organization
//! logos to `<dataDir>/uploads/orgs`. That is single-replica state; the public
//! URLs are unchanged but the bytes live in Postgres (migration
//! `0004_uploads.sql`) so any replica can serve them.
//!
//! Every mutation that orphans an upload deletes its row in the *same*
//! transaction as the pointer change. The helpers here take a caller-owned
//! connection for exactly that reason; the pool wrappers are only for tools.

use orbitid_core::error::{OrbitError, Result};
use orbitid_core::http::now;
use orbitid_core::state::AppState;

/// Profile avatars (`/v1/client/images/:file`).
pub const AVATAR_BUCKET: &str = "avatar";
/// Organization logos (`/v1/client/organization_logos/:file`).
pub const LOGO_BUCKET: &str = "org_logo";
/// Marker between the public base URL and an avatar file name.
pub const AVATAR_MARKER: &str = "/v1/client/images/";
/// Marker between the public base URL and a logo file name.
pub const LOGO_MARKER: &str = "/v1/client/organization_logos/";

/// A stored upload.
pub struct StoredUpload {
    pub content_type: String,
    pub bytes: Vec<u8>,
}

/// Inserts or replaces one uploaded file.
///
/// A `file` name is globally unique (its public URL has no bucket in it), so a
/// name that already exists in a **different** bucket is a conflict, never an
/// overwrite: replacing another owner's avatar with a logo (or vice versa)
/// would silently change the bytes a stored URL serves.
pub async fn store_upload_on(
    conn: &mut sqlx::PgConnection,
    bucket: &str,
    owner_id: &str,
    file: &str,
    content_type: &str,
    bytes: &[u8],
) -> Result<()> {
    let stored: Option<String> = sqlx::query_scalar(
        "INSERT INTO uploads (file, bucket, owner_id, content_type, bytes, created_at) \
         VALUES ($1, $2, $3, $4, $5, $6) \
         ON CONFLICT (file) DO UPDATE SET owner_id = EXCLUDED.owner_id, \
         content_type = EXCLUDED.content_type, bytes = EXCLUDED.bytes \
         WHERE uploads.bucket = EXCLUDED.bucket \
         RETURNING file",
    )
    .bind(file)
    .bind(bucket)
    .bind(owner_id)
    .bind(content_type)
    .bind(bytes)
    .bind(now())
    .fetch_optional(&mut *conn)
    .await?;
    if stored.is_none() {
        return Err(OrbitError::conflict(
            orbitid_core::error::error_codes::DUPLICATE_RECORD,
            "That file name is already used in another upload bucket",
        ));
    }
    Ok(())
}

/// Reads one uploaded file, if it exists in that bucket.
pub async fn read_upload(
    state: &AppState,
    bucket: &str,
    file: &str,
) -> Result<Option<StoredUpload>> {
    let row: Option<(String, Vec<u8>)> =
        sqlx::query_as("SELECT content_type, bytes FROM uploads WHERE bucket = $1 AND file = $2")
            .bind(bucket)
            .bind(file)
            .fetch_optional(&state.pool)
            .await?;
    Ok(row.map(|(content_type, bytes)| StoredUpload {
        content_type,
        bytes,
    }))
}

/// Deletes one uploaded file on the caller's connection (missing rows are
/// ignored).
pub async fn delete_upload_on(
    conn: &mut sqlx::PgConnection,
    bucket: &str,
    file: &str,
) -> Result<()> {
    sqlx::query("DELETE FROM uploads WHERE bucket = $1 AND file = $2")
        .bind(bucket)
        .bind(file)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Deletes every upload a user or organization owns in that bucket.
///
/// `owner_id` is written by the upload routes, so this also catches rows whose
/// pointer was overwritten before the caller derived the old file name. Rows
/// are locked in ascending `file` order (rank 12) before the delete so two
/// deletions that share a row cannot acquire it in opposite orders.
pub async fn delete_uploads_for_owner_on(
    conn: &mut sqlx::PgConnection,
    bucket: &str,
    owner_id: &str,
) -> Result<u64> {
    let deleted = sqlx::query(
        "WITH candidates AS (SELECT file FROM uploads WHERE bucket = $1 AND owner_id = $2 \
         ORDER BY file FOR UPDATE) \
         DELETE FROM uploads u USING candidates c WHERE u.file = c.file",
    )
    .bind(bucket)
    .bind(owner_id)
    .execute(&mut *conn)
    .await?;
    Ok(deleted.rows_affected())
}

/// The file name a stored public URL points at, resolved exactly like the
/// serving routes: one safe final path segment after `marker`.
pub fn file_from_url<'a>(image_url: Option<&'a str>, marker: &str) -> Option<&'a str> {
    let image_url = image_url?;
    let file = image_url.split_once(marker)?.1;
    if !is_safe_file_name(file) {
        return None;
    }
    Some(file)
}

/// Deletes the upload a stored pointer references on the caller's connection.
pub async fn delete_upload_by_url_on(
    conn: &mut sqlx::PgConnection,
    bucket: &str,
    marker: &str,
    image_url: Option<&str>,
) -> Result<()> {
    let Some(file) = file_from_url(image_url, marker) else {
        return Ok(());
    };
    delete_upload_on(conn, bucket, file).await
}

/// Deletes a logo and every row the organization owns in the logo bucket.
pub async fn delete_logo_for_org_on(
    conn: &mut sqlx::PgConnection,
    org_id: &str,
    image_url: Option<&str>,
) -> Result<()> {
    delete_upload_by_url_on(conn, LOGO_BUCKET, LOGO_MARKER, image_url).await?;
    delete_uploads_for_owner_on(conn, LOGO_BUCKET, org_id).await?;
    Ok(())
}

/// Server-chosen names only: `[A-Za-z0-9._-]+`, never a path.
pub fn is_safe_file_name(file: &str) -> bool {
    !file.is_empty()
        && !file.contains("..")
        && file
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '-'))
}

/// Content type for a stored avatar file name (`/v1/client/images/:file`).
pub fn avatar_content_type(file: &str) -> Option<&'static str> {
    match file
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

/// Content type for a logo file name (`logoContentType`).
pub fn logo_content_type(file: &str) -> &'static str {
    match file
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_resolve_to_one_safe_segment() {
        assert_eq!(
            file_from_url(
                Some("http://localhost:4000/v1/client/images/usr_1_ab.png"),
                AVATAR_MARKER
            ),
            Some("usr_1_ab.png")
        );
        assert_eq!(
            file_from_url(
                Some("http://localhost:4000/v1/client/organization_logos/org_1.png"),
                LOGO_MARKER
            ),
            Some("org_1.png")
        );
        assert_eq!(
            file_from_url(
                Some("http://localhost:4000/v1/client/images/../x"),
                AVATAR_MARKER
            ),
            None
        );
        assert_eq!(
            file_from_url(Some("http://localhost:4000/elsewhere/x.png"), AVATAR_MARKER),
            None
        );
    }
}

//! `orbitid import-uploads --from <legacy data dir>`.
//!
//! The TypeScript server wrote avatars to `<dataDir>/uploads/<file>` and
//! organization logos to `<dataDir>/uploads/orgs/<file>`. The Rust server
//! serves the same public URLs from the `uploads` table, so importing the old
//! files under the *same* name and bucket keeps every stored `image_url` /
//! `logo_url` resolving after an upgrade.

use std::path::{Path, PathBuf};

use orbitid_core::error::{OrbitError, Result};
use orbitid_core::http::MAX_UPLOAD_BYTES;
use orbitid_core::state::AppState;
use orbitid_identity::uploads::{
    is_safe_file_name, read_upload, store_upload_on, AVATAR_BUCKET, LOGO_BUCKET,
};
use orbitid_platform::images::assert_image_bytes;

/// Counts from one import run.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ImportSummary {
    /// Files inserted into the `uploads` table.
    pub imported: u64,
    /// Files skipped because they were already present, were not safe file
    /// names, were symlinks, or were not a supported raster image.
    pub skipped: u64,
}

/// Imports `<from>/uploads` and `<from>/uploads/orgs` into the database.
///
/// Idempotent: a row that already exists under the same file and bucket is
/// skipped, so running it twice imports nothing the second time. Directory
/// entries that are symlinks are never followed.
pub async fn import_legacy_uploads(state: &AppState, from: &Path) -> Result<ImportSummary> {
    let root = from.join("uploads");
    // `is_dir` follows a symlink; the legacy root must be a real directory.
    if !std::fs::symlink_metadata(&root)
        .map(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err(OrbitError::unprocessable(
            orbitid_core::error::error_codes::FORM_PARAM_VALUE_INVALID,
            format!("{} does not contain an uploads directory", from.display()),
        ));
    }
    let mut summary = ImportSummary::default();
    import_directory(state, &root, AVATAR_BUCKET, &mut summary).await?;
    import_directory(state, &root.join("orgs"), LOGO_BUCKET, &mut summary).await?;
    Ok(summary)
}

async fn import_directory(
    state: &AppState,
    directory: &Path,
    bucket: &str,
    summary: &mut ImportSummary,
) -> Result<()> {
    // `symlink_metadata` never follows the link; a symlinked `uploads/orgs`
    // directory is not imported at all.
    let is_real_dir = std::fs::symlink_metadata(directory)
        .map(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
        .unwrap_or(false);
    if !is_real_dir {
        return Ok(());
    }
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(_) => return Ok(()),
    };
    // Collect first and sort, so output and tests are deterministic.
    let mut files: Vec<PathBuf> = Vec::new();
    for entry in entries.flatten() {
        // `symlink_metadata` never follows the link; a symlinked file or
        // directory is ignored, so an import cannot escape the legacy tree.
        let Ok(metadata) = std::fs::symlink_metadata(entry.path()) else {
            summary.skipped += 1;
            continue;
        };
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            if metadata.is_dir() && !metadata.file_type().is_symlink() {
                // A stray subdirectory is not a legacy upload file.
                continue;
            }
            summary.skipped += 1;
            continue;
        }
        files.push(entry.path());
    }
    files.sort();

    for path in files {
        let Some(file) = path.file_name().and_then(|name| name.to_str()) else {
            summary.skipped += 1;
            continue;
        };
        if !is_safe_file_name(file) {
            summary.skipped += 1;
            continue;
        }
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(_) => {
                summary.skipped += 1;
                continue;
            }
        };
        if bytes.len() > MAX_UPLOAD_BYTES {
            summary.skipped += 1;
            continue;
        }
        let Ok(kind) = assert_image_bytes(&bytes, "file") else {
            summary.skipped += 1;
            continue;
        };
        if read_upload(state, bucket, file).await?.is_some() {
            summary.skipped += 1;
            continue;
        }
        // Prefer the owner the database itself points at: a legacy avatar whose
        // file name does not contain the owner id still gets the right
        // `owner_id`, so deleting the user removes it.
        let owner_id = match resolve_pointer_owner(state, bucket, file).await? {
            Some(owner) => owner,
            None => owner_from_file_name(file).unwrap_or("").to_string(),
        };
        let mut conn = state.pool.acquire().await?;
        store_upload_on(
            &mut conn,
            bucket,
            &owner_id,
            file,
            kind.content_type(),
            &bytes,
        )
        .await?;
        summary.imported += 1;
    }
    Ok(())
}

/// The user or organization whose stored pointer references `file`, if any.
///
/// Uses the generated `image_file` column (migration 0009), so the lookup is a
/// single index scan instead of parsing every pointer.
async fn resolve_pointer_owner(
    state: &AppState,
    bucket: &str,
    file: &str,
) -> Result<Option<String>> {
    let query = if bucket == AVATAR_BUCKET {
        "SELECT id FROM users WHERE image_file = $1 LIMIT 1"
    } else {
        "SELECT id FROM organizations WHERE image_file = $1 LIMIT 1"
    };
    Ok(sqlx::query_scalar(query)
        .bind(file)
        .fetch_optional(&state.pool)
        .await?)
}

/// The TypeScript name is `<owner id>_<24 hex>.<ext>`; the owner id itself may
/// contain underscores, so split at the last one.
fn owner_from_file_name(file: &str) -> Option<&str> {
    let stem = file.rsplit_once('.').map(|(stem, _)| stem).unwrap_or(file);
    stem.rsplit_once('_')
        .map(|(owner, _)| owner)
        .filter(|owner| !owner.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_the_owner_from_the_legacy_name() {
        assert_eq!(
            owner_from_file_name("usr_abc_def_0123456789abcdef01234567.png"),
            Some("usr_abc_def")
        );
        assert_eq!(owner_from_file_name("plain.png"), None);
    }
}

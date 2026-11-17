//! Enterprise-connection domain claims.
//!
//! `enterprise_connections.domains` is a JSON array, so the uniqueness rule
//! (a domain belongs to at most one connection, subdomains included) cannot be
//! enforced by a constraint. Every create/update therefore takes the
//! `orbitid_enterprise_domains` advisory lock in its transaction and re-reads
//! the rows on that connection before inserting or updating.

use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::models::EnterpriseConnectionRow;
use orbitid_federation::saml::normalize_domains;

/// Refuses a domain already claimed by another connection. The caller must hold
/// [`orbitid_identity::lookups_bapi::lock_enterprise_domains_on`] in the same
/// transaction, so two replicas cannot both pass the check.
pub(super) async fn assert_domains_unclaimed_on(
    conn: &mut sqlx::PgConnection,
    domains: &[String],
    allow_subdomains: bool,
    except_id: Option<&str>,
) -> Result<()> {
    let rows = orbitid_identity::lookups_bapi::enterprise_connections_on(conn).await?;
    check_claims(&rows, domains, allow_subdomains, except_id)
}

fn check_claims(
    rows: &[EnterpriseConnectionRow],
    domains: &[String],
    allow_subdomains: bool,
    except_id: Option<&str>,
) -> Result<()> {
    if domains.is_empty() {
        return Ok(());
    }
    let under =
        |child: &str, parent: &str| child == parent || child.ends_with(&format!(".{parent}"));
    for domain in domains {
        for other in rows.iter().filter(|row| Some(row.id.as_str()) != except_id) {
            for taken in normalize_domains(&other.domains.0) {
                let clash = *domain == taken
                    || (other.allow_subdomains && under(domain, &taken))
                    || (allow_subdomains && under(&taken, domain));
                if clash {
                    return Err(OrbitError::conflict(
                        error_codes::DUPLICATE_RECORD,
                        format!("The domain {domain} already belongs to another connection"),
                    )
                    .with_meta(serde_json::json!({ "param_name": "domains" })));
                }
            }
        }
    }
    Ok(())
}

//! L2 identity domain: users, sessions, client cookies/auth, trusted devices,
//! organizations, RBAC, domains and the resource serializers.
//!
//! The four HTTP crates (frontend auth/account, Backend API, OIDC provider) are
//! built on this crate. Everything here is transport-agnostic: functions take
//! `&AppState` plus plain values (headers, ids, options) and return rows or wire
//! resources. Cookie helpers return `Set-Cookie` header values instead of
//! writing a response, so an axum handler can attach them.
//!
//! Ported from the retired TypeScript server, `services/*` and the
//! domain-level half of `modules/{auth,orgs,machine,admin}`.

pub mod admin;
pub mod anonymous;
pub mod api_keys;
pub mod app_access;
pub mod authorization;
pub mod billing;
pub mod caller;
pub mod client_auth;
pub mod code_check;
pub mod console;
pub mod enterprise_access;
pub mod external_identity;
pub mod grants;
pub mod install;
pub mod locks;
pub mod lookups_bapi;
pub mod machine_auth;
pub mod operator_session;
pub mod org_domains;
pub mod org_serializers;
pub mod org_shared;
pub mod orgs;
pub mod rbac;
pub mod restrictions;
pub mod retention;
pub mod serializers;
pub mod sessions;
pub mod sessions_fapi;
pub mod tokens;
pub mod trusted_devices;
pub mod trusted_devices_fapi;
pub mod uploads;
pub mod user_roles;
pub mod users;
pub mod users_fapi;
pub mod verification_links;
pub mod verifications;
pub mod verifications_fapi;
pub mod worker_cursor;

#[cfg(feature = "test-util")]
pub mod testing;

pub use install::{install, install_without_workers, InstallHandles};

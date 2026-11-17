//! Organization Backend API (`/v1/organizations/*`, `/v1/roles`, `/v1/permissions`).

mod assets;
mod domains;
mod invitations;
mod memberships;
mod organization_logo;
mod organizations;
mod requests;
mod roles;
mod shared;

use axum::Router;
use orbitid_core::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .merge(organizations::router())
        .merge(memberships::router())
        .merge(invitations::router())
        .merge(domains::router())
        .merge(requests::router())
        .merge(roles::router())
}

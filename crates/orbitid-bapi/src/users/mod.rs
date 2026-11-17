//! Backend API user routes (`/v1/users/*`), grouped like the TS
//! `modules/admin/users/*` files.

mod create;
mod filter;
mod images;
mod list;
mod moderation;
mod roles;
mod update;

use axum::Router;
use orbitid_core::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .merge(list::routes())
        .merge(create::routes())
        .merge(update::routes())
        .merge(moderation::routes())
        .merge(images::routes())
        .merge(roles::routes())
}

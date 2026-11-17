use axum::routing::get;
use axum::Router;
use orbitid_core::state::AppState;

use super::permissions::{
    create_permission, list_permissions, read_permission, remove_permission, remove_permission_row,
    set_permissions, update_permission,
};
use super::role::{create, list, read, remove, update};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/roles", get(list).post(create))
        .route("/v1/roles/{id}", get(read).patch(update).delete(remove))
        .route(
            "/v1/roles/{id}/permissions",
            axum::routing::post(set_permissions),
        )
        .route(
            "/v1/roles/{id}/permissions/{permission_id}",
            axum::routing::delete(remove_permission),
        )
        .route(
            "/v1/permissions",
            get(list_permissions).post(create_permission),
        )
        .route(
            "/v1/permissions/{id}",
            get(read_permission)
                .patch(update_permission)
                .delete(remove_permission_row),
        )
}

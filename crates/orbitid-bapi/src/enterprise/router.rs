use axum::routing::get;
use axum::Router;
use orbitid_core::state::AppState;

use super::read::*;
use super::write::*;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/enterprise_connections", get(list).post(create))
        .route(
            "/v1/enterprise_connections/{id}",
            get(read).patch(update).delete(remove),
        )
}

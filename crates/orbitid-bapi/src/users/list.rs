//! User count and list routes.

use axum::extract::State;
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use orbitid_core::error::Result;
use orbitid_core::models::UserRow;
use orbitid_core::state::AppState;
use orbitid_identity::serializers::{serialize_users, UserSerializeOptions};
use serde_json::json;

use super::filter::{user_where, USER_ORDER_COLUMNS};
use crate::shared::{
    fetch_all, fetch_count, json_response, order_clause, paginated, to_value, total_header, Bind,
    QueryPairs,
};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/v1/users/count", get(count))
        .route("/v1/users", get(list))
}

async fn count(State(state): State<AppState>, query: QueryPairs) -> Result<Response> {
    let filter = user_where(&state, &query).await?;
    let sql = format!("SELECT count(*) FROM users u{}", filter.sql());
    let total = fetch_count(&state.pool, &sql, &filter.binds).await?;
    Ok(json_response(
        json!({ "object": "total_count", "total_count": total }),
    ))
}

async fn list(State(state): State<AppState>, query: QueryPairs) -> Result<Response> {
    let filter = user_where(&state, &query).await?;
    let list = query.list()?;
    let order = order_clause(list.order_by.as_deref(), USER_ORDER_COLUMNS, "-created_at");
    let mut binds = filter.binds.clone();
    binds.push(Bind::Int(list.limit));
    let limit_slot = binds.len();
    binds.push(Bind::Int(list.offset));
    let offset_slot = binds.len();
    let sql = format!(
        "SELECT u.* FROM users u{} ORDER BY {order} LIMIT ${limit_slot} OFFSET ${offset_slot}",
        filter.sql()
    );
    let rows: Vec<UserRow> = fetch_all(&state.pool, &sql, &binds).await?;
    let total = fetch_count(
        &state.pool,
        &format!("SELECT count(*) FROM users u{}", filter.sql()),
        &filter.binds,
    )
    .await?;
    let data = serialize_users(&state, &rows, UserSerializeOptions { backend: true }).await?;
    let data = to_value(data)?;
    if query.raw("paginated") == Some("true") {
        return Ok(json_response(paginated(data, total)));
    }
    let (name, value) = total_header(total);
    let mut response = json_response(data);
    response.headers_mut().insert(name, value);
    Ok(response)
}

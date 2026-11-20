//! User deletion, bans, locks, verification refusals.

use axum::extract::{Path, State};
use axum::response::Response;
use axum::routing::{delete, post};
use axum::Router;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::state::AppState;
use orbitid_identity::admin::refuse_user_credential_mutation;
use orbitid_identity::serializers::{serialize_user, UserSerializeOptions};
use orbitid_identity::users::delete_user_on;
use orbitid_identity::users::moderation::{moderate_user_on, ModerationAction};
use orbitid_platform::audit::{audit, AuditInput};

use crate::shared::{deleted_object, json_response, to_value};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/v1/users/{id}", delete(remove))
        .route("/v1/users/{id}/ban", post(ban))
        .route("/v1/users/{id}/unban", post(unban))
        .route("/v1/users/{id}/lock", post(lock))
        .route("/v1/users/{id}/unlock", post(unlock))
        .route(
            "/v1/users/{id}/verify_password",
            post(refuse_verify_password),
        )
        .route("/v1/users/{id}/verify_totp", post(refuse_verify_totp))
        .route("/v1/users/{id}/mfa", delete(refuse_mfa))
        .route("/v1/users/{id}/password", delete(refuse_password))
        .route(
            "/v1/users/{id}/oauth_access_tokens/{provider}",
            axum::routing::get(refuse_oauth_token),
        )
}

async fn remove(State(state): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    // Deletion, the organization lifecycle it triggers, every event row and the
    // avatar/logo upload rows are one transaction. Only the audit entry
    // (best-effort) runs outside it.
    let real = orbitid_identity::users::get_user_by_id(&state, &id)
        .await?
        .is_some_and(|user| !user.is_anonymous);
    let mut tx = state.pool.begin().await?;
    if real {
        // First, before any row lock: deleting a real account claims the
        // instance in the same transaction, so owner setup can never reopen.
        orbitid_identity::console::claim_on(&mut tx).await?;
    }
    let deleted = delete_user_on(&mut tx, &state, &id).await?;
    tx.commit().await?;
    let Some(user) = deleted else {
        return Err(OrbitError::not_found(
            error_codes::RESOURCE_NOT_FOUND,
            "User not found",
        ));
    };
    audit(
        &state,
        AuditInput::new("user.deleted")
            .actor(orbitid_identity::admin::AUDIT_ACTOR)
            .target_type("user")
            .target_id(user.id.clone()),
    )
    .await;
    Ok(json_response(deleted_object("user", &user.id)))
}

async fn ban(State(state): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    moderate(state, id, ModerationAction::Ban).await
}

async fn unban(State(state): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    moderate(state, id, ModerationAction::Unban).await
}

async fn lock(State(state): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    moderate(state, id, ModerationAction::Lock).await
}

async fn unlock(State(state): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    moderate(state, id, ModerationAction::Unlock).await
}

/// One moderation action: the user row, the credential revocations it implies
/// and the `user.updated` event commit together.
async fn moderate(state: AppState, id: String, action: ModerationAction) -> Result<Response> {
    let mut tx = state.pool.begin().await?;
    let user = moderate_user_on(&mut tx, &state, &id, action).await?;
    tx.commit().await?;
    let value =
        to_value(serialize_user(&state, &user, UserSerializeOptions { backend: true }).await?)?;
    audit(
        &state,
        AuditInput::new(action.audit_action())
            .actor(orbitid_identity::admin::AUDIT_ACTOR)
            .target_type("user")
            .target_id(user.id.clone()),
    )
    .await;
    Ok(json_response(value))
}

async fn refuse_verify_password(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Response> {
    crate::shared::get_user_or_throw(&state, &id).await?;
    Err(refuse_user_credential_mutation(
        "verify a user's password outside sign-in",
        "the sign-in flow, which counts failures and locks the account",
    ))
}

async fn refuse_verify_totp(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Response> {
    crate::shared::get_user_or_throw(&state, &id).await?;
    Err(refuse_user_credential_mutation(
        "verify a user's authenticator code outside sign-in",
        "the sign-in flow, which counts failures and locks the account",
    ))
}

async fn refuse_mfa(State(state): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    crate::shared::get_user_or_throw(&state, &id).await?;
    Err(refuse_user_credential_mutation(
        "reset the user's second factor",
        "DELETE /totp and DELETE /phone_numbers/:id from their signed-in session",
    ))
}

async fn refuse_password(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Response> {
    crate::shared::get_user_or_throw(&state, &id).await?;
    Err(refuse_user_credential_mutation(
        "remove the user's password",
        "POST /remove_password from their signed-in session",
    ))
}

async fn refuse_oauth_token(
    State(state): State<AppState>,
    Path((id, _provider)): Path<(String, String)>,
) -> Result<Response> {
    crate::shared::get_user_or_throw(&state, &id).await?;
    Err(refuse_user_credential_mutation(
        "read a user's linked third-party access token",
        "GET /me/external_accounts/:id/access_token from their signed-in session",
    ))
}

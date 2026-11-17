//! L3 HTTP surface for the signed-in user (`/v1/client/me/*`), the organization
//! Frontend API (`/v1/client/organizations/*`, memberships, invitations,
//! domains, requests), the public invitation-acceptance link, waitlist
//! collection and uploaded-image serving.
//!
//! Ported from `modules/me.ts`, `modules/org-client.ts`, `modules/waitlist-client.ts`
//! and the image-serving half of `modules/client.ts`. The global middleware
//! (security headers, CSRF, CORS, body limit, error mapping) is applied by
//! `orbitid-server`, so [`router`] only routes.

use axum::Router;
use orbitid_core::AppState;

pub mod images;
pub mod me;
pub mod orgs;
pub mod uploads;
pub mod util;
pub mod waitlist;

mod reply;

pub use me::{resolve_me_auth, CachedMeAuth};
pub use reply::{json_reply, json_reply_with_status};

/// Routes for this surface, mounted by `orbitid-server` at their absolute paths.
pub fn router() -> Router<AppState> {
    me::router()
        .merge(orgs::router())
        .merge(images::router())
        .merge(waitlist::router())
}

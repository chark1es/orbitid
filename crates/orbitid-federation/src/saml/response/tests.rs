use chrono::{Duration, Utc};
use samael::schema::Assertion;

use super::{audience_ok, timestamps_ok};

#[test]
fn audience_restrictions_must_all_name_the_sp() {
    use samael::schema::{AudienceRestriction, Conditions};
    let mut assertion = Assertion {
        id: "_a".into(),
        issue_instant: Utc::now(),
        version: "2.0".into(),
        issuer: samael::schema::Issuer {
            value: Some("https://idp".into()),
            ..samael::schema::Issuer::default()
        },
        signature: None,
        subject: None,
        conditions: Some(Conditions {
            not_before: None,
            not_on_or_after: None,
            audience_restrictions: Some(vec![AudienceRestriction {
                audience: vec!["https://sp".into()],
            }]),
            one_time_use: None,
            proxy_restriction: None,
        }),
        authn_statements: None,
        attribute_statements: None,
    };
    assert!(audience_ok(&assertion, "https://sp"));
    assert!(!audience_ok(&assertion, "https://other"));
    assertion.conditions = None;
    assert!(!audience_ok(&assertion, "https://sp"));
}

#[test]
fn timestamps_allow_five_seconds_of_skew() {
    let at = Utc::now();
    let limit = at + Duration::hours(1);
    let max = at + Duration::hours(2);
    assert!(timestamps_ok(None, limit, max, at));
    assert!(!timestamps_ok(None, at - Duration::seconds(10), max, at));
    assert!(timestamps_ok(None, at - Duration::seconds(2), max, at));
    assert!(!timestamps_ok(
        Some(at + Duration::seconds(30)),
        limit,
        max,
        at
    ));
}

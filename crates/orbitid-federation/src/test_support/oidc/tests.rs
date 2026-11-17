use super::*;

#[tokio::test]
async fn serves_discovery_jwks_and_the_full_flow() {
    let server = start_oidc_server(OidcServerOptions::default())
        .await
        .expect("server");
    let discovery_text = reqwest::get(format!(
        "{}/.well-known/openid-configuration",
        server.base_url
    ))
    .await
    .expect("discovery request")
    .text()
    .await
    .expect("discovery body");
    let discovery: Value = serde_json::from_str(&discovery_text).expect("discovery json");
    assert_eq!(discovery["issuer"], server.issuer);

    let jwks_text = reqwest::get(format!("{}/jwks", server.base_url))
        .await
        .expect("jwks request")
        .text()
        .await
        .expect("jwks body");
    let jwks: Value = serde_json::from_str(&jwks_text).expect("jwks json");
    assert_eq!(jwks["keys"][0]["kid"], server.kid);

    // Authorization redirects with a code and state.
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("client");
    let response = client
            .get(format!(
                "{}/authorize?client_id={}&redirect_uri=http://localhost/cb&response_type=code&state=s1",
                server.base_url, server.client_id
            ))
            .send()
            .await
            .expect("authorize");
    assert_eq!(response.status().as_u16(), 302);
    let location = response.headers()["location"]
        .to_str()
        .expect("location")
        .to_string();
    assert!(location.contains("code=test-code"));
    assert!(location.contains("state=s1"));

    server.close().await;
}

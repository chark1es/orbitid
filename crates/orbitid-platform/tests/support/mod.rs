//! Shared test doubles: a local Resend stand-in, a tiny ESMTP server and a
//! webhook receiver. Ported from the retired TypeScript test suite.

#![allow(dead_code)]

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::post;
use axum::Router;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};

// ───────────── Resend ─────────────

#[derive(Debug, Clone, Default)]
pub struct ResendRequest {
    pub authorization: Option<String>,
    pub content_type: Option<String>,
    pub body: serde_json::Value,
}

#[derive(Clone)]
struct ResendState {
    requests: Arc<Mutex<Vec<ResendRequest>>>,
    status: u16,
    body: String,
}

pub struct FakeResend {
    pub url: String,
    requests: Arc<Mutex<Vec<ResendRequest>>>,
}

impl FakeResend {
    pub fn requests(&self) -> Vec<ResendRequest> {
        self.requests
            .lock()
            .map(|value| value.clone())
            .unwrap_or_default()
    }
}

async fn resend_handler(
    State(state): State<Arc<ResendState>>,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    let request = ResendRequest {
        authorization: headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string),
        content_type: headers
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string),
        body: serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null),
    };
    if let Ok(mut requests) = state.requests.lock() {
        requests.push(request);
    }
    let status = StatusCode::from_u16(state.status).unwrap_or(StatusCode::OK);
    (
        status,
        [("content-type", "application/json")],
        state.body.clone(),
    )
}

pub async fn start_fake_resend(status: u16, response_body: &str) -> FakeResend {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let state = Arc::new(ResendState {
        requests: requests.clone(),
        status,
        body: response_body.to_string(),
    });
    let app = Router::new()
        .route("/emails", post(resend_handler))
        .with_state(state);
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let address = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    FakeResend {
        url: format!("http://{address}/emails"),
        requests,
    }
}

// ───────────── SMTP ─────────────

#[derive(Debug, Clone)]
pub struct SmtpMessage {
    pub raw: String,
    pub mail_from: String,
    pub recipients: Vec<String>,
}

pub struct FakeSmtp {
    pub url: String,
    messages: Arc<Mutex<Vec<SmtpMessage>>>,
}

impl FakeSmtp {
    pub fn messages(&self) -> Vec<SmtpMessage> {
        self.messages
            .lock()
            .map(|value| value.clone())
            .unwrap_or_default()
    }

    pub fn last(&self) -> Option<SmtpMessage> {
        self.messages().into_iter().next_back()
    }
}

pub async fn start_fake_smtp() -> FakeSmtp {
    let messages = Arc::new(Mutex::new(Vec::new()));
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let address = listener.local_addr().expect("addr");
    let store = messages.clone();
    tokio::spawn(async move {
        loop {
            let Ok((socket, _)) = listener.accept().await else {
                break;
            };
            let store = store.clone();
            tokio::spawn(async move {
                let _ = handle_smtp(socket, store).await;
            });
        }
    });
    FakeSmtp {
        url: format!("smtp://127.0.0.1:{}", address.port()),
        messages,
    }
}

fn between_angles(line: &str) -> String {
    let start = line.find('<');
    let end = line.rfind('>');
    match (start, end) {
        (Some(start), Some(end)) if end > start => line[start + 1..end].to_string(),
        _ => String::new(),
    }
}

async fn handle_smtp(
    socket: TcpStream,
    store: Arc<Mutex<Vec<SmtpMessage>>>,
) -> std::io::Result<()> {
    let (read_half, mut write_half) = socket.into_split();
    let mut reader = BufReader::new(read_half);
    write_half
        .write_all(b"220 fake.invalid ESMTP ready\r\n")
        .await?;
    let mut mail_from = String::new();
    let mut recipients: Vec<String> = Vec::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).await? == 0 {
            return Ok(());
        }
        let command = line.trim_end_matches(['\r', '\n']).to_string();
        let upper = command.to_uppercase();
        if upper.starts_with("EHLO") || upper.starts_with("HELO") {
            write_half
                .write_all(b"250-fake.invalid\r\n250-8BITMIME\r\n250 SIZE 10485760\r\n")
                .await?;
        } else if upper.starts_with("MAIL FROM") {
            mail_from = between_angles(&command);
            write_half.write_all(b"250 2.1.0 Ok\r\n").await?;
        } else if upper.starts_with("RCPT TO") {
            recipients.push(between_angles(&command));
            write_half.write_all(b"250 2.1.5 Ok\r\n").await?;
        } else if upper.starts_with("DATA") {
            write_half
                .write_all(b"354 End data with <CR><LF>.<CR><LF>\r\n")
                .await?;
            let mut data = String::new();
            loop {
                let mut body_line = String::new();
                if reader.read_line(&mut body_line).await? == 0 {
                    return Ok(());
                }
                if body_line == ".\r\n" || body_line == ".\n" {
                    break;
                }
                match body_line.strip_prefix("..") {
                    Some(rest) => {
                        data.push('.');
                        data.push_str(rest);
                    }
                    None => data.push_str(&body_line),
                }
            }
            if let Ok(mut messages) = store.lock() {
                messages.push(SmtpMessage {
                    raw: data.trim_end_matches("\r\n").to_string(),
                    mail_from: mail_from.clone(),
                    recipients: recipients.clone(),
                });
            }
            recipients.clear();
            write_half
                .write_all(b"250 2.0.0 Ok: queued as fake\r\n")
                .await?;
        } else if upper.starts_with("RSET") {
            mail_from.clear();
            recipients.clear();
            write_half.write_all(b"250 2.0.0 Ok\r\n").await?;
        } else if upper.starts_with("NOOP") {
            write_half.write_all(b"250 2.0.0 Ok\r\n").await?;
        } else if upper.starts_with("QUIT") {
            write_half.write_all(b"221 2.0.0 Bye\r\n").await?;
            return Ok(());
        } else {
            write_half.write_all(b"250 2.0.0 Ok\r\n").await?;
        }
    }
}

// ───────────── webhook receiver ─────────────

#[derive(Debug, Clone)]
pub struct ReceivedWebhook {
    pub headers: HeaderMap,
    pub body: String,
}

#[derive(Clone)]
struct ReceiverState {
    received: Arc<Mutex<Vec<ReceivedWebhook>>>,
    statuses: Arc<Mutex<VecDeque<u16>>>,
    delays_ms: Arc<Mutex<VecDeque<u64>>>,
}

pub struct FakeReceiver {
    pub url: String,
    received: Arc<Mutex<Vec<ReceivedWebhook>>>,
    statuses: Arc<Mutex<VecDeque<u16>>>,
    delays_ms: Arc<Mutex<VecDeque<u64>>>,
}

impl FakeReceiver {
    pub fn received(&self) -> Vec<ReceivedWebhook> {
        self.received
            .lock()
            .map(|value| value.clone())
            .unwrap_or_default()
    }

    pub fn enqueue_statuses(&self, statuses: &[u16]) {
        if let Ok(mut queue) = self.statuses.lock() {
            queue.extend(statuses.iter().copied());
        }
    }

    /// Delays the next responses by the given milliseconds (default 0).
    pub fn enqueue_delays(&self, delays_ms: &[u64]) {
        if let Ok(mut queue) = self.delays_ms.lock() {
            queue.extend(delays_ms.iter().copied());
        }
    }
}

async fn receiver_handler(
    State(state): State<Arc<ReceiverState>>,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    if let Ok(mut received) = state.received.lock() {
        received.push(ReceivedWebhook {
            headers: headers.clone(),
            body: String::from_utf8_lossy(&body).into_owned(),
        });
    }
    let status = state
        .statuses
        .lock()
        .ok()
        .and_then(|mut queue| queue.pop_front())
        .unwrap_or(200);
    let delay = state
        .delays_ms
        .lock()
        .ok()
        .and_then(|mut queue| queue.pop_front())
        .unwrap_or(0);
    if delay > 0 {
        tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
    }
    let body = format!("{{\"ok\":{},\"echoed\":{}}}", status == 200, body.len());
    (
        StatusCode::from_u16(status).unwrap_or(StatusCode::OK),
        [("content-type", "application/json")],
        body,
    )
}

pub async fn start_fake_receiver() -> FakeReceiver {
    let received = Arc::new(Mutex::new(Vec::new()));
    let statuses = Arc::new(Mutex::new(VecDeque::new()));
    let delays_ms = Arc::new(Mutex::new(VecDeque::new()));
    let state = Arc::new(ReceiverState {
        received: received.clone(),
        statuses: statuses.clone(),
        delays_ms: delays_ms.clone(),
    });
    let app = Router::new()
        .route("/hook", post(receiver_handler))
        .with_state(state);
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let address = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    FakeReceiver {
        url: format!("http://{address}/hook"),
        received,
        statuses,
        delays_ms,
    }
}

// ───────────── message parsing ─────────────

/// Header block of a raw message, one entry per header line (unfolded).
pub fn raw_headers(raw: &str) -> Vec<(String, String)> {
    let header_block = raw.split("\r\n\r\n").next().unwrap_or("");
    let mut headers: Vec<(String, String)> = Vec::new();
    for line in header_block.split("\r\n") {
        if (line.starts_with(' ') || line.starts_with('\t')) && !headers.is_empty() {
            if let Some(last) = headers.last_mut() {
                last.1.push(' ');
                last.1.push_str(line.trim());
            }
            continue;
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.push((name.to_string(), value.trim().to_string()));
        }
    }
    headers
}

pub fn header_value<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(header, _)| header.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

fn decode_quoted_printable(body: &str) -> String {
    let without_soft_breaks = body.replace("=\r\n", "").replace("=\n", "");
    let bytes = without_soft_breaks.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'=' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or("");
            if let Ok(value) = u8::from_str_radix(hex, 16) {
                out.push(value);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Flattens a raw MIME message into readable text so codes and links can be found.
pub fn readable_message(raw: &str) -> String {
    let (header_block, body) = raw.split_once("\r\n\r\n").unwrap_or((raw, ""));
    let is_base64 = header_block
        .to_ascii_lowercase()
        .contains("content-transfer-encoding: base64");
    let plain = if is_base64 {
        let cleaned: String = body
            .chars()
            .filter(|character| {
                character.is_ascii_alphanumeric() || *character == '+' || *character == '='
            })
            .collect();
        use base64::Engine;
        base64::engine::general_purpose::STANDARD
            .decode(cleaned)
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
            .unwrap_or_else(|_| body.to_string())
    } else {
        decode_quoted_printable(body)
    };
    format!("{header_block}\n\n{plain}")
}

/// Six-digit code from a message.
pub fn code_in(message: &str) -> Option<String> {
    let regex = regex::Regex::new(r"\b(\d{6})\b").ok()?;
    regex
        .captures(message)
        .and_then(|captures| captures.get(1).map(|value| value.as_str().to_string()))
}

/// First URL in a message, with trailing punctuation removed.
pub fn link_in(message: &str) -> Option<String> {
    let regex = regex::Regex::new(r#"https?://[^\s"'<>]+"#).ok()?;
    regex
        .find(message)
        .map(|value| value.as_str().trim_end_matches([',', '.', ')']).to_string())
}

/// True when the crate's own test harness state is usable; panics otherwise.
pub fn assert_test_env(state: &orbitid_core::AppState) {
    assert_eq!(state.env.node_env, "test");
}

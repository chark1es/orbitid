use std::process::ExitCode;

#[tokio::main]
async fn main() -> ExitCode {
    let code = orbitid_server::cli::run().await;
    ExitCode::from(code.clamp(0, 255) as u8)
}

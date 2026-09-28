//! Genie server and CLI.
//!
//! `genie serve` runs the web UI and API, the agent runtime, the automation
//! engine and the delivery channels in one process. See docs/platform/backend.md.

pub mod agent_cli;
pub mod channels;
pub mod cli;
pub mod config;
pub mod engine;
pub mod http;
pub mod knowledge;
pub mod notify;
pub mod questions;
pub mod runtime;
pub mod state;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use state::App;

/// Default data directory: `$GENIE_DATA` or `~/.local/share/genie`.
pub fn default_data_dir() -> PathBuf {
    if let Some(d) = std::env::var_os("GENIE_DATA").filter(|d| !d.is_empty()) {
        return PathBuf::from(d);
    }
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
    home.join(".local/share/genie")
}

/// Run the server until Ctrl-C.
pub async fn serve(app: Arc<App>) -> Result<(), String> {
    let addr: SocketAddr = format!("{}:{}", app.cfg.bind, app.cfg.port).parse().map_err(|e| format!("bind address: {e}"))?;
    let listener = tokio::net::TcpListener::bind(addr).await.map_err(|e| format!("{addr}: {e}"))?;
    println!("genie serve: http://{addr} (data {})", app.data.display());
    serve_on(app, listener, async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await
}

/// Serve on an already bound listener until `shutdown` completes.
pub async fn serve_on(
    app: Arc<App>,
    listener: tokio::net::TcpListener,
    shutdown: impl std::future::Future<Output = ()> + Send + 'static,
) -> Result<(), String> {
    let router = http::router(app);
    axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(shutdown)
        .await
        .map_err(|e| e.to_string())
}

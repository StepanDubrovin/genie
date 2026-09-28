//! `genie` — the Genie server and CLI (Rust port, work in progress).
//!
//! During the migration the TypeScript `bin/genie` stays the everyday tool; this
//! binary grows command by command (see docs/platform/roadmap.md, Ф0).

mod server;

use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;

use clap::{Parser, Subcommand};
use genie_core::Tracker;

#[derive(Parser)]
#[command(name = "genie", version, about = "Genie server and CLI")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Serve the web UI and the API for a tracker.
    Serve {
        /// Tracker directory (the one holding genie.db).
        #[arg(long, default_value = ".genie")]
        dir: PathBuf,
        #[arg(long, default_value_t = 7420)]
        port: u16,
        /// Built web UI (`npm run build:web`).
        #[arg(long, default_value = "web/dist")]
        web: PathBuf,
        /// Extra `host:port` values accepted in the Host header (e.g. a tailnet name).
        #[arg(long = "allow-host")]
        allow_hosts: Vec<String>,
    },
    /// Create a tracker directory (or keep an existing one).
    Init {
        #[arg(long, default_value = ".genie")]
        dir: PathBuf,
        #[arg(long)]
        prefix: Option<String>,
        #[arg(long)]
        project: Option<String>,
    },
}

#[tokio::main]
async fn main() {
    if let Err(e) = run(Cli::parse()).await {
        eprintln!("genie: {e}");
        std::process::exit(1);
    }
}

async fn run(cli: Cli) -> Result<(), Box<dyn std::error::Error>> {
    match cli.command {
        Command::Init { dir, prefix, project } => {
            let t = Tracker::init(&dir, prefix.as_deref(), project.as_deref())?;
            let m = t.meta()?;
            println!("genie tracker in {} (project {}, prefix {})", dir.display(), m.project, m.prefix);
        }
        Command::Serve { dir, port, web, allow_hosts } => {
            let tracker = Tracker::open(&dir)?;
            let project = tracker.meta()?.project;
            let app = server::app(server::AppState::new(tracker, port, &allow_hosts), web);
            let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
            let listener = tokio::net::TcpListener::bind(addr).await?;
            println!("genie serve: {project} on http://{addr}");
            axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = tokio::signal::ctrl_c().await;
                })
                .await?;
        }
    }
    Ok(())
}

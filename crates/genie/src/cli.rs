//! Command line: server administration (works on the data directory directly,
//! with or without a running server) and `genie serve`.

use std::io::Read;
use std::path::PathBuf;

use clap::{Parser, Subcommand};
use genie_core::Tracker;
use genie_core::server_db::{ProjectRole, ServerDb};

use crate::config::Config;
use crate::state::App;

#[derive(Parser)]
#[command(name = "genie", version, about = "Genie: tasks, knowledge and agent teams for small teams")]
pub struct Cli {
    /// Data directory (default: $GENIE_DATA or ~/.local/share/genie).
    #[arg(long, global = true)]
    data: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Run the server: web UI, API, agents, automations and channels.
    Serve {
        #[arg(long)]
        port: Option<u16>,
        /// Built web UI (`npm run build:web`).
        #[arg(long, default_value = "web/dist")]
        web: PathBuf,
        /// Do not start agents (UI and automations only).
        #[arg(long)]
        no_agents: bool,
    },
    /// Projects of this server.
    #[command(subcommand)]
    Project(ProjectCmd),
    /// People with access to this server.
    #[command(subcommand)]
    User(UserCmd),
    /// Give a user a role in a project (viewer, member, admin, owner).
    Member { project: String, login: String, role: String },
    /// Print an invitation link for a project.
    Invite {
        project: String,
        #[arg(long, default_value = "member")]
        role: String,
        #[arg(long)]
        email: Option<String>,
    },
    /// Create a standalone tracker directory (legacy layout).
    Init {
        #[arg(long, default_value = ".genie")]
        dir: PathBuf,
        #[arg(long)]
        prefix: Option<String>,
        #[arg(long)]
        project: Option<String>,
    },
}

#[derive(Subcommand)]
enum ProjectCmd {
    /// Add a project. With --repo, a repository's existing `.genie/` tracker is reused.
    Add {
        slug: String,
        #[arg(long, default_value = "")]
        name: String,
        /// Git repository of the project (omit for projects without code).
        #[arg(long)]
        repo: Option<PathBuf>,
        /// Existing tracker directory to register in place.
        #[arg(long)]
        tracker: Option<PathBuf>,
        /// Task id prefix for a new tracker (G, PAY…).
        #[arg(long)]
        prefix: Option<String>,
    },
    List,
}

#[derive(Subcommand)]
enum UserCmd {
    /// Add a user; the password is read from stdin when --password-stdin is given.
    Add {
        login: String,
        #[arg(long, default_value = "")]
        name: String,
        #[arg(long)]
        email: Option<String>,
        #[arg(long)]
        admin: bool,
        #[arg(long)]
        password_stdin: bool,
    },
    List,
    /// Set a password (read from stdin).
    Passwd {
        login: String,
    },
    /// Print a personal API token for the CLI.
    Token {
        login: String,
    },
}

fn read_password() -> Result<String, String> {
    let mut s = String::new();
    std::io::stdin().read_to_string(&mut s).map_err(|e| e.to_string())?;
    Ok(s.trim_end_matches(['\n', '\r']).to_string())
}

pub async fn run() -> Result<(), String> {
    let cli = Cli::parse();
    let data = cli.data.unwrap_or_else(crate::default_data_dir);
    let server_db = || ServerDb::open(&data.join("server.db")).map_err(|e| e.to_string());
    match cli.command {
        Command::Serve { port, web, no_agents } => {
            let mut cfg = Config::load(&data)?;
            if let Some(p) = port {
                cfg.port = p;
            }
            if no_agents {
                cfg.runtime.enabled = false;
            }
            let app = App::open(&data, cfg, web).map_err(|e| e.to_string())?;
            crate::runtime::start(&app);
            crate::serve(app).await?;
        }
        Command::Project(ProjectCmd::Add { slug, name, repo, tracker, prefix }) => {
            let cfg = Config::load(&data)?;
            let app = App::open(&data, cfg, PathBuf::new()).map_err(|e| e.to_string())?;
            let tracker = tracker.or_else(|| repo.as_ref().map(|r| r.join(".genie")).filter(|d| d.join("genie.db").exists()));
            let p = app
                .create_project(
                    &slug,
                    &name,
                    repo.as_deref().and_then(|r| r.to_str()),
                    tracker.as_deref().and_then(|t| t.to_str()),
                    prefix.as_deref(),
                )
                .map_err(|e| e.to_string())?;
            println!(
                "project {} ({}) — tracker {}{}",
                p.slug,
                p.name,
                p.tracker_dir,
                p.repo.map(|r| format!(", repo {r}")).unwrap_or_default()
            );
        }
        Command::Project(ProjectCmd::List) => {
            for p in server_db()?.projects().map_err(|e| e.to_string())? {
                println!("{:<16} {:<24} {:<10} {}", p.slug, p.name, p.autonomy, p.repo.unwrap_or_else(|| "(no code)".into()));
            }
        }
        Command::User(UserCmd::Add { login, name, email, admin, password_stdin }) => {
            let password = if password_stdin { Some(read_password()?) } else { None };
            let u = server_db()?.create_user(&login, &name, email.as_deref(), password.as_deref(), admin).map_err(|e| e.to_string())?;
            println!("user {} ({}){}", u.login, u.name, if u.is_admin { ", admin" } else { "" });
            if password.is_none() {
                println!("no password yet: echo '<password>' | genie user passwd {}", u.login);
            }
        }
        Command::User(UserCmd::List) => {
            for u in server_db()?.users().map_err(|e| e.to_string())? {
                println!(
                    "{:<16} {:<24} {}{}",
                    u.login,
                    u.name,
                    if u.is_admin { "admin" } else { "" },
                    if u.disabled { " (disabled)" } else { "" }
                );
            }
        }
        Command::User(UserCmd::Passwd { login }) => {
            let db = server_db()?;
            let u = db.user_by_login(&login).map_err(|e| e.to_string())?.ok_or(format!("no user {login}"))?;
            db.set_password(u.id, &read_password()?).map_err(|e| e.to_string())?;
            println!("password of {login} updated");
        }
        Command::User(UserCmd::Token { login }) => {
            let db = server_db()?;
            let u = db.user_by_login(&login).map_err(|e| e.to_string())?.ok_or(format!("no user {login}"))?;
            println!("{}", db.create_user_token(u.id, "cli").map_err(|e| e.to_string())?);
        }
        Command::Member { project, login, role } => {
            let db = server_db()?;
            let u = db.user_by_login(&login).map_err(|e| e.to_string())?.ok_or(format!("no user {login}"))?;
            db.project(&project).map_err(|e| e.to_string())?;
            db.set_membership(&project, u.id, ProjectRole::parse(&role).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
            println!("{login} is {role} in {project}");
        }
        Command::Invite { project, role, email } => {
            let cfg = Config::load(&data)?;
            let db = server_db()?;
            db.project(&project).map_err(|e| e.to_string())?;
            let token = db
                .create_invite(None, Some(&project), ProjectRole::parse(&role).map_err(|e| e.to_string())?, email.as_deref())
                .map_err(|e| e.to_string())?;
            println!("{}/invite?token={token}", cfg.public_url());
        }
        Command::Init { dir, prefix, project } => {
            let t = Tracker::init(&dir, prefix.as_deref(), project.as_deref()).map_err(|e| e.to_string())?;
            let m = t.meta().map_err(|e| e.to_string())?;
            println!("genie tracker in {} (project {}, prefix {})", dir.display(), m.project, m.prefix);
        }
    }
    Ok(())
}

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
    /// Consistent snapshot of every database, the vault and the server's configuration into a directory.
    Backup {
        dir: PathBuf,
        /// Keep only this many most recent backups in the directory (older `genie-*` are removed).
        #[arg(long)]
        keep: Option<usize>,
    },
    /// What happened over the last days, for reviewing a pilot: tasks, decisions, reviews, agent runs, knowledge.
    Stats {
        #[arg(long, default_value_t = 7)]
        days: i64,
        /// One project only.
        #[arg(long)]
        project: Option<String>,
        /// JSON instead of text.
        #[arg(long)]
        json: bool,
    },
    /// Check that the server is ready: data, web UI, people, projects, pi and the models, sandbox, git, channels, network.
    Doctor {
        /// Built web UI the server serves.
        #[arg(long, default_value = "web/dist")]
        web: PathBuf,
    },
    /// Knowledge vault maintenance.
    #[command(subcommand)]
    Vault(VaultCmd),
    /// Roles, team templates, skills and MCP connections of this server.
    #[command(subcommand)]
    Agents(AgentsCmd),
    /// Act as an agent (or script genie) through the server API.
    #[command(subcommand)]
    Agent(crate::agent_cli::AgentCmd),
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
enum VaultCmd {
    /// Copy Markdown pages (e.g. a repository's docs/) into a vault space, keeping folders.
    Import {
        dir: PathBuf,
        #[arg(long)]
        space: String,
    },
    /// Rebuild the search index from the files.
    Reindex,
    /// Sync the vault with its git remote (vault.remote) once: fetch, merge, push. The running server does it by itself.
    Sync,
}

#[derive(Subcommand)]
enum AgentsCmd {
    /// Check the configuration files in the data directory; exits with an error when something is broken.
    Check,
    /// Roles and team templates as the server sees them.
    Ls,
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
                println!(
                    "{:<16} {:<24} {:<10} {}  tracker {}",
                    p.slug,
                    p.name,
                    p.autonomy,
                    p.repo.unwrap_or_else(|| "(no code)".into()),
                    p.tracker_dir
                );
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
        Command::Agent(cmd) => crate::agent_cli::run(cmd).await?,
        Command::Backup { dir, keep } => {
            let cfg = Config::load(&data)?;
            let report = backup(&data, &cfg, &dir)?;
            println!("{report}");
            if let Some(keep) = keep {
                for old in prune_backups(&dir, keep)? {
                    println!("removed {}", old.display());
                }
            }
        }
        Command::Stats { days, project, json } => {
            let stats = crate::stats::collect(&data, days, project.as_deref())?;
            if json {
                println!("{}", serde_json::to_string_pretty(&stats).map_err(|e| e.to_string())?);
            } else {
                println!("{}", crate::stats::render(&stats));
            }
        }
        Command::Doctor { web } => {
            let cfg = Config::load(&data)?;
            let agents = crate::agent_config::AgentConfig::load(&data, &cfg, None);
            let (report, failed) = crate::doctor::print(&crate::doctor::run(&data, &cfg, &agents, &web));
            println!("{report}");
            if failed > 0 {
                return Err(format!("{failed} check(s) failed"));
            }
        }
        Command::Vault(cmd) => {
            let cfg = Config::load(&data)?;
            let vault_dir = cfg.vault_path(&data);
            let index = data.join("vault-index.db");
            match cmd {
                VaultCmd::Import { dir, space } => {
                    let mut copied = 0;
                    let mut stack = vec![dir.clone()];
                    while let Some(d) = stack.pop() {
                        for e in std::fs::read_dir(&d).map_err(|e| format!("{}: {e}", d.display()))?.flatten() {
                            let path = e.path();
                            let name = e.file_name().to_string_lossy().into_owned();
                            if name.starts_with('.') {
                                continue;
                            }
                            if path.is_dir() {
                                stack.push(path);
                            } else if name.ends_with(".md") {
                                let rel = path.strip_prefix(&dir).map_err(|e| e.to_string())?;
                                let target = vault_dir.join(&space).join(rel);
                                if target.exists() {
                                    println!("skip {} (exists)", target.display());
                                    continue;
                                }
                                std::fs::create_dir_all(target.parent().unwrap_or(&vault_dir)).map_err(|e| e.to_string())?;
                                std::fs::copy(&path, &target).map_err(|e| e.to_string())?;
                                copied += 1;
                            }
                        }
                    }
                    let mut v =
                        genie_core::vault::Vault::open(&vault_dir, &index, cfg.vault.commit.unwrap_or(true)).map_err(|e| e.to_string())?;
                    let _ = std::process::Command::new("git").arg("-C").arg(&vault_dir).args(["add", "-A", &space]).output();
                    let _ = std::process::Command::new("git")
                        .arg("-C")
                        .arg(&vault_dir)
                        .args([
                            "-c",
                            "user.name=genie",
                            "-c",
                            "user.email=genie@genie.local",
                            "commit",
                            "-q",
                            "-m",
                            &format!("import {} into {space}", dir.display()),
                        ])
                        .output();
                    v.refresh().map_err(|e| e.to_string())?;
                    println!("{copied} page(s) imported into {}/{space}", vault_dir.display());
                }
                VaultCmd::Sync => {
                    let app = App::open(&data, cfg.clone(), PathBuf::new()).map_err(|e| e.to_string())?;
                    match crate::vault_sync::sync(&app).map_err(|e| e.to_string())? {
                        None => return Err("vault.remote is not set in config.json".into()),
                        Some(st) if !st.ok => return Err(st.error.unwrap_or_default()),
                        Some(st) => {
                            println!("vault synced with {} ({}): {} commit(s) in, {} out", st.remote, st.branch, st.pulled, st.pushed);
                            if !st.both.is_empty() {
                                println!("changed on both sides (the server's lines kept where they overlap): {}", st.both.join(", "));
                            }
                        }
                    }
                }
                VaultCmd::Reindex => {
                    let _ = std::fs::remove_file(&index);
                    let v =
                        genie_core::vault::Vault::open(&vault_dir, &index, cfg.vault.commit.unwrap_or(true)).map_err(|e| e.to_string())?;
                    println!("index rebuilt for {}", v.root().display());
                }
            }
        }
        Command::Agents(cmd) => {
            let cfg = Config::load(&data)?;
            let agents = crate::agent_config::AgentConfig::load(&data, &cfg, None);
            match cmd {
                AgentsCmd::Check => {
                    println!("{}", crate::agent_config::report(&agents));
                    let with_mcp: Vec<&str> = agents.roles.values().filter(|r| !r.mcp.is_empty()).map(|r| r.id.as_str()).collect();
                    if !with_mcp.is_empty() && !cfg.runtime.mcp_adapter() {
                        println!(
                            "warning: roles {} have MCP connections, but pi does not load pi-mcp-adapter: `pi install npm:pi-mcp-adapter` (or set runtime.mcpAdapter)",
                            with_mcp.join(", ")
                        );
                    }
                    match crate::sandbox::status(&cfg.runtime.sandbox) {
                        (true, note) => println!("sandbox: {note}"),
                        (false, note) => println!("warning: {note}"),
                    }
                    let errors = agents.errors().count();
                    if errors > 0 {
                        return Err(format!("{errors} error(s) in the agent configuration of {}", data.display()));
                    }
                }
                AgentsCmd::Ls => {
                    println!("Roles:");
                    for r in agents.roles.values() {
                        let caps: Vec<&str> = r.capabilities.iter().map(|c| c.as_str()).filter(|c| c.starts_with("status.")).collect();
                        println!(
                            "  {:<20} {:<12} {:<9} {}{}",
                            r.id,
                            r.class.as_str(),
                            format!("{:?}", r.origin).to_lowercase(),
                            r.title,
                            if caps.is_empty() { String::new() } else { format!(" · {}", caps.join(", ")) }
                        );
                    }
                    println!("Team templates:");
                    for t in agents.teams.values() {
                        let roles: Vec<&str> = t.members.iter().map(|m| m.role.as_str()).collect();
                        println!("  {:<20} {:<9} {} · {}", t.id, format!("{:?}", t.origin).to_lowercase(), t.title, roles.join(", "));
                    }
                    if !agents.skills.is_empty() {
                        println!("Skills: {}", agents.skills.keys().cloned().collect::<Vec<_>>().join(", "));
                    }
                    if !agents.mcp.is_empty() {
                        println!("MCP connections: {}", agents.mcp.keys().cloned().collect::<Vec<_>>().join(", "));
                    }
                }
            }
        }
        Command::Init { dir, prefix, project } => {
            let t = Tracker::init(&dir, prefix.as_deref(), project.as_deref()).map_err(|e| e.to_string())?;
            let m = t.meta().map_err(|e| e.to_string())?;
            println!("genie tracker in {} (project {}, prefix {})", dir.display(), m.project, m.prefix);
        }
    }
    Ok(())
}

/// `VACUUM INTO` gives a consistent copy of a live SQLite database (WAL included)
/// without stopping the server; the vault is bundled with git. The server's
/// configuration (`config.json` with the channel secrets, roles, templates,
/// skills, `mcp.json`) is copied too: the backup directory is private (0700).
pub fn backup(data: &std::path::Path, cfg: &Config, dir: &std::path::Path) -> Result<String, String> {
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S").to_string();
    let out = dir.join(format!("genie-{stamp}"));
    std::fs::create_dir_all(out.join("projects")).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&out, std::fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    let snapshot = |src: &std::path::Path, dst: &std::path::Path| -> Result<(), String> {
        let conn = rusqlite::Connection::open(src).map_err(|e| format!("{}: {e}", src.display()))?;
        conn.busy_timeout(std::time::Duration::from_secs(30)).map_err(|e| e.to_string())?;
        conn.execute("VACUUM INTO ?1", [dst.to_string_lossy()]).map_err(|e| format!("{}: {e}", src.display()))?;
        Ok(())
    };
    let mut lines = Vec::new();
    snapshot(&data.join("server.db"), &out.join("server.db"))?;
    lines.push("server.db".to_string());
    let db = ServerDb::open(&data.join("server.db")).map_err(|e| e.to_string())?;
    for p in db.projects().map_err(|e| e.to_string())? {
        let src = std::path::Path::new(&p.tracker_dir).join("genie.db");
        snapshot(&src, &out.join("projects").join(format!("{}.db", p.slug)))?;
        lines.push(format!("projects/{}.db ({})", p.slug, src.display()));
    }
    let vault = cfg.vault_path(data);
    if vault.join(".git").exists() {
        let bundle = out.join("vault.bundle");
        let st = std::process::Command::new("git")
            .arg("-C")
            .arg(&vault)
            .args(["bundle", "create"])
            .arg(&bundle)
            .arg("--all")
            .output()
            .map_err(|e| e.to_string())?;
        if !st.status.success() {
            return Err(format!("git bundle: {}", String::from_utf8_lossy(&st.stderr)));
        }
        lines.push("vault.bundle (restore: git clone vault.bundle vault)".into());
    }
    let mut config = Vec::new();
    for item in ["config.json", "mcp.json", "agents", "teams", "skills"] {
        let src = data.join(item);
        if src.exists() {
            copy_tree(&src, &out.join("config").join(item))?;
            config.push(item);
        }
    }
    if !config.is_empty() {
        lines.push(format!("config/: {}", config.join(", ")));
    }
    Ok(format!("backup in {}:\n  {}", out.display(), lines.join("\n  ")))
}

fn copy_tree(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    if src.is_dir() {
        std::fs::create_dir_all(dst).map_err(|e| format!("{}: {e}", dst.display()))?;
        for e in std::fs::read_dir(src).map_err(|e| format!("{}: {e}", src.display()))?.flatten() {
            copy_tree(&e.path(), &dst.join(e.file_name()))?;
        }
        Ok(())
    } else {
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::copy(src, dst).map(|_| ()).map_err(|e| format!("{}: {e}", src.display()))
    }
}

/// Remove all but the `keep` most recent backups (`genie-<stamp>` directories) in `dir`.
pub fn prune_backups(dir: &std::path::Path, keep: usize) -> Result<Vec<PathBuf>, String> {
    let mut found: Vec<PathBuf> = std::fs::read_dir(dir)
        .map_err(|e| format!("{}: {e}", dir.display()))?
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.is_dir()
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with("genie-") && n[6..].chars().all(|c| c.is_ascii_digit() || c == '-'))
        })
        .collect();
    // The stamps sort by time.
    found.sort();
    let old = found.len().saturating_sub(keep.max(1));
    let removed: Vec<PathBuf> = found.into_iter().take(old).collect();
    for p in &removed {
        std::fs::remove_dir_all(p).map_err(|e| format!("{}: {e}", p.display()))?;
    }
    Ok(removed)
}

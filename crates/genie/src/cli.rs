//! Command line: the operations of the catalog (`genie task …`, `genie team …`,
//! see [`crate::ops`]), server administration (works on the data directory
//! directly, with or without a running server) and `genie serve`.

use std::path::{Path, PathBuf};

use clap::{ArgMatches, CommandFactory, FromArgMatches, Parser, Subcommand};
use genie_core::Tracker;
use genie_core::server_db::ServerDb;

use crate::config::Config;
use crate::ops::{self, Auth, Cx, InProcess, Remote};
use crate::state::App;

#[derive(Parser)]
#[command(name = "genie", version, about = "Genie: tasks, knowledge and agent teams for small teams")]
pub struct Cli {
    /// Data directory (default: $GENIE_DATA or ~/.local/share/genie).
    #[arg(long, global = true)]
    data: Option<PathBuf>,
    /// The project to act in (default: $GENIE_PROJECT, else your first project).
    #[arg(long, global = true)]
    project: Option<String>,
    /// Print the answer as JSON.
    #[arg(long, global = true)]
    json: bool,
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
    /// What happened over the last days, for reviewing a pilot: tasks, decisions, reviews, agent runs, knowledge (--project: one project only).
    Stats {
        #[arg(long, default_value_t = 7)]
        days: i64,
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
    /// Create a standalone tracker directory (legacy layout; --project names it).
    Init {
        #[arg(long, default_value = ".genie")]
        dir: PathBuf,
        #[arg(long)]
        prefix: Option<String>,
    },
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

fn env(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.is_empty())
}

/// Where the operations of the command line go: with `GENIE_TOKEN`, to the
/// server at `GENIE_URL` as that token's person or agent; without, straight to
/// the data directory as its operator (a server admin), with or without a
/// running server.
pub fn op_context(data: &Path, project: Option<String>, setup: bool) -> Result<Cx, String> {
    let (task, team) = (env("GENIE_TASK"), env("GENIE_TEAM"));
    if let Some(token) = env("GENIE_TOKEN") {
        let base = env("GENIE_URL").unwrap_or_else(|| format!("http://127.0.0.1:{}", Config::load(data).map(|c| c.port).unwrap_or(7420)));
        return Ok(Cx { api: Box::new(Remote::new(&base, &token, project.clone())), project, task, team, local: true });
    }
    // Setting up (people, projects) may start a data directory; anything else needs one.
    if !setup && !data.join("server.db").exists() {
        return Err(format!(
            "no genie server data in {}: pass --data, or reach a server with GENIE_URL and GENIE_TOKEN (genie user token <login>)",
            data.display()
        ));
    }
    let cfg = Config::load(data)?;
    let port = cfg.port;
    let app = App::open(data, cfg, PathBuf::new()).map_err(|e| e.to_string())?;
    Ok(Cx {
        api: Box::new(InProcess::new(crate::http::router(app), port, Auth::Operator, project.clone())),
        project,
        task,
        team,
        local: true,
    })
}

async fn run_op(entry: &ops::Entry, args: &ArgMatches, data: &Path, project: Option<String>, json: bool) -> Result<(), String> {
    let cx = op_context(data, project, matches!(entry.group, "user" | "project"))?;
    let out = entry.run_cli(args, &cx).await?;
    if json {
        println!("{}", serde_json::to_string_pretty(&out.data).map_err(|e| e.to_string())?);
    } else if !out.text.is_empty() {
        println!("{}", out.text);
    }
    Ok(())
}

/// A command kept from before the catalog, done by its operation.
async fn legacy_op(group: &str, name: &str, args: serde_json::Value, data: &Path) -> Result<String, String> {
    let entry = ops::find(group, name).ok_or(format!("no operation {group} {name}"))?;
    Ok(entry.run_json(args, &op_context(data, None, true)?).await?.text)
}

/// The whole command line: the commands below and the catalog's.
pub fn command() -> clap::Command {
    ops::commands(Cli::command())
}

pub async fn run() -> Result<(), String> {
    let matches = command().get_matches();
    if let Some((entry, args)) = ops::chosen(&matches) {
        let data = matches.get_one::<PathBuf>("data").cloned().unwrap_or_else(crate::default_data_dir);
        let project = matches.get_one::<String>("project").cloned().or_else(|| env("GENIE_PROJECT"));
        return run_op(entry, args, &data, project, matches.get_flag("json")).await;
    }
    let cli = Cli::from_arg_matches(&matches).map_err(|e| e.to_string())?;
    let data = cli.data.unwrap_or_else(crate::default_data_dir);
    let (project, json) = (cli.project, cli.json);
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
        Command::Member { project: slug, login, role } => {
            let args = serde_json::json!({ "project": slug, "login": login, "role": role });
            println!("{}", legacy_op("project", "member", args, &data).await?);
        }
        Command::Invite { project: slug, role, email } => {
            let args = serde_json::json!({ "project": slug, "role": role, "email": email });
            println!("{}", legacy_op("project", "invite", args, &data).await?);
        }
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
        Command::Stats { days } => {
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
        Command::Init { dir, prefix } => {
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

#[cfg(test)]
mod tests {
    #[test]
    fn the_command_line_is_consistent() {
        super::command().debug_assert();
    }
}

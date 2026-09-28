//! Agent runtime: teams, the server-side orchestrator and one-shot jobs, run as
//! *turns*.
//!
//! Every agent is a mailbox plus a harness session. When a mailbox has unread
//! mail (or a job is queued) and a slot is free, the scheduler starts a turn:
//! the mail is leased to the turn, the harness runs once (by default
//! `pi --print` resuming the agent's session), and the mail is marked delivered
//! only if the turn succeeds. A failed turn releases the lease and is retried
//! with exponential backoff; after `maxAttempts` failures the member is put in
//! `error` and the orchestrator is told. After a restart, running turns are
//! marked interrupted and their mail is offered again — nothing is lost and no
//! long-running process has to be babysat.
//!
//! Agents act through `genie agent …` (HTTP with a per-turn token bound to the
//! project, the team and the role), so any harness with a shell can take part.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use genie_core::server_db::Project;
use genie_core::team::{self, Mail, NewMember, NewTeam, ORCHESTRATOR, TeamWorktree};
use genie_core::work::Job;
use genie_core::{Actor, CLOSED, GenieError, Role, Status, StatusOptions, Task};
use serde_json::json;
use tokio::io::AsyncReadExt;
use tokio::sync::Semaphore;

use crate::config::{self, MemberSpec};
use crate::state::{App, AppError, AppResult};

/// Which agent a turn is for.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum AgentKey {
    Orchestrator { project: String },
    Member { project: String, team: String, member: String },
    Job { project: String, job: i64 },
}

impl AgentKey {
    pub fn project(&self) -> &str {
        match self {
            AgentKey::Orchestrator { project } | AgentKey::Member { project, .. } | AgentKey::Job { project, .. } => project,
        }
    }
    pub fn label(&self) -> String {
        match self {
            AgentKey::Orchestrator { .. } => ORCHESTRATOR.into(),
            AgentKey::Member { team, member, .. } => format!("{team}/{member}"),
            AgentKey::Job { job, .. } => format!("job/{job}"),
        }
    }
}

#[derive(Default)]
struct SchedState {
    running: HashSet<AgentKey>,
    /// Consecutive failures and when the agent may run again.
    backoff: HashMap<AgentKey, (u32, Instant)>,
}

static STATE: Mutex<Option<SchedState>> = Mutex::new(None);

fn with_state<T>(f: impl FnOnce(&mut SchedState) -> T) -> T {
    let mut g = STATE.lock().unwrap_or_else(|e| e.into_inner());
    f(g.get_or_insert_with(SchedState::default))
}

/// Start background workers: crash recovery, then the scheduler.
pub fn start(app: &Arc<App>) {
    crate::knowledge::start_watcher(app);
    crate::engine::start(app);
    crate::channels::start(app);
    if let Err(e) = recover(app) {
        eprintln!("genie runtime: recovery failed: {e}");
    }
    crate::sessions::recover(app);
    if app.cfg.runtime.live_sessions()
        && let Err(e) = crate::sessions::write_extension(app)
    {
        eprintln!("genie runtime: cannot write the session extension: {e}");
    }
    if !app.cfg.runtime.enabled {
        println!("genie runtime: agents disabled");
        return;
    }
    let app = app.clone();
    tokio::spawn(async move {
        let slots = Arc::new(Semaphore::new(app.cfg.runtime.max_concurrent.max(1)));
        loop {
            if let Err(e) = schedule(&app, &slots).await {
                eprintln!("genie runtime: {e}");
            }
            tokio::select! {
                _ = app.wake_runtime.notified() => {}
                _ = tokio::time::sleep(Duration::from_secs(3)) => {}
            }
        }
    });
}

/// After a restart: interrupted turns give their mail back, running jobs are requeued.
pub fn recover(app: &App) -> AppResult<()> {
    let interrupted = app.with_server(|db| {
        db.requeue_running_jobs()?;
        db.interrupt_running_turns()
    })?;
    for p in app.projects()? {
        match app.with_tracker(&p.slug, |t| t.bus().release_all_leases()) {
            Ok(n) if n > 0 => println!("genie runtime: {}: {n} message(s) from interrupted turns offered again", p.slug),
            Err(e) => eprintln!("genie runtime: {}: {e}", p.slug),
            _ => {}
        }
    }
    if !interrupted.is_empty() {
        println!("genie runtime: {} turn(s) were interrupted by the restart", interrupted.len());
    }
    // An agent process may have outlived the server; its turn will run again, so
    // stop the stray one — only if /proc shows it is really that agent.
    for t in &interrupted {
        let Some(pid) = t.pid else { continue };
        let name = match (&t.member, t.job) {
            (Some(m), _) => m.clone(),
            (None, Some(j)) => format!("job-{j}"),
            _ => ORCHESTRATOR.to_string(),
        };
        if is_our_agent(pid, &t.project, &name) {
            let _ = std::process::Command::new("kill").arg("-TERM").arg(pid.to_string()).status();
            println!("genie runtime: stopped stray agent process {pid} ({}/{name})", t.project);
        }
    }
    Ok(())
}

/// Does `/proc/<pid>/environ` belong to this project's agent `name`?
pub(crate) fn is_our_agent(pid: i64, project: &str, name: &str) -> bool {
    let Ok(env) = std::fs::read(format!("/proc/{pid}/environ")) else { return false };
    let vars: Vec<&[u8]> = env.split(|b| *b == 0).collect();
    let has = |kv: String| vars.contains(&kv.as_bytes());
    has(format!("GENIE_PROJECT={project}")) && has(format!("GENIE_AGENT_NAME={name}"))
}

async fn schedule(app: &Arc<App>, slots: &Arc<Semaphore>) -> AppResult<()> {
    let candidates = app
        .blocking(|app| {
            let mut out = Vec::new();
            for p in app.projects()? {
                let boxes = match app.with_tracker(&p.slug, |t| t.bus().mailboxes_with_mail()) {
                    Ok(b) => b,
                    Err(e) => {
                        eprintln!("genie runtime: {}: {e}", p.slug);
                        continue;
                    }
                };
                for b in boxes {
                    match b.team {
                        None if p.autonomy != "manual" => out.push(AgentKey::Orchestrator { project: p.slug.clone() }),
                        None => {}
                        Some(team) => out.push(AgentKey::Member { project: p.slug.clone(), team, member: b.recipient }),
                    }
                }
            }
            for j in app.with_server(|db| db.queued_jobs())? {
                out.push(AgentKey::Job { project: j.project.clone(), job: j.id });
            }
            Ok(out)
        })
        .await?;
    let live = app.cfg.runtime.live_sessions();
    if live {
        crate::sessions::sweep(app).await?;
    }
    let now = Instant::now();
    for key in candidates {
        if live && !matches!(key, AgentKey::Job { .. }) {
            crate::sessions::deliver(app, &key).await;
            continue;
        }
        let ready = with_state(|s| !s.running.contains(&key) && s.backoff.get(&key).is_none_or(|(_, until)| *until <= now));
        if !ready {
            continue;
        }
        let Ok(permit) = slots.clone().try_acquire_owned() else { break };
        with_state(|s| s.running.insert(key.clone()));
        let app = app.clone();
        tokio::spawn(async move {
            let ok = run_turn(&app, &key).await;
            with_state(|s| {
                s.running.remove(&key);
                if ok {
                    s.backoff.remove(&key);
                } else {
                    let n = s.backoff.get(&key).map(|(n, _)| n + 1).unwrap_or(1);
                    let delay = Duration::from_secs((5u64 << n.min(7)).min(600));
                    s.backoff.insert(key.clone(), (n, Instant::now() + delay));
                }
            });
            drop(permit);
            app.wake_runtime.notify_one();
            app.wake_engine.notify_one();
        });
    }
    Ok(())
}

/// Consecutive failures of an agent so far (for the attempt limit).
fn failures(key: &AgentKey) -> u32 {
    with_state(|s| s.backoff.get(key).map(|(n, _)| *n).unwrap_or(0))
}

struct Prepared {
    turn: i64,
    role: Role,
    name: String,
    team: Option<String>,
    task: Option<String>,
    job: Option<i64>,
    cwd: PathBuf,
    session_id: String,
    model: Option<String>,
    thinking: Option<String>,
    prompt: String,
    message: String,
    /// Per-turn agent token, revoked when the turn ends.
    token: String,
}

/// Run one turn; returns whether it succeeded.
async fn run_turn(app: &Arc<App>, key: &AgentKey) -> bool {
    let k = key.clone();
    let prepared = app.blocking(move |app| prepare(app, &k)).await;
    let p = match prepared {
        Ok(Some(p)) => p,
        Ok(None) => return true,
        Err(e) => {
            eprintln!("genie runtime: {}: cannot start {}: {e}", key.project(), key.label());
            return false;
        }
    };
    let turn = p.turn;
    let mut p = p;
    let ttl = chrono::Duration::seconds(app.cfg.runtime.turn_timeout_secs as i64 + 300);
    let (slug, role, name, team, job) = (key.project().to_string(), p.role, p.name.clone(), p.team.clone(), p.job);
    match app.blocking(move |app| app.with_server(|db| db.create_agent_token(&slug, role, &name, team.as_deref(), job, ttl))).await {
        Ok(t) => p.token = t,
        Err(e) => {
            eprintln!("genie runtime: turn {turn}: {e}");
            return false;
        }
    }
    let outcome = execute(app, key, &p).await;
    let (ok, code, error, log) = match outcome {
        Ok((code, log)) => (code == Some(0), code, (code != Some(0)).then(|| format!("exit code {code:?}")), log),
        Err(e) => (false, None, Some(e), String::new()),
    };
    let k = key.clone();
    let max_attempts = app.cfg.runtime.max_attempts.max(1);
    let attempts = failures(key) + u32::from(!ok);
    let res = app.blocking(move |app| finish(app, &k, &p, ok, code, error.as_deref(), &log, attempts >= max_attempts, max_attempts)).await;
    if let Err(e) = res {
        eprintln!("genie runtime: turn {turn}: {e}");
    }
    ok
}

fn project_of(app: &App, slug: &str) -> AppResult<Project> {
    app.with_server(|db| db.project(slug))
}

/// Working directory for agents of a project without a specific workspace.
fn project_workspace(app: &App, p: &Project, sub: &str) -> PathBuf {
    match &p.repo {
        Some(r) => PathBuf::from(r),
        None => {
            let d = app.data.join("workspaces").join(&p.slug).join(sub);
            let _ = std::fs::create_dir_all(&d);
            d
        }
    }
}

fn role_model(app: &App, role: &str, model: Option<String>, thinking: Option<String>) -> (Option<String>, Option<String>) {
    let d = app.cfg.role_models.get(role);
    (model.or_else(|| d.and_then(|d| d.model.clone())), thinking.or_else(|| d.and_then(|d| d.thinking.clone())))
}

fn prepare(app: &App, key: &AgentKey) -> AppResult<Option<Prepared>> {
    let project = project_of(app, key.project())?;
    let label = key.label();
    match key {
        AgentKey::Orchestrator { project: slug } => {
            let turn = app.with_server(|db| db.start_turn(slug, &label, None, None, None))?;
            let mail = app.with_tracker(slug, |t| t.bus().lease(None, ORCHESTRATOR, turn))?;
            if mail.is_empty() {
                app.with_server(|db| db.finish_turn(turn, "skipped", None, None, None))?;
                return Ok(None);
            }
            app.with_server(|db| db.set_turn_mail(turn, &mail.iter().map(|m| m.id).collect::<Vec<_>>()))?;
            let (model, thinking) = role_model(app, "orchestrator", None, None);
            Ok(Some(Prepared {
                turn,
                role: Role::Orchestrator,
                name: ORCHESTRATOR.into(),
                team: None,
                task: None,
                job: None,
                cwd: project_workspace(app, &project, "orchestrator"),
                session_id: format!("{slug}-orchestrator"),
                model,
                thinking,
                prompt: agent_prompt(app, &project, "orchestrator", None, false),
                message: orchestrator_message(&project, &mail),
                token: String::new(),
            }))
        }
        AgentKey::Member { project: slug, team, member } => {
            let t = app.with_tracker(slug, |t| t.bus().get(team))?;
            let Some(m) = t.members.iter().find(|m| &m.name == member).cloned() else { return Ok(None) };
            let role: Role = m.role.parse().map_err(AppError::Genie)?;
            let turn = app.with_server(|db| db.start_turn(slug, &label, Some(team), Some(member), None))?;
            let mail = app.with_tracker(slug, |t| t.bus().lease(Some(team), member, turn))?;
            if mail.is_empty() {
                app.with_server(|db| db.finish_turn(turn, "skipped", None, None, None))?;
                return Ok(None);
            }
            app.with_server(|db| db.set_turn_mail(turn, &mail.iter().map(|m| m.id).collect::<Vec<_>>()))?;
            app.with_tracker(slug, |t| t.bus().set_activity(team, member, "working", Some(json!({ "kind": "turn", "turn": turn }))))?;
            let (model, thinking) = role_model(app, &m.role, m.model.clone(), m.thinking.clone());
            let cwd = PathBuf::from(&t.cwd);
            Ok(Some(Prepared {
                turn,
                role,
                name: member.clone(),
                team: Some(team.clone()),
                task: Some(t.task.clone()),
                job: None,
                cwd: if cwd.is_dir() { cwd } else { project_workspace(app, &project, team) },
                session_id: m.session_file.clone().unwrap_or_else(|| format!("{team}-{member}").to_lowercase()),
                model,
                thinking,
                prompt: agent_prompt(app, &project, &m.role, m.instructions.as_deref(), false),
                message: member_message(&mail),
                token: String::new(),
            }))
        }
        AgentKey::Job { project: slug, job } => {
            let j = app.with_server(|db| {
                let j = db.job(*job)?;
                if j.status != "queued" {
                    return Ok(None);
                }
                db.start_job(*job)?;
                Ok(Some(j))
            })?;
            let Some(j) = j else { return Ok(None) };
            let role: Role = j.role.parse().map_err(AppError::Genie)?;
            let turn = app.with_server(|db| db.start_turn(slug, &label, None, None, Some(*job)))?;
            let (model, thinking) = role_model(app, &j.role, j.model.clone(), None);
            let cwd = match j.workspace.as_str() {
                "scratch" | "none" => {
                    let d = app.data.join("workspaces").join(slug).join(format!("job-{job}"));
                    let _ = std::fs::create_dir_all(&d);
                    d
                }
                _ => project_workspace(app, &project, "jobs"),
            };
            Ok(Some(Prepared {
                turn,
                role,
                name: format!("job-{job}"),
                team: None,
                task: j.task.clone(),
                job: Some(*job),
                cwd,
                // A job starts fresh on each attempt: no hidden state between retries.
                session_id: format!("{slug}-job-{job}-{}", j.attempts + 1),
                model,
                thinking,
                prompt: agent_prompt(app, &project, &j.role, None, false),
                message: job_message(&j),
                token: String::new(),
            }))
        }
    }
}

/// Launch the harness for a prepared turn and wait for it (with a timeout).
async fn execute(app: &Arc<App>, key: &AgentKey, p: &Prepared) -> Result<(Option<i32>, String), String> {
    let dir = app.data.join("runtime").join(key.project()).join(key.label().replace('/', "_"));
    tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
    let prompt_file = dir.join("prompt.md");
    tokio::fs::write(&prompt_file, &p.prompt).await.map_err(|e| e.to_string())?;
    let sessions = app.data.join("sessions").join(key.project());
    tokio::fs::create_dir_all(&sessions).await.map_err(|e| e.to_string())?;
    let token = p.token.clone();
    let readonly = config::role_excluded_tools(&app.data, p.role.as_str());
    let vars: HashMap<&str, String> = HashMap::from([
        ("sessionDir", sessions.to_string_lossy().into_owned()),
        ("sessionId", p.session_id.clone()),
        ("model", p.model.clone().unwrap_or_default()),
        ("thinking", p.thinking.clone().unwrap_or_default()),
        ("promptFile", prompt_file.to_string_lossy().into_owned()),
        ("message", p.message.clone()),
        ("readonlyTools", if matches!(key, AgentKey::Job { .. }) { String::new() } else { readonly.unwrap_or_default() }),
        ("cwd", p.cwd.to_string_lossy().into_owned()),
    ]);
    let argv = build_command(&app.cfg.runtime.command, &vars);
    let Some((program, args)) = argv.split_first() else { return Err("runtime.command is empty".into()) };
    let who = Identity { role: p.role, name: &p.name, team: p.team.as_deref(), task: p.task.as_deref(), job: p.job };
    let mut cmd = agent_command(app, program, args, &p.cwd, key.project(), &who, &token);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| format!("cannot start {program}: {e}"))?;
    if let Some(pid) = child.id() {
        let turn = p.turn;
        let _ = app.blocking(move |app| app.with_server(|db| db.set_turn_pid(turn, pid))).await;
    }
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let read = async {
        let (mut out, mut err) = (Vec::new(), Vec::new());
        if let Some(s) = stdout.as_mut() {
            let _ = s.read_to_end(&mut out).await;
        }
        if let Some(s) = stderr.as_mut() {
            let _ = s.read_to_end(&mut err).await;
        }
        (out, err)
    };
    let timeout = Duration::from_secs(app.cfg.runtime.turn_timeout_secs.max(1));
    let result = tokio::time::timeout(timeout, async {
        let (out, err) = read.await;
        let status = child.wait().await;
        (status, out, err)
    })
    .await;
    let (status, out, err) = match result {
        Ok(v) => v,
        Err(_) => return Err(format!("turn timed out after {}s", timeout.as_secs())),
    };
    let mut log = String::from_utf8_lossy(&out).into_owned();
    let err = String::from_utf8_lossy(&err);
    if !err.trim().is_empty() {
        log.push_str("\n--- stderr ---\n");
        log.push_str(&err);
    }
    let _ = tokio::fs::write(dir.join(format!("turn-{}.log", p.turn)), &log).await;
    let tail: String = log.chars().rev().take(4000).collect::<Vec<_>>().into_iter().rev().collect();
    Ok((status.map_err(|e| e.to_string())?.code(), tail))
}

/// Who an agent process is: its environment for `genie agent` and the extension.
pub(crate) struct Identity<'a> {
    pub role: Role,
    pub name: &'a str,
    pub team: Option<&'a str>,
    pub task: Option<&'a str>,
    pub job: Option<i64>,
}

/// The harness command with the agent's environment (`GENIE_URL`, `GENIE_TOKEN`…).
pub(crate) fn agent_command(
    app: &App,
    program: &str,
    args: &[String],
    cwd: &Path,
    project: &str,
    who: &Identity<'_>,
    token: &str,
) -> tokio::process::Command {
    let path = std::env::var("PATH").unwrap_or_default();
    let exe_dir = app.exe.parent().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default();
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args)
        .current_dir(cwd)
        .env("PATH", format!("{exe_dir}:{path}"))
        .env("GENIE_URL", format!("http://127.0.0.1:{}", app.cfg.port))
        .env("GENIE_TOKEN", token)
        .env("GENIE_PROJECT", project)
        .env("GENIE_AGENT_ROLE", who.role.as_str())
        .env("GENIE_AGENT_NAME", who.name)
        .env("GENIE_TASK", who.task.unwrap_or_default())
        .env("GENIE_TEAM", who.team.unwrap_or_default())
        .env("GENIE_JOB", who.job.map(|j| j.to_string()).unwrap_or_default())
        // Keep the TypeScript pi extension (if installed) out of server-run agents.
        .env("GENIE_ROLE", "off")
        .env_remove("GENIE_DIR");
    for (k, v) in &app.cfg.runtime.env {
        cmd.env(k, v);
    }
    cmd
}

/// What a live session runs as.
pub(crate) struct Spec {
    pub role: Role,
    pub name: String,
    pub team: Option<String>,
    pub task: Option<String>,
    pub cwd: PathBuf,
    pub session_id: String,
    pub model: Option<String>,
    pub thinking: Option<String>,
    pub prompt: String,
}

impl Spec {
    pub fn identity(&self) -> Identity<'_> {
        Identity { role: self.role, name: &self.name, team: self.team.as_deref(), task: self.task.as_deref(), job: None }
    }
}

/// The live session of an agent, or `None` when it should not run now (team
/// stopped, member removed or in error, orchestrator in manual mode, a job).
pub(crate) fn session_spec(app: &App, key: &AgentKey) -> AppResult<Option<Spec>> {
    let project = project_of(app, key.project())?;
    match key {
        AgentKey::Orchestrator { project: slug } => {
            if project.autonomy == "manual" {
                return Ok(None);
            }
            let (model, thinking) = role_model(app, "orchestrator", None, None);
            Ok(Some(Spec {
                role: Role::Orchestrator,
                name: ORCHESTRATOR.into(),
                team: None,
                task: None,
                cwd: project_workspace(app, &project, "orchestrator"),
                session_id: format!("{slug}-orchestrator"),
                model,
                thinking,
                prompt: agent_prompt(app, &project, "orchestrator", None, true),
            }))
        }
        AgentKey::Member { project: slug, team, member } => {
            let Ok(t) = app.with_tracker(slug, |t| t.bus().get(team)) else { return Ok(None) };
            let Some(m) = t.members.iter().find(|m| &m.name == member).cloned() else { return Ok(None) };
            if t.state != "active" || m.state != "active" {
                return Ok(None);
            }
            let role: Role = m.role.parse().map_err(AppError::Genie)?;
            let (model, thinking) = role_model(app, &m.role, m.model.clone(), m.thinking.clone());
            let cwd = PathBuf::from(&t.cwd);
            Ok(Some(Spec {
                role,
                name: member.clone(),
                team: Some(team.clone()),
                task: Some(t.task.clone()),
                cwd: if cwd.is_dir() { cwd } else { project_workspace(app, &project, team) },
                session_id: m.session_file.clone().unwrap_or_else(|| format!("{team}-{member}").to_lowercase()),
                model,
                thinking,
                prompt: agent_prompt(app, &project, &m.role, m.instructions.as_deref(), true),
            }))
        }
        AgentKey::Job { .. } => Ok(None),
    }
}

/// Expand argument groups; a group with an empty placeholder is dropped.
/// Single pass over the template, so text inside a substituted value (a
/// message mentioning `{model}`) is never expanded again.
pub fn build_command(groups: &[Vec<String>], vars: &HashMap<&str, String>) -> Vec<String> {
    let mut out = Vec::new();
    'group: for g in groups {
        let mut expanded = Vec::new();
        for arg in g {
            let mut s = String::new();
            let mut rest = arg.as_str();
            while let Some(start) = rest.find('{') {
                s.push_str(&rest[..start]);
                let after = &rest[start + 1..];
                match after.find('}').map(|end| (&after[..end], end)) {
                    Some((name, end)) if vars.contains_key(name) => {
                        let v = &vars[name];
                        if v.is_empty() {
                            continue 'group;
                        }
                        s.push_str(v);
                        rest = &after[end + 1..];
                    }
                    _ => {
                        s.push('{');
                        rest = after;
                    }
                }
            }
            s.push_str(rest);
            expanded.push(s);
        }
        out.extend(expanded);
    }
    out
}

#[allow(clippy::too_many_arguments)]
fn finish(
    app: &App,
    key: &AgentKey,
    p: &Prepared,
    ok: bool,
    code: Option<i32>,
    error: Option<&str>,
    log: &str,
    give_up: bool,
    max_attempts: u32,
) -> AppResult<()> {
    let slug = key.project();
    app.with_server(|db| db.finish_turn(p.turn, if ok { "succeeded" } else { "failed" }, code.map(i64::from), error, Some(log)))?;
    app.with_server(|db| db.revoke_token(&p.token))?;
    match key {
        AgentKey::Job { job, .. } => {
            let has_output = app.with_server(|db| db.job(*job))?.output.is_some();
            let ok = ok && has_output;
            let err = if !has_output && error.is_none() { Some("the agent finished without `genie agent output`") } else { error };
            app.with_server(|db| db.finish_job(*job, ok, err, i64::from(max_attempts)))?;
        }
        AgentKey::Orchestrator { .. } => {
            app.with_tracker(slug, |t| if ok { t.bus().complete_lease(p.turn) } else { t.bus().release_lease(p.turn) })?;
            if !ok && give_up {
                eprintln!(
                    "genie runtime: {slug}: the orchestrator failed {max_attempts} times in a row; retrying with backoff: {}",
                    error.unwrap_or("")
                );
            }
        }
        AgentKey::Member { team, member, .. } => {
            app.with_tracker(slug, |t| {
                let bus = t.bus();
                if ok {
                    bus.complete_lease(p.turn)?;
                    bus.set_activity(team, member, "idle", None)
                } else {
                    bus.release_lease(p.turn)?;
                    if give_up {
                        bus.set_activity(team, member, "error", None)?;
                        bus.log(team, "agent_error", json!({ "member": member, "error": error, "attempts": max_attempts }))?;
                        let tail: String = log.chars().rev().take(600).collect::<Vec<_>>().into_iter().rev().collect();
                        bus.notify_orchestrator(
                            "genie",
                            "system",
                            "system",
                            &format!(
                                "Member {member} of team {team} failed {max_attempts} turns in a row ({}). Its mail is kept. Restart it (`genie agent restart {team} {member}`) or replace it.\n{tail}",
                                error.unwrap_or("error")
                            ),
                            p.task.as_deref(),
                        )
                    } else {
                        bus.set_activity(team, member, "idle", None)
                    }
                }
            })?;
        }
    }
    Ok(())
}

// --- prompts -----------------------------------------------------------------

const TOOLS_TABLE: &str = r#"
Everything goes through the `genie agent` command (already configured for you: project, team, task and your identity come from the environment). Wherever the role guide above mentions a tool, use the command in this table:

| Role guide says | Command |
|---|---|
| `genie_task` show | `genie agent show [TASK]` (default: your task) |
| `genie_task` list / ready queue | `genie agent list [--status s1,s2] [--ready] [--epic ID]` |
| `genie_task` create | `genie agent create "title" [-d text] [-a criterion]... [--type task|bug|spike|epic] [--parent EPIC]` |
| `genie_task` update | `genie agent update [--task ID] [--title t] [-d text] [--plan text] [--append-notes text] [-a criterion]... [--dep ID]... [--merge-strategy text]` |
| `genie_task` status | `genie agent status <status> [--task ID] [--note text]` |
| `genie_task` comment | `genie agent comment "text" [--task ID] [--kind progress|question|decision|review|handoff|note]` |
| `genie_task` check | `genie agent check <N> [--task ID] [--undo]` |
| `genie_task` artifact | `genie agent artifact --kind K --name N (--file PATH | --text TEXT) [--task ID] [--note text]` |
| `artifact_read` | `genie agent artifact-read <N> [--task ID]` |
| `genie_task` split | `genie agent split "title 1" "title 2"... [--task ID]` |
| `genie_task` block / unblock | `genie agent block "reason" [--task ID]` / `genie agent unblock [--task ID]` |
| `team_send` | `genie agent send <name|orchestrator|all> "text" [--level low|normal|high] [--intent question|blocker|verdict|done|fyi] [--topic T] [--team T]` |
| `team_status` | `genie agent team [TEAM]` |
| `team_set_status` | `genie agent set-status "short status line"` |
| `team_spawn` (orchestrator) | `genie agent spawn <TASK> [--template standard|pair|full|research|spike|abap] [--note text]` |
| `team_stop` (orchestrator) | `genie agent stop-team <TEAM>` |
| `docs_search` / `docs_read` / `docs_note` | `genie agent docs search "query"` / `genie agent docs read <path>` / `genie agent docs write <path> --file F` |
| structured result of a job | `genie agent output '<json>'` |
"#;

/// How the agent acts in genie: the delivery model (live session or turns) and the command table.
fn tools_section(live: bool, orchestrator: bool, ask_timeout: u64) -> String {
    let mut out = String::from("\n## How you act in genie (server runtime)\n\n");
    if live {
        out.push_str(
            "You run as a live session. Team mail arrives in your conversation between your steps, as `[genie mail]` blocks with the most urgent first — read them when they appear and adjust your work.              A message marked INTERRUPT means your previous step was stopped for it: follow it first.              When there is nothing left to do, simply stop: new mail wakes you. Never sleep or poll for mail.\n",
        );
    } else {
        out.push_str(
            "You run in turns: each turn delivers your new messages; do the work they call for, then end the turn by finishing your reply. Teammates' answers arrive as a new turn — never wait or poll with sleep.\n",
        );
    }
    out.push_str(TOOLS_TABLE);
    if live {
        out.push_str(&format!(
            "\nTalking to the team:\n\n\
             | Need | Command |\n|---|---|\n\
             | ask and wait for the answer (up to {ask_timeout}s; a late answer arrives as mail) | `genie agent ask <name|orchestrator> \"question\" [--timeout S]` |\n\
             | answer a message, e.g. a question someone is waiting on | `genie agent reply <id> \"text\"` |\n\
             | full text of a clipped message | `genie agent mail <id>` |\n\
             | what a teammate is doing now (add `--deep` for its latest conversation) | `genie agent peek <name> [--deep]` |\n\
             | replace your earlier update on the same subject instead of adding one | `genie agent send … --topic <subject>` |\n\n\
             Keep messages short and point to the task, comments and artifacts for details; progress goes into the task, not into mail. Do not send acknowledgements.\n"
        ));
        if orchestrator {
            out.push_str(
                "\nDirecting the team (orchestrator):\n\n| Need | Command |\n|---|---|\n\
                 | every agent's state, current step and waiting mail | `genie agent board` |\n\
                 | correct an agent at its next step | `genie agent send <name> \"…\" --level high --team T` |\n\
                 | stop what it is doing now (aborts the running step, even a long command) | `genie agent interrupt <team> <name> \"what to do instead\"` |\n\
                 | hold an agent / let it go on | `genie agent pause <team> <name>` / `genie agent resume <team> <name>` |\n\n\
                 Peek before you interrupt; interrupt only when the current step is wrong or wasteful.\n",
            );
        }
    }
    out.push_str("\nRun `genie agent --help` for details. Output is plain text meant for you.\n");
    out
}

fn agent_prompt(app: &App, project: &Project, role: &str, instructions: Option<&str>, live: bool) -> String {
    let lang = &app.cfg.language;
    let mut out = config::role_prompt(&app.data, role);
    out.push_str(&tools_section(live, role == "orchestrator", app.cfg.runtime.ask_timeout_secs));
    out.push_str(&format!(
        "\n## Project\n\nProject `{}` ({}). {}\n\nLanguage: write tasks, comments, artifacts and team mail in {}; anything addressed to people (questions for the owner, needs_owner notes) in {}.\n",
        project.slug,
        project.name,
        if project.repo.is_some() { "It has a code repository." } else { "It has no code repository: deliver results as task artifacts and knowledge pages." },
        lang.internal,
        lang.user,
    ));
    if role == "orchestrator" {
        out.push_str("\n## Automations\n\nSome work is done by the project's automations (their comments and actions are signed `automation:<id>:<run>`). A task in `refining` with the comment \"Взята в разбор автоматически\" is being triaged by an automation: do not start another analysis for it — you will get a message when the author's answers are in. Automations also update the knowledge base and the changelog when a task is done.\n");
    }
    if let Some(i) = instructions.filter(|i| !i.trim().is_empty()) {
        out.push_str(&format!("\n## Instructions for you\n\n{i}\n"));
    }
    out
}

fn orchestrator_message(project: &Project, mail: &[Mail]) -> String {
    let verbatim: Vec<&Mail> = mail.iter().filter(|m| m.kind != "message").collect();
    let mut out = format!("[genie · project {} · orchestrator turn]\n", project.slug);
    for m in verbatim {
        out.push_str(&format!(
            "\n## {} from {}\n\n{}\n",
            if m.kind == "owner" { "Owner activity" } else { "System" },
            m.from,
            m.text.trim()
        ));
    }
    let digest = team::render_digest(mail);
    if !digest.is_empty() {
        out.push('\n');
        out.push_str(&digest);
        out.push('\n');
    }
    out.push_str("\nAct on these now (take inbox tasks, answer teams, dispatch ready work, accept approved work), then end your turn.");
    out
}

fn member_message(mail: &[Mail]) -> String {
    format!("{}\n\nAct on this now, then end your turn. Replies arrive as your next turn.", team::render_batch(mail))
}

fn job_message(j: &Job) -> String {
    let mut out = format!("[genie job {} · role {}]\n\n## Goal\n\n{}\n", j.id, j.role, j.goal.trim());
    if let Some(t) = &j.task {
        out.push_str(&format!("\nTask: {t} (read it with `genie agent show {t}`).\n"));
    }
    if !j.inputs.is_null() && j.inputs != json!({}) {
        out.push_str(&format!("\n## Inputs\n\n```json\n{}\n```\n", serde_json::to_string_pretty(&j.inputs).unwrap_or_default()));
    }
    match &j.output_schema {
        Some(schema) => out.push_str(&format!(
            "\n## Result\n\nWhen done, report your result exactly once with `genie agent output '<json>'`, a JSON object with this shape:\n\n```json\n{}\n```\n\nThe job fails if you finish without reporting a result.",
            serde_json::to_string_pretty(schema).unwrap_or_default()
        )),
        None => out.push_str("\n## Result\n\nWhen done, report a short summary with `genie agent output '{\"summary\": \"…\"}'`. The job fails if you finish without reporting a result."),
    }
    out
}

// --- team operations -----------------------------------------------------------

/// Worktree for a team: `git worktree add` on a fresh branch from HEAD.
fn create_worktree(app: &App, repo: &Path, team: &str, task: &str) -> AppResult<TeamWorktree> {
    let run = |dir: &Path, args: &[&str]| -> AppResult<String> {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .map_err(|e| AppError::Internal(format!("git: {e}")))?;
        if !out.status.success() {
            return Err(AppError::Internal(format!("git {}: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim())));
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    };
    let repo_name = repo.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "repo".into());
    let fill = |tpl: &str| {
        tpl.replace("{mainRoot}", &repo.to_string_lossy()).replace("{repo}", &repo_name).replace("{team}", team).replace("{task}", task)
    };
    let dir = PathBuf::from(fill(&app.cfg.worktrees.dir));
    let branch = fill(&app.cfg.worktrees.branch);
    let base = run(repo, &["rev-parse", "HEAD"])?;
    if dir.exists() {
        return Err(AppError::Internal(format!("worktree directory {} already exists", dir.display())));
    }
    if let Some(parent) = dir.parent() {
        std::fs::create_dir_all(parent).map_err(|e| AppError::Internal(e.to_string()))?;
    }
    let exists = run(repo, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]).is_ok();
    let dir_s = dir.to_string_lossy().into_owned();
    if exists {
        run(repo, &["worktree", "add", &dir_s, &branch])?;
    } else {
        run(repo, &["worktree", "add", "-b", &branch, &dir_s, &base])?;
    }
    Ok(TeamWorktree { path: dir_s, branch, base: Some(base) })
}

pub struct SpawnRequest {
    pub task: String,
    pub template: Option<String>,
    pub members: Vec<MemberSpec>,
    pub note: Option<String>,
    pub by: Actor,
}

const REFINEMENT_ROLES: &[&str] = &["analyst", "reviewer", "documenter"];

/// Assemble a team for a task: roster from the template, worktree when the
/// template asks for one and the project has a repository, kickoff mail.
pub fn spawn_team(app: &App, slug: &str, req: SpawnRequest) -> AppResult<genie_core::team::Team> {
    let project = project_of(app, slug)?;
    let template_name = req.template.clone().unwrap_or_else(|| "standard".into());
    let template = app.cfg.teams.get(&template_name).cloned();
    if template.is_none() && req.members.is_empty() {
        return Err(GenieError::invalid(format!("unknown team template {template_name}")).into());
    }
    let task = app.with_tracker(slug, |t| t.get(&req.task))?;
    let specs: Vec<MemberSpec> =
        if req.members.is_empty() { template.as_ref().map(|t| t.members.clone()).unwrap_or_default() } else { req.members.clone() };
    if specs.is_empty() {
        return Err(GenieError::invalid("a team needs at least one member").into());
    }
    let limits = &app.cfg.limits;
    if specs.len() > limits.max_members_per_team {
        return Err(GenieError::invalid(format!("limit: at most {} members per team", limits.max_members_per_team)).into());
    }
    let refinement = matches!(task.status, Status::Inbox | Status::Draft | Status::Refining);
    if task.task_type == genie_core::TaskType::Epic {
        return Err(GenieError::invalid("epics are not handed to teams; split it into tasks").into());
    }
    if CLOSED.contains(&task.status) {
        return Err(GenieError::invalid(format!("{} is {}", task.id, task.status)).into());
    }
    if refinement && specs.iter().any(|s| !REFINEMENT_ROLES.contains(&s.role.as_str())) {
        return Err(GenieError::invalid(format!(
            "{} is not ready ({}); before `ready` only analyst/reviewer/documenter teams (template research) may work on it",
            task.id, task.status
        ))
        .into());
    }
    if let Some(team) = &task.team
        && app.with_tracker(slug, |t| Ok(t.bus().exists(team)? && t.bus().get(team)?.state == "active"))?
    {
        return Err(GenieError::invalid(format!("{} already has an active team {team}", task.id)).into());
    }
    let active = app.with_tracker(slug, |t| t.bus().active_count())?;
    if active as usize >= limits.max_active_teams {
        return Err(
            GenieError::invalid(format!("limit: at most {} active teams per project; stop one first", limits.max_active_teams)).into()
        );
    }
    let team_id = app.with_tracker(slug, |t| t.bus().free_id(&task.id))?;
    let wants_worktree = template.as_ref().is_some_and(|t| t.worktree) && !refinement;
    let worktree = match (&project.repo, wants_worktree) {
        (Some(repo), true) => Some(create_worktree(app, Path::new(repo), &team_id, &task.id)?),
        _ => None,
    };
    let cwd = match (&worktree, &project.repo) {
        (Some(w), _) => w.path.clone(),
        (None, Some(repo)) => repo.clone(),
        (None, None) => project_workspace(app, &project, &team_id).to_string_lossy().into_owned(),
    };
    let mut taken = app.with_tracker(slug, |t| t.bus().taken_names())?;
    let members: Vec<NewMember> = specs
        .iter()
        .map(|s| NewMember {
            name: s.name.clone().unwrap_or_else(|| team::pick_name(&s.role, &mut taken)),
            role: s.role.clone(),
            model: s.model.clone(),
            thinking: s.thinking.clone(),
            instructions: s.instructions.clone(),
        })
        .collect();
    for m in &members {
        let role: Role = m.role.parse().map_err(AppError::Genie)?;
        if !genie_core::is_member_role(role) {
            return Err(GenieError::invalid(format!("{} is not a team role", m.role)).into());
        }
    }
    let system = Actor::new(req.by.name.clone(), if req.by.role == Role::Human { Role::Human } else { Role::Orchestrator });
    let created = app.with_tracker(slug, |t| {
        let team = t.bus().create(
            &req.by.name,
            req.by.role.as_str(),
            NewTeam {
                id: team_id.clone(),
                task: task.id.clone(),
                template: Some(template_name.clone()),
                cwd: cwd.clone(),
                worktree: worktree.clone(),
                members: members.clone(),
            },
        )?;
        let wt = worktree.as_ref().map(|w| genie_core::Worktree { path: w.path.clone(), branch: Some(w.branch.clone()) });
        let names: Vec<String> = members.iter().map(|m| m.name.clone()).collect();
        t.assign_team(&system, &task.id, Some(&team_id), wt.as_ref(), Some(&names))?;
        if matches!(task.status, Status::Inbox | Status::Draft) {
            t.set_status(
                &system,
                &task.id,
                Status::Refining,
                StatusOptions { note: Some(format!("research team {team_id} started")), force: true },
            )?;
        }
        let epic = t.epic_context(&task.id)?.epic;
        for m in &members {
            let text = kickoff(&team_id, &task, &cwd, worktree.as_ref(), &members, m, req.note.as_deref(), epic.as_ref());
            t.bus().send(team::SendMail {
                team: &team_id,
                from: ORCHESTRATOR,
                from_role: "orchestrator",
                to: &m.name,
                text: &text,
                level: Some("normal"),
                intent: None,
                kind: "kickoff",
                ..Default::default()
            })?;
        }
        Ok(team)
    })?;
    app.wake_runtime.notify_one();
    Ok(created)
}

/// The first message of a member. Port of `kickoff()` in `src/team/ops.ts`.
#[allow(clippy::too_many_arguments)]
pub fn kickoff(
    team: &str,
    task: &Task,
    cwd: &str,
    worktree: Option<&TeamWorktree>,
    all: &[NewMember],
    me: &NewMember,
    note: Option<&str>,
    epic: Option<&Task>,
) -> String {
    let has_analyst = all.iter().any(|m| m.role == "analyst");
    let tester = all.iter().find(|m| m.role == "tester");
    let notify = format!("message the reviewer{}", tester.map(|t| format!(" and the tester ({})", t.name)).unwrap_or_default());
    let refinement = !matches!(task.status, Status::Ready | Status::ChangesRequested | Status::InProgress | Status::Review);
    let first = match me.role.as_str() {
        "analyst" if refinement => "The task is not ready yet: research it, propose a precise description and verifiable acceptance criteria (genie agent update), write your findings as an `analysis` artifact, then report to the orchestrator.".to_string(),
        "analyst" => "Start now: analyse the task, save the plan (genie agent update --plan), then hand over to the executor with genie agent send.".to_string(),
        "executor" if has_analyst => format!("Wait for the analyst's handoff before implementing: set a waiting status (genie agent set-status) and end your turn without messaging anyone. When you start: status in_progress; when you hand over: commit, attach a test-report artifact, status review, then {notify}."),
        "executor" => format!("Start now: status in_progress, implement, commit, attach a test-report artifact, status review, then {notify}."),
        "reviewer" if refinement => "Challenge the analyst's findings: when the analyst shares them, check them for gaps and risks and send your feedback directly to the analyst.".to_string(),
        "reviewer" => "Wait until the executor asks for review: set a waiting status and end your turn without messaging anyone. When reviewing: check each verified criterion, attach one review artifact, set status approved or changes_requested, then message the executor (and the orchestrator on approval).".to_string(),
        "tester" => "Wait until the executor submits the work for review, then test it against the acceptance criteria, attach a test-report artifact and send the results to the executor and reviewer. If tests fail, set status changes_requested with a note.".to_string(),
        _ => "Wait until the implementation is approved or the orchestrator asks you, then write/update the documentation, attach a `doc` artifact and tell the orchestrator.".to_string(),
    };
    let roster = all.iter().map(|m| format!("{} — {} (`{}`)", team::display_name(&m.name), m.role, m.name)).collect::<Vec<_>>().join(", ");
    let mut out = vec![
        format!(
            "Welcome to team {team}, {}! You are the {}; teammates address you as \"{}\". Task: {} — {} (status {}). Read it with `genie agent show`.",
            team::display_name(&me.name),
            me.role,
            me.name,
            task.id,
            task.title,
            task.status
        ),
        match worktree {
            Some(w) => format!(
                "Working directory: {cwd} (branch {}, base {}).",
                w.branch,
                w.base.as_deref().unwrap_or("").chars().take(10).collect::<String>()
            ),
            None => format!("Working directory: {cwd}."),
        },
        format!("Team: {roster}, plus orchestrator."),
    ];
    if let Some(e) = epic {
        out.push(format!(
            "This task is part of epic {} — {}. Read its goal and shared artifacts (`genie agent show {}`) before you start, and attach material useful for the whole epic to the epic itself.",
            e.id, e.title, e.id
        ));
    }
    out.push(first);
    if let Some(n) = note.filter(|n| !n.trim().is_empty()) {
        out.push(format!("\nFrom the orchestrator: {n}"));
    }
    out.join("\n")
}

/// Stop a team: members stop receiving turns, agent tokens are revoked, the task is released.
pub fn stop_team(app: &App, slug: &str, team: &str, reason: &str, by: &str) -> AppResult<Vec<String>> {
    let mut report = Vec::new();
    app.with_tracker(slug, |t| {
        let tm = t.bus().get(team)?;
        t.bus().set_state(team, "stopped", Some(reason), by)?;
        report.push(format!("team {team} stopped ({reason})"));
        if let Ok(task) = t.get(&tm.task)
            && task.team.as_deref() == Some(team)
            && !CLOSED.contains(&task.status)
        {
            t.assign_team(&Actor::new(by, Role::Orchestrator), &task.id, None, None, None)?;
            report.push(format!("{} released", task.id));
        }
        if reason == "owner" {
            t.bus().notify_orchestrator(by, "human", "owner", &format!("The owner ({by}) stopped team {team}."), Some(&tm.task))?;
        }
        Ok(())
    })?;
    app.with_server(|db| db.revoke_agent_tokens(slug, Some(team), None))?;
    for s in app.sessions.all() {
        if s.key.project() == slug && s.team.as_deref() == Some(team) {
            crate::sessions::reset(app, &s.key);
        }
    }
    Ok(report)
}

/// Stop teams whose task is closed (from blocking code).
pub fn reap_closed_blocking(app: &App, slug: &str) -> AppResult<Vec<String>> {
    let closed: Vec<String> = app.with_tracker(slug, |t| {
        let mut out = Vec::new();
        for team in t.bus().list(false)? {
            if t.get(&team.task).map(|task| CLOSED.contains(&task.status)).unwrap_or(true) {
                out.push(team.id);
            }
        }
        Ok(out)
    })?;
    for team in &closed {
        stop_team(app, slug, team, "task_closed", "genie")?;
    }
    Ok(closed)
}

/// Stop teams whose task is closed.
pub async fn reap_closed(app: &Arc<App>, project: &str) {
    let slug = project.to_string();
    let res = app.blocking(move |app| reap_closed_blocking(app, &slug)).await;
    if let Err(e) = res {
        eprintln!("genie runtime: reap {project}: {e}");
    }
}

/// Let a member in `error` work again (its kept mail is offered on the next tick).
pub fn restart_member(app: &App, slug: &str, team: &str, member: &str) -> AppResult<()> {
    app.with_tracker(slug, |t| {
        t.bus().set_activity(team, member, "idle", None)?;
        t.bus().log(team, "member_restarted", json!({ "member": member }))
    })?;
    let key = AgentKey::Member { project: slug.to_string(), team: team.to_string(), member: member.to_string() };
    with_state(|s| {
        s.backoff.remove(&key);
    });
    crate::sessions::reset(app, &key);
    app.wake_runtime.notify_one();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn optional_groups_disappear_when_empty() {
        let groups: Vec<Vec<String>> = vec![
            vec!["pi".into(), "--print".into()],
            vec!["--model".into(), "{model}".into()],
            vec!["--session-id".into(), "{sessionId}".into()],
            vec!["{message}".into()],
        ];
        let vars = HashMap::from([("model", String::new()), ("sessionId", "s1".to_string()), ("message", "hi {model}".to_string())]);
        assert_eq!(build_command(&groups, &vars), vec!["pi", "--print", "--session-id", "s1", "hi {model}"]);
    }
}

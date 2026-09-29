//! `genie agent …`: how agents act in genie. A thin HTTP client of the server
//! using `GENIE_URL` and `GENIE_TOKEN` from the environment (set for every turn),
//! printing plain text meant for a language model. People can use it too with a
//! personal token (`genie user token <login>`).

use clap::Subcommand;
use serde_json::{Value, json};

#[derive(Subcommand)]
pub enum AgentCmd {
    /// Show a task (default: your task).
    Show { task: Option<String> },
    /// List tasks.
    List {
        #[arg(long)]
        status: Option<String>,
        #[arg(long)]
        ready: bool,
        #[arg(long)]
        epic: Option<String>,
        #[arg(long)]
        all: bool,
    },
    /// Create a task (agents create drafts).
    Create {
        title: String,
        #[arg(short = 'd', long, allow_hyphen_values = true)]
        description: Option<String>,
        #[arg(short = 'a', long = "ac")]
        acceptance: Vec<String>,
        #[arg(long = "type")]
        task_type: Option<String>,
        #[arg(long)]
        parent: Option<String>,
        #[arg(short = 'p', long)]
        priority: Option<i64>,
        #[arg(long = "dep")]
        deps: Vec<String>,
    },
    /// Update fields of a task.
    Update {
        #[arg(long)]
        task: Option<String>,
        #[arg(long)]
        title: Option<String>,
        #[arg(short = 'd', long, allow_hyphen_values = true)]
        description: Option<String>,
        #[arg(long, allow_hyphen_values = true)]
        plan: Option<String>,
        #[arg(long, allow_hyphen_values = true)]
        append_notes: Option<String>,
        #[arg(short = 'a', long = "ac")]
        acceptance: Vec<String>,
        #[arg(long = "rm-ac")]
        remove_acceptance: Vec<i64>,
        #[arg(long = "dep")]
        deps: Vec<String>,
        #[arg(long)]
        merge_strategy: Option<String>,
        /// The person responsible for the task: a login of the project ("none" to clear).
        #[arg(long)]
        assignee: Option<String>,
        #[arg(short = 'p', long)]
        priority: Option<i64>,
        /// Move into an epic ("none" to move out).
        #[arg(long)]
        parent: Option<String>,
    },
    /// Change the status of a task.
    Status {
        status: String,
        #[arg(long)]
        task: Option<String>,
        #[arg(long, short = 'm', allow_hyphen_values = true)]
        note: Option<String>,
        #[arg(long)]
        force: bool,
    },
    /// Comment on a task.
    Comment {
        #[arg(allow_hyphen_values = true)]
        text: String,
        #[arg(long)]
        task: Option<String>,
        #[arg(long, default_value = "note")]
        kind: String,
    },
    /// Tick (or untick) acceptance criterion N.
    Check {
        n: i64,
        #[arg(long)]
        task: Option<String>,
        #[arg(long)]
        undo: bool,
    },
    /// Attach an artifact.
    Artifact {
        #[arg(long, default_value = "other")]
        kind: String,
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        file: Option<std::path::PathBuf>,
        #[arg(long, allow_hyphen_values = true)]
        text: Option<String>,
        #[arg(long)]
        task: Option<String>,
        #[arg(long, allow_hyphen_values = true)]
        note: Option<String>,
    },
    /// Print artifact N of a task.
    ArtifactRead {
        n: i64,
        #[arg(long)]
        task: Option<String>,
    },
    /// Slice a task into children.
    Split {
        titles: Vec<String>,
        #[arg(long)]
        task: Option<String>,
    },
    /// Mark a task blocked.
    Block {
        #[arg(allow_hyphen_values = true)]
        reason: String,
        #[arg(long)]
        task: Option<String>,
    },
    Unblock {
        #[arg(long)]
        task: Option<String>,
    },
    /// Message a teammate, the orchestrator or `all`.
    Send {
        to: String,
        #[arg(allow_hyphen_values = true)]
        text: String,
        #[arg(long)]
        level: Option<String>,
        #[arg(long)]
        intent: Option<String>,
        /// Replace your undelivered message to the same recipient on this topic.
        #[arg(long)]
        topic: Option<String>,
        #[arg(long)]
        team: Option<String>,
    },
    /// Ask a teammate (or the orchestrator) and wait for the answer.
    Ask {
        to: String,
        #[arg(allow_hyphen_values = true)]
        question: String,
        /// Seconds to wait (default: the server's runtime.askTimeoutSecs).
        #[arg(long)]
        timeout: Option<u64>,
        #[arg(long)]
        team: Option<String>,
    },
    /// Answer message `id` (the asker gets it at once if still waiting).
    Reply {
        id: i64,
        #[arg(allow_hyphen_values = true)]
        text: String,
    },
    /// Full text of message `id`.
    Mail { id: i64 },
    /// What a teammate is doing now (`--deep`: its latest conversation too).
    Peek {
        member: String,
        #[arg(long)]
        deep: bool,
        #[arg(long)]
        team: Option<String>,
    },
    /// Every agent of the project: state, current step, waiting mail.
    Board,
    /// Stop an agent's current step and give it new instructions (orchestrator).
    Interrupt {
        team: String,
        member: String,
        #[arg(allow_hyphen_values = true)]
        text: String,
    },
    /// Hold an agent: its session stops, its mail waits (orchestrator).
    Pause { team: String, member: String },
    /// Let a paused agent work again (orchestrator).
    Resume { team: String, member: String },
    /// Team roster and recent mail.
    Team { team: Option<String> },
    /// Your short status line in the team card.
    SetStatus { text: String },
    /// Assemble a team for a task (orchestrator).
    Spawn {
        task: String,
        #[arg(long)]
        template: Option<String>,
        /// A member by role instead of the template's roster, `role` or `role:model` (repeatable).
        #[arg(long = "member")]
        members: Vec<String>,
        #[arg(long, allow_hyphen_values = true)]
        note: Option<String>,
    },
    /// Add a member to a running team (orchestrator).
    AddMember {
        team: String,
        role: String,
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        model: Option<String>,
        #[arg(long, allow_hyphen_values = true)]
        instructions: Option<String>,
    },
    /// Team templates available in this project.
    Templates,
    /// Roles available in this project.
    Roles,
    /// Stop a team (orchestrator).
    StopTeam { team: String },
    /// Let a member in error work again (orchestrator).
    Restart { team: String, member: String },
    /// Report the structured result of a one-shot job (JSON object).
    Output {
        #[arg(allow_hyphen_values = true)]
        json: String,
    },
    /// Project knowledge (vault).
    #[command(subcommand)]
    Docs(DocsCmd),
}

#[derive(Subcommand)]
pub enum DocsCmd {
    Search {
        query: String,
    },
    Read {
        path: String,
    },
    /// Write a page (respects the section's publishing policy).
    Write {
        path: String,
        #[arg(long)]
        file: Option<std::path::PathBuf>,
        #[arg(long, allow_hyphen_values = true)]
        text: Option<String>,
        #[arg(long, allow_hyphen_values = true)]
        note: Option<String>,
    },
    Tree,
}

struct Client {
    http: reqwest::Client,
    base: String,
    token: String,
}

impl Client {
    fn from_env() -> Result<Client, String> {
        let base = std::env::var("GENIE_URL").unwrap_or_else(|_| "http://127.0.0.1:7420".into());
        let token = std::env::var("GENIE_TOKEN")
            .map_err(|_| "GENIE_TOKEN is not set (agents get it from the runtime; people: genie user token <login>)".to_string())?;
        Ok(Client { http: reqwest::Client::new(), base: base.trim_end_matches('/').to_string(), token })
    }

    async fn call(&self, method: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
        let url = format!("{}/api{path}", self.base);
        let host = self.base.split("://").nth(1).unwrap_or("127.0.0.1:7420").split('/').next().unwrap_or_default().to_string();
        let mut req =
            self.http.request(method.parse().map_err(|_| "bad method".to_string())?, &url).bearer_auth(&self.token).header("host", host);
        if let Some(b) = body {
            req = req.json(&b);
        }
        let res = req.send().await.map_err(|e| format!("cannot reach genie at {}: {e}", self.base))?;
        let status = res.status();
        let v: Value = res.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            return Err(v["error"].as_str().map(str::to_string).unwrap_or_else(|| format!("HTTP {status}")));
        }
        Ok(v)
    }
}

fn my_task(t: Option<String>) -> Result<String, String> {
    t.or_else(|| std::env::var("GENIE_TASK").ok().filter(|s| !s.is_empty())).ok_or_else(|| "which task? pass it (or --task)".to_string())
}

fn my_team(t: Option<String>) -> Result<String, String> {
    t.or_else(|| std::env::var("GENIE_TEAM").ok().filter(|s| !s.is_empty())).ok_or_else(|| "which team? pass --team".to_string())
}

fn enc(s: &str) -> String {
    s.chars().map(|c| if c.is_ascii_alphanumeric() || "-_.~".contains(c) { c.to_string() } else { format!("%{:02X}", c as u32) }).collect()
}

/// Task as text for an agent. Port of the essentials of `src/tracker/render.ts`.
pub fn render_task(t: &Value) -> String {
    let s = |k: &str| t[k].as_str().unwrap_or_default().to_string();
    let mut out = vec![
        format!("# {} — {}", s("id"), s("title")),
        format!("type {} · status {} · priority P{}", s("type"), s("status"), t["priority"]),
    ];
    if let Some(p) = t["parent"].as_str() {
        out.push(format!("epic/parent: {p}"));
    }
    if let Some(team) = t["team"].as_str() {
        out.push(format!("team: {team}"));
    }
    if let Some(b) = t["blocked"].as_object() {
        out.push(format!("BLOCKED: {}", b.get("reason").and_then(Value::as_str).unwrap_or_default()));
    }
    if let Some(n) = t["needsOwner"].as_object() {
        out.push(format!("WAITING FOR THE OWNER: {}", n.get("question").and_then(Value::as_str).unwrap_or_default()));
    }
    if !s("mergeStrategy").is_empty() {
        out.push(format!("integration: {}", s("mergeStrategy")));
    }
    if let Some(a) = t["assignee"].as_str() {
        out.push(format!("person responsible: @{a} (mention them in a comment to reach them)"));
    }
    if let Some(e) = t["epic"].as_object() {
        out.push(format!(
            "\n## Epic {}: {}\n{}",
            e["id"].as_str().unwrap_or_default(),
            e["title"].as_str().unwrap_or_default(),
            e["description"].as_str().unwrap_or_default()
        ));
        if let Some(arts) = e["artifacts"].as_array().filter(|a| !a.is_empty()) {
            out.push("Shared artifacts of the epic (read with `genie agent artifact-read N --task EPIC`):".into());
            for a in arts {
                out.push(format!("- #{} [{}] {}", a["id"], a["kind"].as_str().unwrap_or_default(), a["name"].as_str().unwrap_or_default()));
            }
        }
    }
    out.push(format!("\n## Description\n{}", if s("description").is_empty() { "(empty)".into() } else { s("description") }));
    if let Some(ac) = t["acceptance"].as_array() {
        out.push(format!("\n## Acceptance criteria ({}/{})", ac.iter().filter(|a| a["done"] == json!(true)).count(), ac.len()));
        for a in ac {
            out.push(format!(
                "{}. [{}] {}",
                a["id"],
                if a["done"] == json!(true) { "x" } else { " " },
                a["text"].as_str().unwrap_or_default()
            ));
        }
    }
    if !s("plan").is_empty() {
        out.push(format!("\n## Plan\n{}", s("plan")));
    }
    if !s("notes").is_empty() {
        let notes = s("notes");
        let tail: String = notes.chars().rev().take(3000).collect::<Vec<_>>().into_iter().rev().collect();
        out.push(format!("\n## Notes{}\n{tail}", if notes.len() > tail.len() { " (latest)" } else { "" }));
    }
    if let Some(deps) = t["deps"].as_array().filter(|d| !d.is_empty()) {
        out.push(format!("\ndepends on: {}", deps.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", ")));
    }
    if let Some(ch) = t["children"].as_array().filter(|d| !d.is_empty()) {
        out.push(format!("children: {}", ch.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", ")));
    }
    if let Some(arts) = t["artifacts"].as_array().filter(|a| !a.is_empty()) {
        out.push("\n## Artifacts (read with `genie agent artifact-read N`)".into());
        for a in arts {
            out.push(format!(
                "- #{} [{}] {} by {} ({} bytes)",
                a["id"],
                a["kind"].as_str().unwrap_or_default(),
                a["name"].as_str().unwrap_or_default(),
                a["author"].as_str().unwrap_or_default(),
                a["size"]
            ));
        }
    }
    if let Some(cs) = t["comments"].as_array().filter(|a| !a.is_empty()) {
        out.push(format!("\n## Comments (latest {} of {})", cs.len().min(15), cs.len()));
        for c in cs.iter().rev().take(15).collect::<Vec<_>>().into_iter().rev() {
            out.push(format!(
                "- [{}] {} ({}): {}",
                c["kind"].as_str().unwrap_or_default(),
                c["author"].as_str().unwrap_or_default(),
                c["role"].as_str().unwrap_or_default(),
                c["text"].as_str().unwrap_or_default()
            ));
        }
    }
    out.join("\n")
}

fn render_list(v: &Value) -> String {
    let rows = v.as_array().cloned().unwrap_or_default();
    if rows.is_empty() {
        return "(no tasks)".into();
    }
    rows.iter()
        .map(|t| {
            format!(
                "{:<8} {:<18} P{} {}{}{}",
                t["id"].as_str().unwrap_or_default(),
                t["status"].as_str().unwrap_or_default(),
                t["priority"],
                if t["type"] == json!("epic") { "[epic] " } else { "" },
                t["title"].as_str().unwrap_or_default(),
                t["team"].as_str().map(|x| format!("  (team {x})")).unwrap_or_default()
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// A live session as text: state, current step, last words, recent activity.
fn render_session(s: &Value) -> Vec<String> {
    let mut out = Vec::new();
    let state = s["state"].as_str().unwrap_or("?");
    let since = s["since"].as_str().and_then(|t| t.get(11..19)).unwrap_or("");
    let mut head = format!("session {state} since {since}");
    if let Some(t) = s["tool"].as_object() {
        head.push_str(&format!(
            " · running {}: {}",
            t.get("name").and_then(Value::as_str).unwrap_or("tool"),
            t.get("args").and_then(Value::as_str).unwrap_or_default()
        ));
    }
    if let Some(n) = s["contextTokens"].as_u64() {
        head.push_str(&format!(" · context {}k tokens", n / 1000));
    }
    if s["failures"].as_u64().unwrap_or(0) > 0 {
        head.push_str(&format!(" · {} failed runs ({})", s["failures"], s["lastError"].as_str().unwrap_or_default()));
    }
    out.push(head);
    if let Some(t) = s["lastThinking"].as_str() {
        out.push(format!("thinking: {t}"));
    }
    if let Some(t) = s["lastText"].as_str() {
        out.push(format!("said: {t}"));
    }
    out
}

fn render_peek(v: &Value) -> String {
    let agent = v["agent"].as_str().unwrap_or_default();
    if v["session"].is_null() {
        return format!("{agent}: no live session (idle and stopped, or not started yet)");
    }
    let mut out = vec![format!("# {agent}")];
    out.extend(render_session(&v["session"]));
    if let Some(recent) = v["session"]["recent"].as_array().filter(|r| !r.is_empty()) {
        out.push("\nRecent activity:".into());
        out.extend(recent.iter().filter_map(Value::as_str).map(|l| format!("  {l}")));
    }
    if let Some(conv) = v["conversation"].as_array() {
        out.push("\nLatest conversation:".into());
        for m in conv {
            out.push(format!("[{}] {}", m["role"].as_str().unwrap_or("?"), m["text"].as_str().unwrap_or_default()));
        }
    }
    out.join("\n")
}

fn render_board(v: &Value) -> String {
    let mut out = vec![format!("agents ({} mode)", v["mode"].as_str().unwrap_or("?"))];
    for a in v["agents"].as_array().cloned().unwrap_or_default() {
        let mut line = format!("- {} ({})", a["agent"].as_str().unwrap_or_default(), a["role"].as_str().unwrap_or_default());
        if let Some(state) = a["state"].as_str().filter(|s| *s != "active") {
            line.push_str(&format!(" · {state}"));
        }
        let pending = a["pending"].as_u64().unwrap_or(0);
        if pending > 0 {
            line.push_str(&format!(" · {pending} waiting"));
        }
        if let Some(st) = a["status"].as_str().filter(|s| !s.is_empty()) {
            line.push_str(&format!(" · \"{st}\""));
        }
        out.push(line);
        if a["session"].is_object() {
            out.extend(render_session(&a["session"]).into_iter().map(|l| format!("    {l}")));
        }
    }
    out.join("\n")
}

fn summary(v: &Value) -> String {
    format!(
        "{} — {} · status {}",
        v["id"].as_str().unwrap_or_default(),
        v["title"].as_str().unwrap_or_default(),
        v["status"].as_str().unwrap_or_default()
    )
}

/// `-` means "read the value from stdin" (handy for long, multi-line text).
fn stdin_if_dash(v: Option<String>) -> Result<Option<String>, String> {
    match v.as_deref() {
        Some("-") => {
            let mut s = String::new();
            std::io::Read::read_to_string(&mut std::io::stdin(), &mut s).map_err(|e| e.to_string())?;
            Ok(Some(s))
        }
        _ => Ok(v),
    }
}

pub async fn run(cmd: AgentCmd) -> Result<(), String> {
    let c = Client::from_env()?;
    let out: String = match cmd {
        AgentCmd::Show { task } => render_task(&c.call("GET", &format!("/tasks/{}", enc(&my_task(task)?)), None).await?),
        AgentCmd::List { status, ready, epic, all } => {
            let mut q = vec![];
            if let Some(s) = status {
                q.push(format!("status={}", enc(&s)));
            }
            if ready {
                q.push("ready=1".into());
            }
            if let Some(e) = epic {
                q.push(format!("parent={}", enc(&e)));
            }
            if all {
                q.push("closed=1".into());
            }
            render_list(&c.call("GET", &format!("/tasks?{}", q.join("&")), None).await?)
        }
        AgentCmd::Create { title, description, acceptance, task_type, parent, priority, deps } => {
            let v = c
                .call("POST", "/tasks", Some(json!({ "title": title, "description": description, "acceptance": acceptance, "type": task_type, "parent": parent, "priority": priority, "deps": deps, "draft": true })))
                .await?;
            format!("created {}", summary(&v))
        }
        AgentCmd::Update {
            task,
            title,
            description,
            plan,
            append_notes,
            acceptance,
            remove_acceptance,
            deps,
            merge_strategy,
            assignee,
            priority,
            parent,
        } => {
            let mut body = json!({});
            let set = |b: &mut Value, k: &str, v: Option<Value>| {
                if let Some(v) = v {
                    b[k] = v;
                }
            };
            set(&mut body, "title", title.map(Value::from));
            set(&mut body, "description", description.map(Value::from));
            set(&mut body, "plan", plan.map(Value::from));
            set(&mut body, "appendNotes", append_notes.map(Value::from));
            set(&mut body, "mergeStrategy", merge_strategy.map(Value::from));
            set(&mut body, "priority", priority.map(Value::from));
            if !acceptance.is_empty() {
                body["addAcceptance"] = json!(acceptance);
            }
            if !remove_acceptance.is_empty() {
                body["removeAcceptance"] = json!(remove_acceptance);
            }
            if !deps.is_empty() {
                body["addDeps"] = json!(deps);
            }
            if let Some(p) = parent {
                body["parent"] = if p == "none" { Value::Null } else { json!(p) };
            }
            if let Some(a) = assignee {
                body["assignee"] = if a == "none" { Value::Null } else { json!(a) };
            }
            let v = c.call("PATCH", &format!("/tasks/{}", enc(&my_task(task)?)), Some(body)).await?;
            format!("updated {}", summary(&v))
        }
        AgentCmd::Status { status, task, note, force } => {
            let v = c
                .call(
                    "POST",
                    &format!("/tasks/{}/status", enc(&my_task(task)?)),
                    Some(json!({ "status": status, "note": note, "force": force })),
                )
                .await?;
            summary(&v)
        }
        AgentCmd::Comment { text, task, kind } => {
            c.call("POST", &format!("/tasks/{}/comments", enc(&my_task(task)?)), Some(json!({ "text": text, "kind": kind }))).await?;
            "comment added".into()
        }
        AgentCmd::Check { n, task, undo } => {
            c.call("POST", &format!("/tasks/{}/acceptance/{n}", enc(&my_task(task)?)), Some(json!({ "done": !undo }))).await?;
            format!("criterion #{n} {}", if undo { "unchecked" } else { "checked" })
        }
        AgentCmd::Artifact { kind, name, file, text, task, note } => {
            let mut body = json!({ "kind": kind, "name": name, "note": note });
            match (file, stdin_if_dash(text)?) {
                (Some(f), _) => {
                    let bytes = std::fs::read(&f).map_err(|e| format!("{}: {e}", f.display()))?;
                    if body["name"].is_null() {
                        body["name"] = json!(f.file_name().map(|n| n.to_string_lossy().into_owned()));
                    }
                    match String::from_utf8(bytes.clone()) {
                        Ok(s) => body["text"] = json!(s),
                        Err(_) => body["contentBase64"] = json!(base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes)),
                    }
                }
                (None, Some(t)) => body["text"] = json!(t),
                (None, None) => return Err("pass --file or --text".into()),
            }
            let v = c.call("POST", &format!("/tasks/{}/artifacts", enc(&my_task(task)?)), Some(body)).await?;
            let last = v["artifacts"].as_array().and_then(|a| a.last()).cloned().unwrap_or(Value::Null);
            format!("artifact #{} {} attached", last["id"], last["name"].as_str().unwrap_or_default())
        }
        AgentCmd::ArtifactRead { n, task } => {
            let v = c.call("GET", &format!("/tasks/{}/artifacts/{n}", enc(&my_task(task)?)), None).await?;
            match v["text"].as_str() {
                Some(t) => format!("# {} ({})\n\n{t}", v["name"].as_str().unwrap_or_default(), v["kind"].as_str().unwrap_or_default()),
                None => format!("# {} — binary, {} bytes (not shown)", v["name"].as_str().unwrap_or_default(), v["size"]),
            }
        }
        AgentCmd::Split { titles, task } => {
            let v = c.call("POST", &format!("/tasks/{}/split", enc(&my_task(task)?)), Some(json!({ "children": titles }))).await?;
            format!("created:\n{}", render_list(&v))
        }
        AgentCmd::Block { reason, task } => {
            c.call("POST", &format!("/tasks/{}/block", enc(&my_task(task)?)), Some(json!({ "reason": reason }))).await?;
            "blocked".into()
        }
        AgentCmd::Unblock { task } => {
            c.call("DELETE", &format!("/tasks/{}/block", enc(&my_task(task)?)), None).await?;
            "unblocked".into()
        }
        AgentCmd::Send { to, text, level, intent, topic, team } => {
            let team = my_team(team)?;
            c.call(
                "POST",
                &format!("/teams/{}/mail", enc(&team)),
                Some(json!({ "to": to, "text": text, "level": level, "intent": intent, "topic": topic })),
            )
            .await?;
            format!("sent to {to}")
        }
        AgentCmd::Ask { to, question, timeout, team } => {
            let team = team.or_else(|| std::env::var("GENIE_TEAM").ok().filter(|s| !s.is_empty()));
            let v = c.call("POST", "/agent/ask", Some(json!({ "to": to, "text": question, "team": team, "timeout": timeout }))).await?;
            match v["reply"].as_object() {
                Some(r) => format!(
                    "{} answered (#{}):\n{}",
                    r.get("from").and_then(Value::as_str).unwrap_or(&to),
                    r.get("id").and_then(Value::as_i64).unwrap_or_default(),
                    r.get("text").and_then(Value::as_str).unwrap_or_default()
                ),
                None => format!(
                    "No answer from {to} within {:.0}s (question #{}). Carry on with what you can; the answer will arrive as mail.",
                    v["waited"].as_f64().unwrap_or_default(),
                    v["asked"]
                ),
            }
        }
        AgentCmd::Reply { id, text } => {
            c.call("POST", "/agent/reply", Some(json!({ "id": id, "text": text }))).await?;
            format!("answered #{id}")
        }
        AgentCmd::Mail { id } => {
            let m = c.call("GET", &format!("/agent/mail/{id}"), None).await?;
            format!(
                "#{id} from {} ({}) to {} · {} · {}\n\n{}",
                m["from"].as_str().unwrap_or_default(),
                m["fromRole"].as_str().unwrap_or_default(),
                m["to"].as_str().unwrap_or_default(),
                m["level"].as_str().unwrap_or_default(),
                m["at"].as_str().unwrap_or_default(),
                m["text"].as_str().unwrap_or_default()
            )
        }
        AgentCmd::Peek { member, deep, team } => {
            let team = if member == "orchestrator" { "orchestrator".to_string() } else { my_team(team)? };
            let v =
                c.call("GET", &format!("/agents/{}/{}/peek{}", enc(&team), enc(&member), if deep { "?deep=1" } else { "" }), None).await?;
            render_peek(&v)
        }
        AgentCmd::Board => render_board(&c.call("GET", "/agents", None).await?),
        AgentCmd::Interrupt { team, member, text } => {
            c.call("POST", &format!("/teams/{}/mail", enc(&team)), Some(json!({ "to": member, "text": text, "level": "interrupt" })))
                .await?;
            format!("{member} is interrupted: its current step stops and your message comes first")
        }
        AgentCmd::Pause { team, member } => {
            c.call("POST", &format!("/agents/{}/{}/pause", enc(&team), enc(&member)), Some(json!({}))).await?;
            format!("{member} paused; its mail waits until `genie agent resume {team} {member}`")
        }
        AgentCmd::Resume { team, member } => {
            c.call("POST", &format!("/agents/{}/{}/resume", enc(&team), enc(&member)), Some(json!({}))).await?;
            format!("{member} resumed")
        }
        AgentCmd::Team { team } => {
            let v = c.call("GET", &format!("/teams/{}", enc(&my_team(team)?)), None).await?;
            let mut out = vec![format!(
                "team {} · task {} · {}",
                v["id"].as_str().unwrap_or_default(),
                v["task"].as_str().unwrap_or_default(),
                v["state"].as_str().unwrap_or_default()
            )];
            for m in v["members"].as_array().cloned().unwrap_or_default() {
                out.push(format!(
                    "- {} ({}) · {} · {}",
                    m["name"].as_str().unwrap_or_default(),
                    m["role"].as_str().unwrap_or_default(),
                    m["activity"].as_str().unwrap_or_default(),
                    m["status"].as_str().unwrap_or_default()
                ));
            }
            out.push("\nRecent mail:".into());
            for m in v["mail"].as_array().cloned().unwrap_or_default().iter().rev().take(10).collect::<Vec<_>>().into_iter().rev() {
                let text: String = m["text"].as_str().unwrap_or_default().chars().take(300).collect();
                out.push(format!("- {} → {}: {text}", m["from"].as_str().unwrap_or_default(), m["to"].as_str().unwrap_or_default()));
            }
            out.join("\n")
        }
        AgentCmd::SetStatus { text } => {
            c.call("POST", "/agent/status", Some(json!({ "text": text }))).await?;
            "status set".into()
        }
        AgentCmd::Spawn { task, template, members, note } => {
            let members: Vec<Value> = members
                .iter()
                .map(|m| match m.split_once(':') {
                    Some((role, model)) => json!({ "role": role, "model": model }),
                    None => json!({ "role": m }),
                })
                .collect();
            let v = c.call("POST", "/teams", Some(json!({ "task": task, "template": template, "members": members, "note": note }))).await?;
            let members: Vec<String> = v["members"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .iter()
                .map(|m| format!("{} ({})", m["name"].as_str().unwrap_or_default(), m["role"].as_str().unwrap_or_default()))
                .collect();
            format!(
                "team {} started for {}: {}",
                v["id"].as_str().unwrap_or_default(),
                v["task"].as_str().unwrap_or_default(),
                members.join(", ")
            )
        }
        AgentCmd::AddMember { team, role, name, model, instructions } => {
            let v = c
                .call(
                    "POST",
                    &format!("/teams/{}/members", enc(&team)),
                    Some(json!({ "role": role, "name": name, "model": model, "instructions": instructions })),
                )
                .await?;
            let m = v.as_array().and_then(|a| a.first()).cloned().unwrap_or(Value::Null);
            format!("{} ({}) joined team {team}", m["name"].as_str().unwrap_or_default(), m["role"].as_str().unwrap_or_default())
        }
        AgentCmd::Templates => {
            let v = c.call("GET", "/agent-config", None).await?;
            let mut out = Vec::new();
            for t in v["teams"].as_array().cloned().unwrap_or_default() {
                let roles: Vec<&str> =
                    t["members"].as_array().map(|m| m.iter().filter_map(|x| x["role"].as_str()).collect()).unwrap_or_default();
                out.push(format!(
                    "{} — {}
    {} · {} · {}",
                    t["id"].as_str().unwrap_or_default(),
                    t["description"].as_str().unwrap_or_default(),
                    t["stage"].as_str().unwrap_or_default(),
                    t["workspace"].as_str().unwrap_or_default(),
                    roles.join(", ")
                ));
                for r in t["relations"].as_array().cloned().unwrap_or_default() {
                    let to: Vec<&str> = r["to"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
                    out.push(format!(
                        "    {} {} {}{}{}",
                        r["from"].as_str().unwrap_or_default(),
                        r["type"].as_str().unwrap_or_default(),
                        to.join(", "),
                        r["on"].as_str().map(|s| format!(" on {s}")).unwrap_or_default(),
                        r["note"].as_str().map(|n| format!(" — {n}")).unwrap_or_default()
                    ));
                }
            }
            out.join(
                "
",
            )
        }
        AgentCmd::Roles => {
            let v = c.call("GET", "/agent-config", None).await?;
            v["roles"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .iter()
                .filter(|r| r["class"] != json!("orchestrator"))
                .map(|r| {
                    let class = r["class"].as_str().unwrap_or_default();
                    let id = r["id"].as_str().unwrap_or_default();
                    let stages: Vec<&str> =
                        r["stages"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
                    format!(
                        "{id}{} — {}
    stages: {} · files: {}",
                        if class == id { String::new() } else { format!(" ({class})") },
                        r["description"].as_str().unwrap_or_default(),
                        stages.join(", "),
                        r["files"].as_str().unwrap_or_default()
                    )
                })
                .collect::<Vec<_>>()
                .join(
                    "
",
                )
        }
        AgentCmd::StopTeam { team } => {
            let v = c.call("POST", &format!("/teams/{}/stop", enc(&team)), Some(json!({}))).await?;
            v["report"].as_array().map(|r| r.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("\n")).unwrap_or_default()
        }
        AgentCmd::Restart { team, member } => {
            c.call("POST", &format!("/teams/{}/members/{}/restart", enc(&team), enc(&member)), Some(json!({}))).await?;
            format!("{member} restarted")
        }
        AgentCmd::Output { json: raw } => {
            let v: Value = serde_json::from_str(&raw).map_err(|e| format!("output must be JSON: {e}"))?;
            c.call("POST", "/agent/output", Some(json!({ "output": v }))).await?;
            "result recorded".into()
        }
        AgentCmd::Docs(DocsCmd::Search { query }) => {
            let v = c.call("GET", &format!("/docs/search?q={}", enc(&query)), None).await?;
            let rows = v["results"].as_array().cloned().unwrap_or_default();
            if rows.is_empty() {
                "(nothing found)".into()
            } else {
                rows.iter()
                    .map(|r| {
                        format!(
                            "{} — {}\n    {}",
                            r["path"].as_str().unwrap_or_default(),
                            r["title"].as_str().unwrap_or_default(),
                            r["snippet"].as_str().unwrap_or_default()
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            }
        }
        AgentCmd::Docs(DocsCmd::Read { path }) => {
            let v = c.call("GET", &format!("/docs/page?path={}", enc(&path)), None).await?;
            v["content"].as_str().unwrap_or_default().to_string()
        }
        AgentCmd::Docs(DocsCmd::Tree) => {
            let v = c.call("GET", "/docs/tree", None).await?;
            v["pages"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .iter()
                .map(|p| format!("{} — {}", p["path"].as_str().unwrap_or_default(), p["title"].as_str().unwrap_or_default()))
                .collect::<Vec<_>>()
                .join("\n")
        }
        AgentCmd::Docs(DocsCmd::Write { path, file, text, note }) => {
            let content = match (file, stdin_if_dash(text)?) {
                (Some(f), _) => std::fs::read_to_string(&f).map_err(|e| format!("{}: {e}", f.display()))?,
                (None, Some(t)) => t,
                (None, None) => return Err("pass --file or --text".into()),
            };
            let v = c.call("POST", "/docs/page", Some(json!({ "path": path, "content": content, "note": note, "mode": "upsert" }))).await?;
            match v["proposal"].as_i64() {
                Some(id) => format!("proposal #{id} created for {path}: the section needs a review, the owner decides"),
                None => format!("{path} saved"),
            }
        }
    };
    println!("{out}");
    Ok(())
}

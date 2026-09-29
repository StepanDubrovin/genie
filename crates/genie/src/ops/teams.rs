//! Teams of agents, and the result of a one-shot job.

use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Value, json};

use super::{Cx, Entry, Need, Op, Out, enc, register, render};

pub fn register(all: &mut Vec<Entry>) {
    register!(
        all,
        Show,
        List,
        Board,
        Peek,
        Spawn,
        AddMember,
        RemoveMember,
        Stop,
        Delete,
        Restart,
        Pause,
        Resume,
        Interrupt,
        SetStatus,
        Templates,
        Roles,
        Output
    );
}

/// A team: its members and what they do, and recent mail (default: your team).
#[derive(clap::Args, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Show {
    pub team: Option<String>,
    /// How many recent messages to show.
    #[arg(long, default_value_t = 10)]
    #[serde(default = "ten")]
    pub mail: usize,
}

fn ten() -> usize {
    10
}

impl Op for Show {
    const GROUP: &'static str = "team";
    const NAME: &'static str = "show";
    const LEGACY: Option<&'static str> = Some("team");
    async fn run(self, cx: &Cx) -> Result<Out, String> {
        let v = cx.call("GET", &format!("/teams/{}", enc(&cx.team(self.team)?)), None).await?;
        Ok(Out::new(render::team(&v, self.mail), v))
    }
}

/// Teams of the project: active ones, or all with --all.
#[derive(clap::Args, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct List {
    #[arg(long)]
    #[serde(default)]
    pub all: bool,
}

impl Op for List {
    const GROUP: &'static str = "team";
    const NAME: &'static str = "list";
    async fn run(self, cx: &Cx) -> Result<Out, String> {
        let v = cx.call("GET", if self.all { "/teams?all=1" } else { "/teams" }, None).await?;
        Ok(Out::new(render::teams(&v), v))
    }
}

/// Every agent of the project: its state, current step and waiting mail.
#[derive(clap::Args, Deserialize, JsonSchema)]
pub struct Board {}

impl Op for Board {
    const GROUP: &'static str = "team";
    const NAME: &'static str = "board";
    const LEGACY: Option<&'static str> = Some("board");
    async fn run(self, cx: &Cx) -> Result<Out, String> {
        let v = cx.call("GET", "/agents", None).await?;
        Ok(Out::new(render::agents(&v), v))
    }
}

/// What an agent is doing now; --deep adds its latest conversation.
#[derive(clap::Args, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Peek {
    /// A member of the team, or `orchestrator`.
    pub member: String,
    #[arg(long)]
    #[serde(default)]
    pub deep: bool,
    #[arg(long)]
    pub team: Option<String>,
}

impl Op for Peek {
    const GROUP: &'static str = "team";
    const NAME: &'static str = "peek";
    const LEGACY: Option<&'static str> = Some("peek");
    async fn run(self, cx: &Cx) -> Result<Out, String> {
        let team = if self.member == "orchestrator" { "orchestrator".to_string() } else { cx.team(self.team)? };
        let deep = if self.deep { "?deep=1" } else { "" };
        let v = cx.call("GET", &format!("/agents/{}/{}/peek{deep}", enc(&team), enc(&self.member)), None).await?;
        Ok(Out::new(render::peek(&v), v))
    }
}

/// Assemble a team for a task from a template, or member by member (orchestrator).
#[derive(clap::Args, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Spawn {
    pub task: String,
    /// A team template (`genie team templates`).
    #[arg(long)]
    pub template: Option<String>,
    /// A member by role instead of the template's roster: `role` or `role:model`; repeat for more.
    #[arg(long = "member")]
    #[serde(default)]
    pub members: Vec<String>,
    /// What the team should know from you.
    #[arg(long, allow_hyphen_values = true)]
    pub note: Option<String>,
}

impl Op for Spawn {
    const GROUP: &'static str = "team";
    const NAME: &'static str = "spawn";
    const LEGACY: Option<&'static str> = Some("spawn");
    const NEED: Need = Need::Orchestrator;
    async fn run(self, cx: &Cx) -> Result<Out, String> {
        let members: Vec<Value> = self
            .members
            .iter()
            .map(|m| match m.split_once(':') {
                Some((role, model)) => json!({ "role": role, "model": model }),
                None => json!({ "role": m }),
            })
            .collect();
        let v = cx
            .call("POST", "/teams", Some(json!({ "task": self.task, "template": self.template, "members": members, "note": self.note })))
            .await?;
        let names: Vec<String> = v["members"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .map(|m| format!("{} ({})", m["name"].as_str().unwrap_or_default(), m["role"].as_str().unwrap_or_default()))
            .collect();
        let text = format!(
            "team {} started for {}: {}",
            v["id"].as_str().unwrap_or_default(),
            v["task"].as_str().unwrap_or_default(),
            names.join(", ")
        );
        Ok(Out::new(text, v))
    }
}

/// Add a member to a running team (orchestrator).
#[derive(clap::Args, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AddMember {
    pub team: String,
    /// A role (`genie team roles`).
    pub role: String,
    #[arg(long)]
    pub name: Option<String>,
    #[arg(long)]
    pub model: Option<String>,
    #[arg(long, allow_hyphen_values = true)]
    pub instructions: Option<String>,
}

impl Op for AddMember {
    const GROUP: &'static str = "team";
    const NAME: &'static str = "add-member";
    const LEGACY: Option<&'static str> = Some("add-member");
    const NEED: Need = Need::Orchestrator;
    async fn run(self, cx: &Cx) -> Result<Out, String> {
        let body = json!({ "role": self.role, "name": self.name, "model": self.model, "instructions": self.instructions });
        let v = cx.call("POST", &format!("/teams/{}/members", enc(&self.team)), Some(body)).await?;
        let m = v.as_array().and_then(|a| a.first()).cloned().unwrap_or(Value::Null);
        let text =
            format!("{} ({}) joined team {}", m["name"].as_str().unwrap_or_default(), m["role"].as_str().unwrap_or_default(), self.team);
        Ok(Out::new(text, v))
    }
}

/// Stop a member and take it out of the team (orchestrator).
#[derive(clap::Args, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RemoveMember {
    pub team: String,
    pub member: String,
}

impl Op for RemoveMember {
    const GROUP: &'static str = "team";
    const NAME: &'static str = "remove-member";
    const NEED: Need = Need::Orchestrator;
    async fn run(self, cx: &Cx) -> Result<Out, String> {
        let v = cx.call("DELETE", &format!("/teams/{}/members/{}", enc(&self.team), enc(&self.member)), None).await?;
        Ok(Out::new(format!("{} left team {}", self.member, self.team), v))
    }
}

fn report(v: &Value) -> String {
    v["report"].as_array().map(|r| r.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("\n")).unwrap_or_default()
}

/// Stop a team: its members stop, the task is released if still open (orchestrator).
#[derive(clap::Args, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Stop {
    pub team: String,
    /// Also remove the team's worktree.
    #[arg(long)]
    #[serde(default)]
    pub remove_worktree: bool,
}

impl Op for Stop {
    const GROUP: &'static str = "team";
    const NAME: &'static str = "stop";
    const LEGACY: Option<&'static str> = Some("stop-team");
    const NEED: Need = Need::Orchestrator;
    async fn run(self, cx: &Cx) -> Result<Out, String> {
        let v =
            cx.call("POST", &format!("/teams/{}/stop", enc(&self.team)), Some(json!({ "removeWorktree": self.remove_worktree }))).await?;
        Ok(Out::new(report(&v), v))
    }
}

/// Stop a team and delete it with its mail (orchestrator).
#[derive(clap::Args, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Delete {
    pub team: String,
    /// Also remove the team's worktree.
    #[arg(long)]
    #[serde(default)]
    pub remove_worktree: bool,
}

impl Op for Delete {
    const GROUP: &'static str = "team";
    const NAME: &'static str = "delete";
    const NEED: Need = Need::Orchestrator;
    async fn run(self, cx: &Cx) -> Result<Out, String> {
        let q = if self.remove_worktree { "?removeWorktree=1" } else { "" };
        let v = cx.call("DELETE", &format!("/teams/{}{q}", enc(&self.team)), None).await?;
        Ok(Out::new(report(&v), v))
    }
}

/// Let a member in error work again (orchestrator).
#[derive(clap::Args, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Restart {
    pub team: String,
    pub member: String,
}

impl Op for Restart {
    const GROUP: &'static str = "team";
    const NAME: &'static str = "restart";
    const LEGACY: Option<&'static str> = Some("restart");
    const NEED: Need = Need::Orchestrator;
    async fn run(self, cx: &Cx) -> Result<Out, String> {
        let v = cx.call("POST", &format!("/teams/{}/members/{}/restart", enc(&self.team), enc(&self.member)), Some(json!({}))).await?;
        Ok(Out::new(format!("{} restarted", self.member), v))
    }
}

/// Hold an agent: its session stops, its mail waits (orchestrator).
#[derive(clap::Args, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Pause {
    pub team: String,
    pub member: String,
}

impl Op for Pause {
    const GROUP: &'static str = "team";
    const NAME: &'static str = "pause";
    const LEGACY: Option<&'static str> = Some("pause");
    const NEED: Need = Need::Orchestrator;
    async fn run(self, cx: &Cx) -> Result<Out, String> {
        let v = cx.call("POST", &format!("/agents/{}/{}/pause", enc(&self.team), enc(&self.member)), Some(json!({}))).await?;
        Ok(Out::new(format!("{} paused; its mail waits until `genie team resume {} {}`", self.member, self.team, self.member), v))
    }
}

/// Let a paused agent work again (orchestrator).
#[derive(clap::Args, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Resume {
    pub team: String,
    pub member: String,
}

impl Op for Resume {
    const GROUP: &'static str = "team";
    const NAME: &'static str = "resume";
    const LEGACY: Option<&'static str> = Some("resume");
    const NEED: Need = Need::Orchestrator;
    async fn run(self, cx: &Cx) -> Result<Out, String> {
        let v = cx.call("POST", &format!("/agents/{}/{}/resume", enc(&self.team), enc(&self.member)), Some(json!({}))).await?;
        Ok(Out::new(format!("{} resumed", self.member), v))
    }
}

/// Stop an agent's current step and give it new instructions (orchestrator).
#[derive(clap::Args, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Interrupt {
    pub team: String,
    pub member: String,
    #[arg(allow_hyphen_values = true)]
    pub text: String,
}

impl Op for Interrupt {
    const GROUP: &'static str = "team";
    const NAME: &'static str = "interrupt";
    const LEGACY: Option<&'static str> = Some("interrupt");
    const NEED: Need = Need::Orchestrator;
    async fn run(self, cx: &Cx) -> Result<Out, String> {
        let body = json!({ "to": self.member, "text": self.text, "level": "interrupt" });
        let v = cx.call("POST", &format!("/teams/{}/mail", enc(&self.team)), Some(body)).await?;
        Ok(Out::new(format!("{} is interrupted: its current step stops and your message comes first", self.member), v))
    }
}

/// Your short status line in the team card.
#[derive(clap::Args, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SetStatus {
    #[arg(allow_hyphen_values = true)]
    pub text: String,
}

impl Op for SetStatus {
    const GROUP: &'static str = "team";
    const NAME: &'static str = "set-status";
    const LEGACY: Option<&'static str> = Some("set-status");
    const NEED: Need = Need::Member;
    async fn run(self, cx: &Cx) -> Result<Out, String> {
        let v = cx.call("POST", "/agent/status", Some(json!({ "text": self.text }))).await?;
        Ok(Out::new("status set", v))
    }
}

/// Team templates of the project: members, how they hand work over.
#[derive(clap::Args, Deserialize, JsonSchema)]
pub struct Templates {}

impl Op for Templates {
    const GROUP: &'static str = "team";
    const NAME: &'static str = "templates";
    const LEGACY: Option<&'static str> = Some("templates");
    async fn run(self, cx: &Cx) -> Result<Out, String> {
        let v = cx.call("GET", "/agent-config", None).await?;
        let mut out = Vec::new();
        for t in v["teams"].as_array().cloned().unwrap_or_default() {
            let roles: Vec<&str> =
                t["members"].as_array().map(|m| m.iter().filter_map(|x| x["role"].as_str()).collect()).unwrap_or_default();
            out.push(format!(
                "{} — {}\n    {} · {} · {}",
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
        Ok(Out::new(out.join("\n"), v["teams"].clone()))
    }
}

/// Roles of the project that can join a team.
#[derive(clap::Args, Deserialize, JsonSchema)]
pub struct Roles {}

impl Op for Roles {
    const GROUP: &'static str = "team";
    const NAME: &'static str = "roles";
    const LEGACY: Option<&'static str> = Some("roles");
    async fn run(self, cx: &Cx) -> Result<Out, String> {
        let v = cx.call("GET", "/agent-config", None).await?;
        let text = v["roles"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .filter(|r| r["class"] != json!("orchestrator"))
            .map(|r| {
                let class = r["class"].as_str().unwrap_or_default();
                let id = r["id"].as_str().unwrap_or_default();
                let stages: Vec<&str> = r["stages"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
                format!(
                    "{id}{} — {}\n    stages: {} · files: {}",
                    if class == id { String::new() } else { format!(" ({class})") },
                    r["description"].as_str().unwrap_or_default(),
                    stages.join(", "),
                    r["files"].as_str().unwrap_or_default()
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        Ok(Out::new(text, v["roles"].clone()))
    }
}

/// Report the structured result of a one-shot job: a JSON object.
#[derive(clap::Args, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Output {
    /// The result: a JSON object (its text on the command line, `-` reads stdin).
    #[arg(allow_hyphen_values = true, value_name = "JSON")]
    #[serde(deserialize_with = "json_text")]
    #[schemars(with = "serde_json::Map<String, Value>")]
    pub result: String,
}

/// JSON given as text (the command line) or as itself (MCP).
fn json_text<'de, D: serde::Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    Ok(match Value::deserialize(d)? {
        Value::String(s) => s,
        v => v.to_string(),
    })
}

impl Op for Output {
    const GROUP: &'static str = "job";
    const NAME: &'static str = "output";
    const LEGACY: Option<&'static str> = Some("output");
    const NEED: Need = Need::Job;
    async fn run(self, cx: &Cx) -> Result<Out, String> {
        let text = cx.text(Some(self.result), None)?.unwrap_or_default();
        let v: Value = serde_json::from_str(&text).map_err(|e| format!("the output must be JSON: {e}"))?;
        let r = cx.call("POST", "/agent/output", Some(json!({ "output": v }))).await?;
        Ok(Out::new("result recorded", r))
    }
}

//! Automations of a project: rules that react to events, schedules and webhooks, and their runs.

use std::path::PathBuf;

use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Value, json};

use super::{Cx, Entry, Need, Op, Out, register};

pub fn register(all: &mut Vec<Entry>) {
    register!(all, List, Show, Create, Update, Delete, Enable, Disable, Run, Playbooks, Install, Runs, RunShow, Cancel);
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or_default()
}

/// What starts it: an event of the journal, a schedule, a webhook, or people only.
fn trigger(a: &Value) -> String {
    let on = &a["spec"]["on"];
    if let Some(e) = on["event"].as_str() {
        e.to_string()
    } else if let Some(cron) = on["schedule"].as_str() {
        format!("schedule {cron}{}", on["tz"].as_str().map(|tz| format!(" {tz}")).unwrap_or_default())
    } else if !on["webhook"].is_null() {
        "webhook".into()
    } else {
        "manual".into()
    }
}

fn line(a: &Value) -> String {
    let last = &a["lastRun"];
    format!(
        "#{:<4} {:<7} {}{}  on {}{}",
        a["id"].to_string(),
        if a["enabled"] == json!(true) { "enabled" } else { "off" },
        s(a, "name"),
        if a["dryRun"] == json!(true) { " (dry run)" } else { "" },
        trigger(a),
        if last.is_null() { String::new() } else { format!(" · last run #{} {} {}", last["id"], s(last, "status"), s(last, "started")) }
    )
}

fn run_line(r: &Value) -> String {
    format!(
        "run #{:<5} automation #{} {:<10} {}{}",
        r["id"].to_string(),
        r["automation"],
        s(r, "status"),
        s(r, "started"),
        r["error"].as_str().map(|e| format!(" — {e}")).unwrap_or_default()
    )
}

/// An automation's spec: JSON given inline (`-` reads stdin) or read from a file (command line only).
fn spec(cx: &Cx, inline: Option<String>, file: Option<PathBuf>) -> Result<Value, String> {
    let text = cx.text(inline, file)?.ok_or("pass the spec as --spec JSON (or --file on the command line)")?;
    serde_json::from_str(&text).map_err(|e| format!("the spec must be JSON: {e}"))
}

/// Automations of the project and their last runs.
#[derive(clap::Args, Deserialize, JsonSchema)]
pub struct List {}

impl Op for List {
    const GROUP: &'static str = "automation";
    const NAME: &'static str = "list";
    async fn run(self, cx: &Cx) -> Result<Out, String> {
        let v = cx.call("GET", "/automations", None).await?;
        let rows = v.as_array().cloned().unwrap_or_default();
        let text = if rows.is_empty() {
            "no automations; see `genie automation playbooks`".into()
        } else {
            rows.iter().map(line).collect::<Vec<_>>().join("\n")
        };
        Ok(Out::new(text, v))
    }
}

/// An automation: its spec and recent runs.
#[derive(clap::Args, Deserialize, JsonSchema)]
pub struct Show {
    pub id: i64,
}

impl Op for Show {
    const GROUP: &'static str = "automation";
    const NAME: &'static str = "show";
    async fn run(self, cx: &Cx) -> Result<Out, String> {
        let v = cx.call("GET", &format!("/automations/{}", self.id), None).await?;
        let a = &v["automation"];
        let mut out = vec![line(a), format!("version {} · by {} · updated {}", a["version"], s(a, "createdBy"), s(a, "updated"))];
        out.push(serde_json::to_string_pretty(&a["spec"]).unwrap_or_default());
        let runs = v["runs"].as_array().cloned().unwrap_or_default();
        if !runs.is_empty() {
            out.push("\nRuns:".into());
            out.extend(runs.iter().take(10).map(run_line));
        }
        Ok(Out::new(out.join("\n"), v))
    }
}

/// Create an automation from its spec: `name`, `on` (an event, a schedule or a webhook), `steps` (project admins; see `genie automation playbooks`).
#[derive(clap::Args, Deserialize, JsonSchema)]
pub struct Create {
    /// The spec as JSON.
    #[arg(long, allow_hyphen_values = true, value_name = "JSON")]
    #[serde(default, deserialize_with = "super::opt_json_text")]
    #[schemars(with = "Option<serde_json::Map<String, Value>>")]
    pub spec: Option<String>,
    /// Read the spec from a file (command line only).
    #[arg(long)]
    #[serde(skip)]
    #[schemars(skip)]
    pub file: Option<PathBuf>,
}

impl Op for Create {
    const GROUP: &'static str = "automation";
    const NAME: &'static str = "create";
    const NEED: Need = Need::Admin;
    async fn run(self, cx: &Cx) -> Result<Out, String> {
        let a = cx.call("POST", "/automations", Some(json!({ "spec": spec(cx, self.spec, self.file)? }))).await?;
        Ok(Out::new(format!("created {}", line(&a)), a))
    }
}

/// Replace an automation's spec; its runs keep the version they started with (project admins).
#[derive(clap::Args, Deserialize, JsonSchema)]
pub struct Update {
    pub id: i64,
    /// The whole new spec as JSON.
    #[arg(long, allow_hyphen_values = true, value_name = "JSON")]
    #[serde(default, deserialize_with = "super::opt_json_text")]
    #[schemars(with = "Option<serde_json::Map<String, Value>>")]
    pub spec: Option<String>,
    #[arg(long)]
    #[serde(skip)]
    #[schemars(skip)]
    pub file: Option<PathBuf>,
}

impl Op for Update {
    const GROUP: &'static str = "automation";
    const NAME: &'static str = "update";
    const NEED: Need = Need::Admin;
    async fn run(self, cx: &Cx) -> Result<Out, String> {
        let a = cx.call("PUT", &format!("/automations/{}", self.id), Some(json!({ "spec": spec(cx, self.spec, self.file)? }))).await?;
        Ok(Out::new(format!("updated {}", line(&a)), a))
    }
}

/// Delete an automation (project admins).
#[derive(clap::Args, Deserialize, JsonSchema)]
pub struct Delete {
    pub id: i64,
}

impl Op for Delete {
    const GROUP: &'static str = "automation";
    const NAME: &'static str = "delete";
    const NEED: Need = Need::Admin;
    async fn run(self, cx: &Cx) -> Result<Out, String> {
        let v = cx.call("DELETE", &format!("/automations/{}", self.id), None).await?;
        Ok(Out::new(format!("automation #{} deleted", self.id), v))
    }
}

/// Turn an automation on (project admins).
#[derive(clap::Args, Deserialize, JsonSchema)]
pub struct Enable {
    pub id: i64,
}

impl Op for Enable {
    const GROUP: &'static str = "automation";
    const NAME: &'static str = "enable";
    const NEED: Need = Need::Admin;
    async fn run(self, cx: &Cx) -> Result<Out, String> {
        let a = cx.call("POST", &format!("/automations/{}/enabled", self.id), Some(json!({ "enabled": true }))).await?;
        Ok(Out::new(line(&a), a))
    }
}

/// Turn an automation off (project admins).
#[derive(clap::Args, Deserialize, JsonSchema)]
pub struct Disable {
    pub id: i64,
}

impl Op for Disable {
    const GROUP: &'static str = "automation";
    const NAME: &'static str = "disable";
    const NEED: Need = Need::Admin;
    async fn run(self, cx: &Cx) -> Result<Out, String> {
        let a = cx.call("POST", &format!("/automations/{}/enabled", self.id), Some(json!({ "enabled": false }))).await?;
        Ok(Out::new(line(&a), a))
    }
}

/// Run an automation now, for a task or with inputs (`--input key=value`).
#[derive(clap::Args, Deserialize, JsonSchema)]
pub struct Run {
    pub id: i64,
    #[arg(long)]
    pub task: Option<String>,
    /// key=value; repeat for more.
    #[arg(long = "input")]
    #[serde(default)]
    pub inputs: Vec<String>,
}

impl Op for Run {
    const GROUP: &'static str = "automation";
    const NAME: &'static str = "run";
    const NEED: Need = Need::Write;
    async fn run(self, cx: &Cx) -> Result<Out, String> {
        let mut body = Value::Object(super::pairs(&self.inputs, "--input")?);
        if let Some(t) = self.task {
            body["task"] = json!(t);
        }
        let r = cx.call("POST", &format!("/automations/{}/run", self.id), Some(body)).await?;
        let text =
            if r.is_null() { "not started: the automation's conditions do not match".into() } else { format!("started {}", run_line(&r)) };
        Ok(Out::new(text, r))
    }
}

/// Ready-made automations to install.
#[derive(clap::Args, Deserialize, JsonSchema)]
pub struct Playbooks {}

impl Op for Playbooks {
    const GROUP: &'static str = "automation";
    const NAME: &'static str = "playbooks";
    async fn run(self, cx: &Cx) -> Result<Out, String> {
        let v = cx.call("GET", "/automations/playbooks", None).await?;
        let text = v
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .map(|p| format!("{:<24} {}", s(p, "id"), s(p, "title")))
            .collect::<Vec<_>>()
            .join("\n");
        Ok(Out::new(text, v))
    }
}

/// Install a playbook as an automation of the project (project admins).
#[derive(clap::Args, Deserialize, JsonSchema)]
pub struct Install {
    pub playbook: String,
}

impl Op for Install {
    const GROUP: &'static str = "automation";
    const NAME: &'static str = "install";
    const NEED: Need = Need::Admin;
    async fn run(self, cx: &Cx) -> Result<Out, String> {
        let a = cx.call("POST", &format!("/automations/playbooks/{}", super::enc(&self.playbook)), Some(json!({}))).await?;
        Ok(Out::new(format!("installed {}", line(&a)), a))
    }
}

/// Recent runs of the project's automations (or of one with --automation).
#[derive(clap::Args, Deserialize, JsonSchema)]
pub struct Runs {
    #[arg(long)]
    pub automation: Option<i64>,
    #[arg(long, default_value_t = 30)]
    #[serde(default = "thirty")]
    pub limit: i64,
}

fn thirty() -> i64 {
    30
}

impl Op for Runs {
    const GROUP: &'static str = "automation";
    const NAME: &'static str = "runs";
    async fn run(self, cx: &Cx) -> Result<Out, String> {
        let a = self.automation.map(|a| format!("&automation={a}")).unwrap_or_default();
        let v = cx.call("GET", &format!("/runs?limit={}{a}", self.limit), None).await?;
        let rows = v.as_array().cloned().unwrap_or_default();
        let text = if rows.is_empty() { "no runs".into() } else { rows.iter().map(run_line).collect::<Vec<_>>().join("\n") };
        Ok(Out::new(text, v))
    }
}

/// A run and its steps.
#[derive(clap::Args, Deserialize, JsonSchema)]
pub struct RunShow {
    pub run: i64,
}

impl Op for RunShow {
    const GROUP: &'static str = "automation";
    const NAME: &'static str = "run-show";
    async fn run(self, cx: &Cx) -> Result<Out, String> {
        let r = cx.call("GET", &format!("/runs/{}", self.run), None).await?;
        let mut out = vec![run_line(&r)];
        for st in r["steps"].as_array().cloned().unwrap_or_default() {
            out.push(format!(
                "  {}. {:<10} {} ({}){}{}",
                st["idx"],
                s(&st, "status"),
                s(&st, "stepId"),
                s(&st, "kind"),
                if st["attempt"].as_i64().unwrap_or(1) > 1 { format!(" · attempt {}", st["attempt"]) } else { String::new() },
                st["error"].as_str().map(|e| format!(" — {e}")).unwrap_or_default()
            ));
        }
        Ok(Out::new(out.join("\n"), r))
    }
}

/// Stop a run and the jobs it waits for.
#[derive(clap::Args, Deserialize, JsonSchema)]
pub struct Cancel {
    pub run: i64,
}

impl Op for Cancel {
    const GROUP: &'static str = "automation";
    const NAME: &'static str = "cancel";
    const NEED: Need = Need::Write;
    async fn run(self, cx: &Cx) -> Result<Out, String> {
        let v = cx.call("POST", &format!("/runs/{}/cancel", self.run), Some(json!({}))).await?;
        Ok(Out::new(format!("run #{} cancelled", self.run), v))
    }
}

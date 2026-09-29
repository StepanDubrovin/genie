//! Mail between the members of a team, the orchestrator and people.

use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Value, json};

use super::{Cx, Entry, Need, Op, Out, enc, register, render};

pub fn register(all: &mut Vec<Entry>) {
    register!(all, Send, Ask, Reply, Read, List);
}

/// Message a teammate, the orchestrator or `all` of your team.
#[derive(clap::Args, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Send {
    /// A member of the team, `orchestrator` or `all`.
    pub to: String,
    #[arg(allow_hyphen_values = true)]
    pub text: String,
    /// low, normal or high; people and the orchestrator also `interrupt`.
    #[arg(long)]
    pub level: Option<String>,
    /// Same as --level high.
    #[arg(long)]
    #[serde(default)]
    pub urgent: bool,
    /// question, blocker, verdict, done or fyi.
    #[arg(long)]
    pub intent: Option<String>,
    /// Replaces your undelivered message to the same recipient on this topic.
    #[arg(long)]
    pub topic: Option<String>,
    /// The team (default: yours).
    #[arg(long)]
    pub team: Option<String>,
}

impl Op for Send {
    const GROUP: &'static str = "mail";
    const NAME: &'static str = "send";
    const LEGACY: Option<&'static str> = Some("send");
    const NEED: Need = Need::Write;
    async fn run(self, cx: &Cx) -> Result<Out, String> {
        let team = cx.team(self.team)?;
        let body = json!({ "to": self.to, "text": self.text, "level": self.level, "urgent": self.urgent, "intent": self.intent, "topic": self.topic });
        let v = cx.call("POST", &format!("/teams/{}/mail", enc(&team)), Some(body)).await?;
        let to: Vec<&str> = match v.as_array() {
            Some(a) => a.iter().filter_map(|m| m["to"].as_str()).collect(),
            None => v["to"].as_str().into_iter().collect(),
        };
        let to = if to.is_empty() { self.to.clone() } else { to.join(", ") };
        Ok(Out::new(format!("sent to {to}"), v))
    }
}

/// Ask a teammate or the orchestrator and wait for the answer.
#[derive(clap::Args, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Ask {
    /// A member of your team or `orchestrator`.
    pub to: String,
    #[arg(allow_hyphen_values = true)]
    pub question: String,
    /// Seconds to wait (default: the server's runtime.askTimeoutSecs).
    #[arg(long)]
    pub timeout: Option<u64>,
    #[arg(long)]
    pub team: Option<String>,
}

impl Op for Ask {
    const GROUP: &'static str = "mail";
    const NAME: &'static str = "ask";
    const LEGACY: Option<&'static str> = Some("ask");
    const NEED: Need = Need::Member;
    async fn run(self, cx: &Cx) -> Result<Out, String> {
        let team = self.team.or_else(|| cx.team.clone());
        let v = cx
            .call("POST", "/agent/ask", Some(json!({ "to": self.to, "text": self.question, "team": team, "timeout": self.timeout })))
            .await?;
        let text = match v["reply"].as_object() {
            Some(r) => format!(
                "{} answered (#{}):\n{}",
                r.get("from").and_then(Value::as_str).unwrap_or(&self.to),
                r.get("id").and_then(Value::as_i64).unwrap_or_default(),
                r.get("text").and_then(Value::as_str).unwrap_or_default()
            ),
            None => format!(
                "No answer from {} within {:.0}s (question #{}). Carry on with what you can; the answer will arrive as mail.",
                self.to,
                v["waited"].as_f64().unwrap_or_default(),
                v["asked"]
            ),
        };
        Ok(Out::new(text, v))
    }
}

/// Answer message `id`; the asker gets it at once if it still waits.
#[derive(clap::Args, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Reply {
    pub id: i64,
    #[arg(allow_hyphen_values = true)]
    pub text: String,
}

impl Op for Reply {
    const GROUP: &'static str = "mail";
    const NAME: &'static str = "reply";
    const LEGACY: Option<&'static str> = Some("reply");
    const NEED: Need = Need::Write;
    async fn run(self, cx: &Cx) -> Result<Out, String> {
        let v = cx.call("POST", "/agent/reply", Some(json!({ "id": self.id, "text": self.text }))).await?;
        Ok(Out::new(format!("answered #{}", self.id), v))
    }
}

/// The full text of message `id`.
#[derive(clap::Args, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Read {
    pub id: i64,
}

impl Op for Read {
    const GROUP: &'static str = "mail";
    const NAME: &'static str = "read";
    const LEGACY: Option<&'static str> = Some("mail");
    async fn run(self, cx: &Cx) -> Result<Out, String> {
        let m = cx.call("GET", &format!("/agent/mail/{}", self.id), None).await?;
        let s = |k: &str| m[k].as_str().unwrap_or_default().to_string();
        let text =
            format!("#{} from {} ({}) to {} · {} · {}\n\n{}", self.id, s("from"), s("fromRole"), s("to"), s("level"), s("at"), s("text"));
        Ok(Out::new(text, m))
    }
}

/// The mail of a team, oldest first (default: your team).
#[derive(clap::Args, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct List {
    pub team: Option<String>,
    /// How many recent messages.
    #[arg(short = 'n', long, default_value_t = 30)]
    #[serde(default = "thirty")]
    pub n: usize,
}

fn thirty() -> usize {
    30
}

impl Op for List {
    const GROUP: &'static str = "mail";
    const NAME: &'static str = "list";
    async fn run(self, cx: &Cx) -> Result<Out, String> {
        let v = cx.call("GET", &format!("/teams/{}", enc(&cx.team(self.team)?)), None).await?;
        let all = v["mail"].as_array().cloned().unwrap_or_default();
        let last = all[all.len().saturating_sub(self.n)..].to_vec();
        Ok(Out::new(render::mail(&last), Value::Array(last)))
    }
}

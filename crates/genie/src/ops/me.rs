//! The caller: who they are, a person's notifications and the questions agents
//! asked them (the web's bell and answer page).

use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Value, json};

use super::{Cx, Entry, Need, Op, Out, register};

pub fn register(all: &mut Vec<Entry>) {
    register!(all, Show, Notifications, Read, Questions, Answer);
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or_default()
}

/// Who you are to the server: a person and their projects, or an agent and its project and team.
#[derive(clap::Args, Deserialize, JsonSchema)]
pub struct Show {}

impl Op for Show {
    const GROUP: &'static str = "me";
    const NAME: &'static str = "show";
    async fn run(self, cx: &Cx) -> Result<Out, String> {
        let v = cx.call("GET", "/auth/me", None).await?;
        if !v["agent"].is_null() {
            let a = &v["agent"];
            let text = format!(
                "agent {} ({}) of project {}{}",
                s(a, "name"),
                s(a, "role"),
                s(a, "project"),
                a["team"].as_str().map(|t| format!(", team {t}")).unwrap_or_default()
            );
            return Ok(Out::new(text, v));
        }
        let u = &v["user"];
        let mut out = vec![format!(
            "{} ({}){}{}",
            s(u, "login"),
            s(u, "name"),
            if u["isAdmin"] == json!(true) { " · server admin" } else { "" },
            if s(&v, "mode") == "local" { " · on the server's machine" } else { "" }
        )];
        for p in v["projects"].as_array().cloned().unwrap_or_default() {
            out.push(format!(
                "  {} {:<16} {:<8} {}",
                if v["project"] == p["slug"] { "*" } else { " " },
                s(&p, "slug"),
                s(&p, "role"),
                s(&p, "name")
            ));
        }
        Ok(Out::new(out.join("\n"), v))
    }
}

/// Your notifications: unread ones, or all recent with --all.
#[derive(clap::Args, Deserialize, JsonSchema)]
pub struct Notifications {
    #[arg(long)]
    #[serde(default)]
    pub all: bool,
}

impl Op for Notifications {
    const GROUP: &'static str = "me";
    const NAME: &'static str = "notifications";
    const NEED: Need = Need::Person;
    async fn run(self, cx: &Cx) -> Result<Out, String> {
        let v = cx.call("GET", if self.all { "/notifications" } else { "/notifications?unread=1" }, None).await?;
        let mut out = Vec::new();
        for n in v["items"].as_array().cloned().unwrap_or_default() {
            out.push(format!(
                "#{:<5} {}{} {}{}",
                n["id"].to_string(),
                if n["readAt"].is_null() { "● " } else { "" },
                s(&n, "created"),
                n["project"].as_str().map(|p| format!("[{p}] ")).unwrap_or_default(),
                s(&n, "title")
            ));
            for line in s(&n, "body").lines().filter(|l| !l.trim().is_empty()) {
                out.push(format!("       {line}"));
            }
        }
        let text = if out.is_empty() {
            if self.all { "no notifications".to_string() } else { "nothing unread".to_string() }
        } else {
            out.push(format!("{} unread", v["unread"]));
            out.join("\n")
        };
        Ok(Out::new(text, v))
    }
}

/// Mark a notification read, or all of them without --id.
#[derive(clap::Args, Deserialize, JsonSchema)]
pub struct Read {
    #[arg(long)]
    pub id: Option<i64>,
}

impl Op for Read {
    const GROUP: &'static str = "me";
    const NAME: &'static str = "read";
    const NEED: Need = Need::Person;
    async fn run(self, cx: &Cx) -> Result<Out, String> {
        let v = cx.call("POST", "/notifications/read", Some(json!({ "id": self.id }))).await?;
        Ok(Out::new(self.id.map_or("all notifications read".into(), |id| format!("notification #{id} read")), v))
    }
}

fn questionnaire(q: &Value) -> Vec<String> {
    let mut out = vec![format!(
        "#{} {} · {}{} · asked by {}{}",
        q["id"],
        s(q, "status"),
        s(q, "project"),
        q["task"].as_str().map(|t| format!(" {t}")).unwrap_or_default(),
        s(q, "askedBy"),
        q["due"].as_str().map(|d| format!(" · due {d}")).unwrap_or_default()
    )];
    for qu in q["questions"].as_array().cloned().unwrap_or_default() {
        out.push(format!("  {}. {}", qu["n"], s(&qu, "text")));
        if !s(&qu, "why").is_empty() {
            out.push(format!("     why: {}", s(&qu, "why")));
        }
        let options: Vec<&str> = qu["options"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
        if !options.is_empty() {
            out.push(format!("     options: {}", options.join(" | ")));
        }
        if let Some(a) = qu["answer"].as_str() {
            out.push(format!("     → {a}"));
        }
    }
    out
}

/// Questions agents and automations asked you and are waiting for.
#[derive(clap::Args, Deserialize, JsonSchema)]
pub struct Questions {}

impl Op for Questions {
    const GROUP: &'static str = "me";
    const NAME: &'static str = "questions";
    const NEED: Need = Need::Person;
    async fn run(self, cx: &Cx) -> Result<Out, String> {
        let v = cx.call("GET", "/questions", None).await?;
        let rows = v.as_array().cloned().unwrap_or_default();
        let text = if rows.is_empty() {
            "no questions waiting for you".to_string()
        } else {
            rows.iter().flat_map(questionnaire).collect::<Vec<_>>().join("\n")
        };
        Ok(Out::new(text, v))
    }
}

/// Answer questions you were asked: `<n>=<answer>` for each (see `genie me questions`).
#[derive(clap::Args, Deserialize, JsonSchema)]
pub struct Answer {
    /// The questionnaire's number.
    pub questionnaire: i64,
    /// `<question number>=<answer>`; repeat for more.
    #[arg(required = true, allow_hyphen_values = true, value_name = "N=ANSWER")]
    pub answers: Vec<String>,
}

impl Op for Answer {
    const GROUP: &'static str = "me";
    const NAME: &'static str = "answer";
    const NEED: Need = Need::Person;
    async fn run(self, cx: &Cx) -> Result<Out, String> {
        let answers = super::pairs(&self.answers, "answer")?;
        let v = cx.call("POST", &format!("/questions/{}/answer", self.questionnaire), Some(json!({ "answers": answers }))).await?;
        let mut out = questionnaire(&v["questionnaire"]);
        out.push(if v["complete"] == json!(true) {
            "all answered: the answers went to the task".into()
        } else {
            "saved; some questions are still open".into()
        });
        Ok(Out::new(out.join("\n"), v))
    }
}

//! The catalog of genie operations: every action a person or an agent takes in
//! genie, described once and served through two entrances — the `genie` command
//! line and the genie MCP server — and listed in the role prompts.
//!
//! An operation is a struct of its arguments: clap reads it from the command
//! line, serde from an MCP call, and schemars gives MCP its JSON schema. Its
//! handler calls the server's HTTP API ([`api::Api`]) — over the network with a
//! token, or inside the server's process — and renders the answer as text for
//! people and language models. The API checks every right; the catalog only
//! describes and renders.

use std::future::Future;
use std::path::PathBuf;
use std::sync::OnceLock;

use clap::{ArgMatches, Command};
use futures_util::future::BoxFuture;
use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use serde_json::Value;

mod admin;
pub mod api;
mod docs;
mod mail;
pub mod render;
mod tasks;
mod teams;

pub use api::{Api, Auth, InProcess, Remote};

/// Who an operation is for. The API decides every call; this only keeps an
/// operation out of the lists of those who cannot use it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Need {
    /// Anyone with access to the project.
    Read,
    /// People who write in the project, and agents whose role allows it.
    Write,
    /// The orchestrator and people.
    Orchestrator,
    /// A member of a team (its own status line, replies).
    Member,
    /// A one-shot job of an automation.
    Job,
    /// People who administer the server or a project; never agents.
    Admin,
}

/// What an operation gives back: text for people and models, the API's data for scripts.
#[derive(Debug, Clone)]
pub struct Out {
    pub text: String,
    pub data: Value,
}

impl Out {
    pub fn new(text: impl Into<String>, data: Value) -> Out {
        Out { text: text.into(), data }
    }
}

/// Where an operation runs: its way to the API and the caller's defaults.
pub struct Cx {
    pub api: Box<dyn Api>,
    /// The project the caller named (`--project`), if any; the API acts in it.
    pub project: Option<String>,
    /// The caller's own task and team (an agent's), for operations that omit them.
    pub task: Option<String>,
    pub team: Option<String>,
    /// The caller's files and stdin are at hand (the command line); not over MCP.
    pub local: bool,
}

impl Cx {
    pub async fn call(&self, method: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
        self.api.call(method, path, body).await
    }

    /// The task an operation is about: the given one, else the caller's own.
    pub fn task(&self, task: Option<String>) -> Result<String, String> {
        task.or_else(|| self.task.clone()).filter(|t| !t.is_empty()).ok_or_else(|| "which task? pass it".to_string())
    }

    /// The team an operation is about: the given one, else the caller's own.
    pub fn team(&self, team: Option<String>) -> Result<String, String> {
        team.or_else(|| self.team.clone()).filter(|t| !t.is_empty()).ok_or_else(|| "which team? pass --team".to_string())
    }

    /// Text given inline, as `-` (stdin) or as a file: the last two only on the command line.
    pub fn text(&self, inline: Option<String>, file: Option<PathBuf>) -> Result<Option<String>, String> {
        if let Some(f) = file {
            if !self.local {
                return Err("files are read only on the command line; pass the text itself".into());
            }
            return std::fs::read_to_string(&f).map(Some).map_err(|e| format!("{}: {e}", f.display()));
        }
        match inline.as_deref() {
            Some("-") if self.local => {
                let mut s = String::new();
                std::io::Read::read_to_string(&mut std::io::stdin(), &mut s).map_err(|e| e.to_string())?;
                Ok(Some(s))
            }
            _ => Ok(inline),
        }
    }
}

/// An operation of the catalog.
pub trait Op: clap::Args + DeserializeOwned + JsonSchema + Send + Sized + 'static {
    /// `genie <GROUP> <NAME>` on the command line; tool `genie_<GROUP>`, action `NAME` over MCP.
    const GROUP: &'static str;
    const NAME: &'static str;
    /// The command under `genie agent …` before the catalog, kept working for older prompts.
    const LEGACY: Option<&'static str> = None;
    const NEED: Need = Need::Read;
    fn run(self, cx: &Cx) -> impl Future<Output = Result<Out, String>> + Send;
}

type RunCli = for<'a> fn(&'a ArgMatches, &'a Cx) -> BoxFuture<'a, Result<Out, String>>;
type RunJson = for<'a> fn(Value, &'a Cx) -> BoxFuture<'a, Result<Out, String>>;

/// An operation as the entrances see it.
pub struct Entry {
    pub group: &'static str,
    pub name: &'static str,
    pub legacy: Option<&'static str>,
    pub need: Need,
    /// What it does: the doc comment of its arguments.
    pub about: String,
    /// JSON schema of its arguments.
    pub schema: Value,
    augment: fn(Command) -> Command,
    run_cli: RunCli,
    run_json: RunJson,
}

fn run_cli<'a, T: Op>(m: &'a ArgMatches, cx: &'a Cx) -> BoxFuture<'a, Result<Out, String>> {
    match T::from_arg_matches(m) {
        Ok(args) => Box::pin(args.run(cx)),
        Err(e) => Box::pin(async move { Err(e.to_string()) }),
    }
}

fn run_json<'a, T: Op>(args: Value, cx: &'a Cx) -> BoxFuture<'a, Result<Out, String>> {
    match serde_json::from_value::<T>(args) {
        Ok(args) => Box::pin(args.run(cx)),
        Err(e) => Box::pin(async move { Err(format!("invalid arguments: {e}")) }),
    }
}

impl Entry {
    fn of<T: Op>() -> Entry {
        let mut schema = schemars::schema_for!(T).to_value();
        let about = schema.get("description").and_then(Value::as_str).unwrap_or_default().to_string();
        if let Some(o) = schema.as_object_mut() {
            for k in ["$schema", "title", "description"] {
                o.remove(k);
            }
        }
        Entry {
            group: T::GROUP,
            name: T::NAME,
            legacy: T::LEGACY,
            need: T::NEED,
            about,
            schema,
            augment: <T as clap::Args>::augment_args,
            run_cli: run_cli::<T>,
            run_json: run_json::<T>,
        }
    }

    /// The first line of what it does.
    pub fn summary(&self) -> &str {
        self.about.lines().next().unwrap_or_default()
    }

    /// Its command line: `name` with its arguments.
    pub fn command(&self, name: &str) -> Command {
        (self.augment)(Command::new(name.to_string()).about(self.summary().to_string()).long_about(self.about.clone()))
    }

    pub fn run_cli<'a>(&self, m: &'a ArgMatches, cx: &'a Cx) -> BoxFuture<'a, Result<Out, String>> {
        (self.run_cli)(m, cx)
    }

    pub fn run_json<'a>(&self, args: Value, cx: &'a Cx) -> BoxFuture<'a, Result<Out, String>> {
        (self.run_json)(args, cx)
    }
}

/// The groups of operations, in the order people read them.
pub const GROUPS: &[(&str, &str)] = &[
    ("task", "Tasks and epics: read, create, update, move through statuses, comment, attach artifacts"),
    ("team", "Teams of agents: assemble, look at, steer and stop them"),
    ("mail", "Mail between the members of a team, the orchestrator and people"),
    ("docs", "The project's knowledge base: search, read, write pages"),
    ("job", "One-shot jobs of automations"),
    ("project", "Projects of the server: add, settings, people and invitations"),
    ("user", "People with access to the server"),
    ("server", "The running server: readiness, what happened, knowledge sync"),
];

/// Every operation of genie.
pub fn catalog() -> &'static [Entry] {
    static ALL: OnceLock<Vec<Entry>> = OnceLock::new();
    ALL.get_or_init(|| {
        let mut all = Vec::new();
        tasks::register(&mut all);
        teams::register(&mut all);
        mail::register(&mut all);
        docs::register(&mut all);
        admin::register(&mut all);
        all
    })
}

pub fn find(group: &str, name: &str) -> Option<&'static Entry> {
    catalog().iter().find(|e| e.group == group && e.name == name)
}

/// Push [`Entry::of`] for each type.
macro_rules! register {
    ($all:expr, $($t:ty),+ $(,)?) => {
        $($all.push($crate::ops::Entry::of::<$t>());)+
    };
}
pub(crate) use register;

/// The command line of the catalog: a subcommand per group, and `agent` with the
/// commands agents knew before it (`genie agent show` is `genie task show`).
pub fn commands(mut root: Command) -> Command {
    for (group, about) in GROUPS {
        let mut g = Command::new(*group).about(*about).subcommand_required(true).arg_required_else_help(true);
        for e in catalog().iter().filter(|e| e.group == *group) {
            g = g.subcommand(e.command(e.name));
        }
        root = root.subcommand(g);
    }
    let mut agent = Command::new("agent")
        .about("The commands of agents under their earlier names (genie agent show = genie task show)")
        .subcommand_required(true)
        .arg_required_else_help(true);
    let mut docs = Command::new("docs").about("Project knowledge (vault)").subcommand_required(true);
    for e in catalog() {
        match e.legacy {
            Some(l) if l.starts_with("docs ") => docs = docs.subcommand(e.command(&l[5..])),
            Some(l) => agent = agent.subcommand(e.command(l)),
            None => {}
        }
    }
    root.subcommand(agent.subcommand(docs))
}

/// The operation a command line names, with its arguments.
pub fn chosen(m: &ArgMatches) -> Option<(&'static Entry, &ArgMatches)> {
    let (group, gm) = m.subcommand()?;
    let (name, am) = gm.subcommand()?;
    if group == "agent" {
        if name == "docs" {
            let (sub, sm) = am.subcommand()?;
            let legacy = format!("docs {sub}");
            return catalog().iter().find(|e| e.legacy == Some(legacy.as_str())).map(|e| (e, sm));
        }
        return catalog().iter().find(|e| e.legacy == Some(name)).map(|e| (e, am));
    }
    find(group, name).map(|e| (e, am))
}

/// URL-encode one path segment or query value.
pub fn enc(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || "-_.~".contains(c) {
                c.to_string()
            } else {
                c.to_string().bytes().map(|b| format!("%{b:02X}")).collect()
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_operation_has_a_command_line_and_a_schema() {
        let mut seen = std::collections::BTreeSet::new();
        for e in catalog() {
            assert!(seen.insert((e.group, e.name)), "{} {} twice", e.group, e.name);
            assert!(GROUPS.iter().any(|(g, _)| *g == e.group), "{} is not a group", e.group);
            assert!(!e.summary().is_empty(), "{} {} says nothing about itself", e.group, e.name);
            assert_eq!(e.schema["type"], "object", "{} {}: {}", e.group, e.name, e.schema);
            e.command(e.name).debug_assert();
        }
        commands(Command::new("genie")).debug_assert();
    }

    #[test]
    fn urls_are_encoded_by_bytes() {
        assert_eq!(enc("G-7"), "G-7");
        assert_eq!(enc("a b/ц"), "a%20b%2F%D1%86");
    }
}

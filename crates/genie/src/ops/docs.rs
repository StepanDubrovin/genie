//! The project's knowledge base.

use std::path::PathBuf;

use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Value, json};

use super::{Cx, Entry, Need, Op, Out, enc, register, render};

pub fn register(all: &mut Vec<Entry>) {
    register!(all, Search, Read, Tree, Write, Note, Impact);
}

/// Full-text search over the project's pages; deprecated pages only when --status asks for them.
#[derive(clap::Args, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Search {
    pub query: String,
    /// guide, reference, decision, glossary, runbook or note.
    #[arg(long = "type")]
    #[serde(rename = "type")]
    pub doc_type: Option<String>,
    /// draft, current or deprecated.
    #[arg(long)]
    pub status: Option<String>,
    #[arg(long)]
    pub limit: Option<usize>,
}

impl Op for Search {
    const GROUP: &'static str = "docs";
    const NAME: &'static str = "search";
    const LEGACY: Option<&'static str> = Some("docs search");
    async fn run(self, cx: &Cx) -> Result<Out, String> {
        let mut q = format!("/docs/search?q={}", enc(&self.query));
        for (k, v) in [("type", self.doc_type), ("status", self.status), ("limit", self.limit.map(|n| n.to_string()))] {
            if let Some(v) = v {
                q.push_str(&format!("&{k}={}", enc(&v)));
            }
        }
        let v = cx.call("GET", &q, None).await?;
        let rows = v["results"].as_array().cloned().unwrap_or_default();
        let text = if rows.is_empty() {
            format!("no documentation matches \"{}\"", self.query)
        } else {
            rows.iter()
                .map(|r| {
                    let snippet = r["snippet"].as_str().unwrap_or_default().split_whitespace().collect::<Vec<_>>().join(" ");
                    format!("{}\n    {snippet}", render::doc_line(r))
                })
                .collect::<Vec<_>>()
                .join("\n\n")
        };
        Ok(Out::new(text, v["results"].clone()))
    }
}

/// Read a page, or one of its sections with --heading.
#[derive(clap::Args, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Read {
    /// Path in the vault, e.g. billing/returns.md.
    pub path: String,
    /// Only the section under this heading.
    #[arg(long, conflicts_with = "whole")]
    pub heading: Option<String>,
    /// The whole page (the default without --heading).
    #[arg(long)]
    #[serde(default)]
    pub whole: bool,
    /// Cut the text after this many characters.
    #[arg(long)]
    pub max_chars: Option<usize>,
}

impl Op for Read {
    const GROUP: &'static str = "docs";
    const NAME: &'static str = "read";
    const LEGACY: Option<&'static str> = Some("docs read");
    async fn run(self, cx: &Cx) -> Result<Out, String> {
        let mut q = format!("/docs/page?path={}", enc(&self.path));
        if let Some(h) = &self.heading {
            q.push_str(&format!("&heading={}", enc(h)));
        }
        if let Some(n) = self.max_chars {
            q.push_str(&format!("&maxChars={n}"));
        }
        let v = cx.call("GET", &q, None).await?;
        Ok(Out::new(render::doc(&v), v))
    }
}

/// Every page of the vault with its draft, stale and diagnostics markers.
#[derive(clap::Args, Deserialize, JsonSchema)]
pub struct Tree {}

impl Op for Tree {
    const GROUP: &'static str = "docs";
    const NAME: &'static str = "tree";
    const LEGACY: Option<&'static str> = Some("docs tree");
    async fn run(self, cx: &Cx) -> Result<Out, String> {
        let v = cx.call("GET", "/docs/tree", None).await?;
        let pages = v["pages"].as_array().cloned().unwrap_or_default();
        let text = if pages.is_empty() {
            "no documentation pages".to_string()
        } else {
            pages.iter().map(render::doc_line).collect::<Vec<_>>().join("\n")
        };
        Ok(Out::new(text, v["pages"].clone()))
    }
}

/// Write a page; where the section asks for a review it becomes a proposal the owner decides on.
#[derive(clap::Args, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Write {
    pub path: String,
    /// The page's full Markdown; `-` reads it from stdin.
    #[arg(long, allow_hyphen_values = true)]
    pub text: Option<String>,
    /// Read the page from a file (command line only).
    #[arg(long)]
    #[serde(skip)]
    #[schemars(skip)]
    pub file: Option<PathBuf>,
    /// What changed and why: the commit message.
    #[arg(long, allow_hyphen_values = true)]
    pub note: Option<String>,
    /// create (the page must not exist), update (it must) or upsert.
    #[arg(long, default_value = "upsert")]
    #[serde(default = "upsert")]
    pub mode: String,
    /// The task this change belongs to (default: yours).
    #[arg(long)]
    pub task: Option<String>,
}

fn upsert() -> String {
    "upsert".into()
}

impl Op for Write {
    const GROUP: &'static str = "docs";
    const NAME: &'static str = "write";
    const LEGACY: Option<&'static str> = Some("docs write");
    const NEED: Need = Need::Write;
    async fn run(self, cx: &Cx) -> Result<Out, String> {
        let content = cx.text(self.text, self.file)?.ok_or("pass the page as --text (or --file on the command line)")?;
        let task = self.task.or_else(|| cx.task.clone());
        let body = json!({ "path": self.path, "content": content, "note": self.note.unwrap_or_default(), "mode": self.mode, "task": task });
        let v = cx.call("POST", "/docs/page", Some(body)).await?;
        let text = match v["proposal"].as_i64() {
            Some(id) => format!("proposal #{id} created for {}: the section needs a review, the owner decides", self.path),
            None => format!("{} saved", v["page"]["path"].as_str().unwrap_or(&self.path)),
        };
        Ok(Out::new(text, v))
    }
}

/// Capture a draft note in the inbox of the project's space.
#[derive(clap::Args, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub title: String,
    /// The note's text.
    #[arg(short = 'd', long = "description", allow_hyphen_values = true)]
    #[serde(default)]
    pub body: String,
    /// A tag; repeat or separate with commas.
    #[arg(long = "tag")]
    #[serde(default)]
    pub tags: Vec<String>,
    /// A related page or task; repeat or separate with commas.
    #[arg(long)]
    #[serde(default)]
    pub related: Vec<String>,
}

fn split(items: Vec<String>) -> Vec<String> {
    items.iter().flat_map(|x| x.split(',')).map(str::trim).filter(|x| !x.is_empty()).map(str::to_string).collect()
}

impl Op for Note {
    const GROUP: &'static str = "docs";
    const NAME: &'static str = "note";
    const NEED: Need = Need::Write;
    async fn run(self, cx: &Cx) -> Result<Out, String> {
        let body =
            json!({ "title": self.title, "body": self.body, "tags": split(self.tags), "related": split(self.related), "task": cx.task });
        let v = cx.call("POST", "/docs/note", Some(body)).await?;
        let path = v["path"].as_str().unwrap_or_default();
        let text = match v["proposal"].as_i64() {
            Some(id) => format!("proposal #{id} created for {path}: the section needs a review, the owner decides"),
            None => format!("created {path}"),
        };
        Ok(Out::new(text, v))
    }
}

/// Pages a task's changes may have made stale; never blocks the task (default: your task).
#[derive(clap::Args, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Impact {
    pub task: Option<String>,
}

impl Op for Impact {
    const GROUP: &'static str = "docs";
    const NAME: &'static str = "impact";
    async fn run(self, cx: &Cx) -> Result<Out, String> {
        let v: Value = cx.call("GET", &format!("/tasks/{}/docs-impact", enc(&cx.task(self.task)?)), None).await?;
        Ok(Out::new(render::impact(&v), v))
    }
}

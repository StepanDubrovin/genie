//! Knowledge vault in the server: one write path for people, agents and
//! automations (direct write, proposal for review, or refusal by the section's
//! policy), journal events for projects, and a watcher that picks up edits made
//! in Obsidian or by git pulls.

use std::sync::Arc;
use std::time::Duration;

use genie_core::events;
use genie_core::vault::{AuthorKind, WriteOutcome};
use genie_core::work::Proposal;
use serde_json::{Value, json};

use crate::state::{App, AppResult};

pub enum DocWrite {
    Saved { created: bool, hash: String },
    Proposed(Box<Proposal>),
}

pub struct Author<'a> {
    /// Display name (git author) and login/agent name.
    pub name: &'a str,
    pub login: &'a str,
    pub kind: AuthorKind,
}

/// Append an event to the journal of the project that owns a page (if any).
pub fn doc_event(app: &App, path: &str, kind: &str, actor: &str, actor_role: &str, payload: Value) {
    let project = app.with_vault(|v| Ok(v.project_of(path))).ok().flatten();
    if let Some(p) = project {
        let _ = app.with_tracker(&p, |t| events::append(t.conn(), kind, None, actor, actor_role, payload.clone()).map(|_| ()));
        app.wake_engine.notify_one();
    }
}

/// Write a page on behalf of a person or an agent, honouring the section policy.
#[allow(clippy::too_many_arguments)]
pub fn write_doc(
    app: &App,
    path: &str,
    content: &str,
    author: Author<'_>,
    base_hash: Option<&str>,
    note: &str,
    task: Option<&str>,
) -> AppResult<DocWrite> {
    let message = if note.trim().is_empty() { format!("{}: update {path}", author.login) } else { note.trim().to_string() };
    let outcome = app.with_vault(|v| v.write(path, content, author.kind, (author.name, author.login), base_hash, &message))?;
    let role = match author.kind {
        AuthorKind::Human => "human",
        AuthorKind::Agent => "agent",
        AuthorKind::System => "system",
    };
    match outcome {
        WriteOutcome::Saved { created, hash } => {
            let rel = app.with_vault(|v| Ok(v.resolve(path)?.0))?;
            doc_event(app, &rel, "doc.changed", author.login, role, json!({ "path": rel, "created": created, "task": task }));
            Ok(DocWrite::Saved { created, hash })
        }
        WriteOutcome::NeedsReview => {
            let (rel, project, base) = app.with_vault(|v| {
                let rel = v.resolve(path)?.0;
                Ok((rel.clone(), v.project_of(&rel), v.current_hash(&rel)?))
            })?;
            let base = base_hash.map(str::to_string).or(base).or(Some(String::new()));
            let proposal = app.with_server(|db| {
                // A newer proposal from the same author for the same page replaces the open one.
                for old in db.proposals(Some("open"), 500)?.into_iter().filter(|p| p.path == rel && p.author == author.login) {
                    db.decide_proposal(old.id, "superseded", author.login, Some("replaced by a newer proposal"))?;
                }
                db.create_proposal(&rel, base.as_deref(), content, author.login, role, project.as_deref(), task, note)
            })?;
            doc_event(app, &rel, "doc.proposal", author.login, role, json!({ "path": rel, "proposal": proposal.id, "task": task }));
            Ok(DocWrite::Proposed(Box::new(proposal)))
        }
    }
}

/// Apply or reject a proposal. Applying writes as the proposal's author.
pub fn decide(app: &App, id: i64, approve: bool, by: &str, note: Option<&str>, force: bool) -> AppResult<Proposal> {
    let p = app.with_server(|db| db.proposal(id))?;
    if p.status != "open" {
        return Err(genie_core::GenieError::invalid(format!("proposal {id} is {}", p.status)).into());
    }
    if approve {
        let base = if force { None } else { p.base_hash.as_deref() };
        let msg =
            format!("{} (proposal #{id}, approved by {by})", if p.note.is_empty() { format!("update {}", p.path) } else { p.note.clone() });
        app.with_vault(|v| v.write(&p.path, &p.content, AuthorKind::System, (&p.author, &p.author), base, &msg))?;
        doc_event(app, &p.path, "doc.changed", by, "human", json!({ "path": p.path, "proposal": id, "task": p.task }));
    }
    let decided = app.with_server(|db| db.decide_proposal(id, if approve { "approved" } else { "rejected" }, by, note))?;
    doc_event(app, &p.path, "doc.proposal_decided", by, "human", json!({ "path": p.path, "proposal": id, "approved": approve }));
    Ok(decided)
}

/// Pick up edits made outside genie (Obsidian, git pull) every few seconds.
pub fn start_watcher(app: &Arc<App>) {
    let app = app.clone();
    tokio::spawn(async move {
        let mut last = String::new();
        loop {
            tokio::time::sleep(Duration::from_secs(4)).await;
            let prev = last.clone();
            let res = app
                .blocking(move |app| {
                    let sig = app.with_vault(|v| Ok(v.signature()))?;
                    if sig == prev {
                        return Ok((sig, Vec::new()));
                    }
                    let changed = app.with_vault(|v| {
                        let _ = v.reload_config();
                        v.refresh()
                    })?;
                    Ok((sig, changed))
                })
                .await;
            match res {
                Ok((sig, changed)) => {
                    if !last.is_empty() {
                        let app2 = app.clone();
                        let _ = app
                            .blocking(move |_| {
                                for path in changed {
                                    doc_event(&app2, &path, "doc.changed", "vault", "system", json!({ "path": path, "external": true }));
                                }
                                Ok(())
                            })
                            .await;
                    }
                    last = sig;
                }
                Err(e) => eprintln!("genie vault: {e}"),
            }
        }
    });
}

/// Release a project's changelog: `Unreleased` becomes the version; the journal
/// gets a `release.published` event (notifications and automations react to it).
pub fn release(app: &App, project: &str, version: &str, by: &str) -> AppResult<String> {
    let date = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let notes = app.with_vault(|v| {
        let space =
            v.spaces_of(project).into_iter().next().ok_or_else(|| genie_core::GenieError::not_found("the project has no vault space"))?;
        v.changelog_release(&space, version, &date)
    })?;
    app.with_tracker(project, |t| {
        events::append(t.conn(), "release.published", None, by, "human", json!({ "version": version, "date": date, "notes": notes }))
            .map(|_| ())
    })?;
    app.wake_engine.notify_one();
    Ok(notes)
}

/// Add a changelog entry to a project's space.
pub fn changelog_add(app: &App, project: &str, group: &str, text: &str, task: Option<&str>) -> AppResult<String> {
    let russian = app.cfg.language.user.to_lowercase().starts_with("rus");
    app.with_vault(|v| {
        let space =
            v.spaces_of(project).into_iter().next().ok_or_else(|| genie_core::GenieError::not_found("the project has no vault space"))?;
        v.changelog_add(&space, group, text, task, russian)?;
        Ok(format!("{space}/changelog.md"))
    })
}

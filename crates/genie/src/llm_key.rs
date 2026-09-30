//! Whose LiteLLM key an agent uses.
//!
//! Every person keeps their own key in their profile (`genie_core::secrets`).
//! An agent the server starts runs on behalf of its *initiator* and gets that
//! person's key as `LITELLM_API_KEY`:
//!
//! - a team member — the person who assembled the team; for a team the
//!   orchestrator or an automation assembled, the person the task is for (its
//!   assignee, else its author);
//! - a job — the person who started it; for an automation's job, the person
//!   whose action triggered the run, else the task's person, else the author of
//!   the automation;
//! - the orchestrator — the person whose mail it is answering (the sender, or the
//!   initiator of the team or task the mail is about).
//!
//! An agent on a `litellm/…` model whose initiator has no key is not started:
//! the person is told to set it. The server's own `LITELLM_API_KEY` never
//! reaches agents — except on a server without users (local mode), where there
//! are no profiles and agents keep using it.

use genie_core::automation::Run;
use genie_core::secrets::LITELLM;
use genie_core::team::{Mail, ORCHESTRATOR};
use genie_core::{Actor, Role};

use crate::agent_config::TeamSpec;
use crate::notify::{self, Message};
use crate::state::App;

/// The variable the `litellm` provider of pi reads its key from (`models.json`: `"apiKey": "$LITELLM_API_KEY"`).
pub const KEY_VAR: &str = "LITELLM_API_KEY";

/// Does an agent on `model` need a LiteLLM key?
pub fn needs_key(model: Option<&str>) -> bool {
    model.is_some_and(|m| m.trim().starts_with("litellm/"))
}

/// What an agent's `LITELLM_API_KEY` is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Key {
    /// A server without users: the server's own environment, untouched.
    Server,
    /// The initiator's key.
    User(String),
    /// None: the agent does not need one and its initiator has none.
    Nothing,
}

impl Key {
    pub fn apply(&self, cmd: &mut tokio::process::Command) {
        match self {
            Key::Server => {}
            Key::User(k) => {
                cmd.env(KEY_VAR, k);
            }
            Key::Nothing => {
                cmd.env_remove(KEY_VAR);
            }
        }
    }
}

/// The key for an agent `who` (for messages) on `model`, run on behalf of `initiator`.
/// Fails when the agent needs a key and cannot have one; the person is told.
pub fn resolve(app: &App, project: &str, who: &str, initiator: Option<&str>, model: Option<&str>) -> Result<Key, String> {
    if app.with_server(|db| db.user_count()).map_err(|e| e.to_string())? == 0 {
        return Ok(Key::Server);
    }
    let user = match initiator {
        Some(login) => app.with_server(|db| db.user_by_login(login)).map_err(|e| e.to_string())?.filter(|u| !u.disabled),
        None => None,
    };
    let key = match &user {
        Some(u) => app.with_server(|db| db.user_secret(u.id, LITELLM)).map_err(|e| e.to_string())?,
        None => None,
    };
    if let Some(k) = key {
        return Ok(Key::User(k));
    }
    if !needs_key(model) {
        return Ok(Key::Nothing);
    }
    let model = model.unwrap_or_default();
    Err(match (&user, initiator) {
        (Some(u), _) => {
            tell_missing(app, project, u.id, &u.login, who, model);
            format!("{who} runs on {model} on behalf of @{}, who has no LiteLLM key: set it in the profile", u.login)
        }
        (None, Some(login)) => {
            format!("{who} runs on {model} on behalf of {login}, who has no account on this server to hold a LiteLLM key")
        }
        (None, None) => format!("{who} runs on {model}, but nobody it works for is known to take its LiteLLM key from"),
    })
}

/// Tell a person (once a day per project) that their agents wait for their key.
fn tell_missing(app: &App, project: &str, user: i64, login: &str, who: &str, model: &str) {
    let msg = Message {
        kind: "litellm-key".into(),
        title: "Агенты ждут ваш ключ LiteLLM".into(),
        body: format!(
            "{who} в проекте {project} работает от вашего имени на модели {model}, но в вашем профиле нет ключа LiteLLM. Укажите его в профиле — агент запустится сам."
        ),
        project: Some(project.to_string()),
        link: Some("/profile/litellm".into()),
        ..Default::default()
    };
    let day = chrono::Utc::now().format("%Y-%m-%d");
    if let Err(e) = notify::send(app, &[user], &msg, Some(&format!("litellm-key:{project}:{login}:{day}"))) {
        eprintln!("genie runtime: {project}: cannot tell @{login} about the LiteLLM key: {e}");
    }
}

/// The person a task is for: its assignee, else the person who created it.
pub fn task_person(app: &App, project: &str, task: &str) -> Option<String> {
    let t = app.with_tracker(project, |t| t.get(task)).ok()?;
    t.assignee.clone().or_else(|| t.history.iter().find(|h| h.role == Role::Human).map(|h| h.actor.clone()))
}

/// The person a team works on behalf of.
pub fn team_initiator(app: &App, project: &str, team: &str) -> Option<String> {
    let t = app.with_tracker(project, |t| t.bus().get(team)).ok()?;
    t.spec.as_ref().and_then(TeamSpec::from_value).and_then(|s| s.initiator).or_else(|| task_person(app, project, &t.task))
}

/// The initiator of a new team or job started by `by` for `task`: a person is
/// their own initiator, an agent works for the task's person.
pub fn initiator_of(app: &App, project: &str, by: &Actor, task: Option<&str>) -> Option<String> {
    if by.role == Role::Human {
        return Some(by.name.clone());
    }
    task.and_then(|t| task_person(app, project, t))
}

/// The initiator of what an automation's run starts: the person whose action
/// triggered the run, else the task's person, else the automation's author.
pub fn automation_initiator(app: &App, run: &Run, task: Option<&str>) -> Option<String> {
    let actor = run.trigger["context"]["event"]["actor"].as_str().filter(|a| !a.is_empty());
    let person = actor.filter(|a| app.with_server(|db| db.user_by_login(a)).ok().flatten().is_some_and(|u| !u.disabled));
    person
        .map(str::to_string)
        .or_else(|| task.and_then(|t| task_person(app, &run.project, t)))
        .or_else(|| app.with_server(|db| db.automation(run.automation)).ok().map(|a| a.created_by))
}

/// The person the orchestrator answers in `mail`: the first person who wrote,
/// else the initiator of the first team or task a message is about.
pub fn mail_initiator(app: &App, project: &str, mail: &[Mail]) -> Option<String> {
    if let Some(m) = mail.iter().find(|m| m.from_role == Role::Human.as_str()) {
        return Some(m.from.clone());
    }
    mail.iter().find_map(|m| {
        if let Some(team) = &m.team {
            return team_initiator(app, project, team);
        }
        let task = m.task.as_deref()?;
        let team = app.with_tracker(project, |t| t.get(task)).ok().and_then(|t| t.team);
        team.and_then(|team| team_initiator(app, project, &team)).or_else(|| task_person(app, project, task))
    })
}

/// The person the orchestrator would answer now: from the mail waiting for it.
pub fn orchestrator_initiator(app: &App, project: &str) -> Option<String> {
    let mail = app.with_tracker(project, |t| t.bus().pending(None, ORCHESTRATOR)).ok()?;
    mail_initiator(app, project, &mail)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_litellm_models_need_a_key() {
        assert!(needs_key(Some("litellm/gpt-6-sol")));
        assert!(!needs_key(Some("openai-codex/gpt-6")));
        assert!(!needs_key(None));
    }
}

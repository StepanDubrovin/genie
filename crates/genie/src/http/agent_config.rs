//! Roles, team templates, skills and MCP connections over HTTP.
//!
//! Everyone with access to a project sees the catalogue; only server
//! administrators change it (decision PD14). A change is a file in the data
//! directory: it is checked by the loader exactly as it will be read, refused
//! when it is invalid or breaks something that works now, compared with the
//! version the editor started from (no lost updates), written atomically and
//! recorded in the configuration history.

use std::collections::HashSet;
use std::path::{Path as FsPath, PathBuf};
use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use genie_core::Task;
use serde::Deserialize;
use serde_json::{Value, json};

use super::ctx::Ctx;
use super::{ApiError, ApiResult};
use crate::agent_config::{self, AgentConfig, Level, Overlay, Problem, SpecMember, TeamSpec};
use crate::runtime::Kickoff;
use crate::state::{App, AppError};

pub fn routes() -> Router<Arc<App>> {
    Router::new()
        .route("/agent-config", get(catalogue))
        .route("/agent-config/history", get(history))
        .route("/roles/{id}", get(role).put(put_role).delete(delete_role))
        .route("/templates/{id}", get(template).put(put_template).delete(delete_template))
        .route("/templates/{id}/preview", post(preview))
        .route("/skills/{name}", get(skill).put(put_skill).delete(delete_skill))
        .route("/mcp", get(mcp).put(put_mcp))
}

fn content_hash(text: &str) -> String {
    genie_core::server_db::hash_secret(text)
}

/// A file's content and hash (`""` when it does not exist).
fn file_state(path: &FsPath) -> (Option<String>, String) {
    let content = std::fs::read_to_string(path).ok();
    let hash = content.as_deref().map(content_hash).unwrap_or_default();
    (content, hash)
}

fn not_found(what: String) -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, what)
}

fn valid_id(id: &str) -> bool {
    let mut c = id.chars();
    matches!(c.next(), Some(f) if f.is_ascii_lowercase()) && c.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// What an edit changes: the file, the item it defines and how problems name it.
struct Target {
    path: PathBuf,
    /// Relative to the data directory, for people and the history.
    rel: String,
    /// The history item (`role:x`, `team:x`, `skill:x`, `mcp`).
    item: String,
    /// Problems of the edited item start with this (`role:x`, `team:x`, `skill`, `mcp`).
    problem_prefix: String,
}

impl Target {
    fn role(app: &App, id: &str) -> ApiResult<Target> {
        if !valid_id(id) {
            return Err(ApiError::bad("a role id is [a-z][a-z0-9-]*"));
        }
        Ok(Target {
            path: app.data.join("agents").join(format!("{id}.md")),
            rel: format!("agents/{id}.md"),
            item: format!("role:{id}"),
            problem_prefix: format!("role:{id}"),
        })
    }
    fn team(app: &App, id: &str) -> ApiResult<Target> {
        if !valid_id(id) {
            return Err(ApiError::bad("a template id is [a-z][a-z0-9-]*"));
        }
        Ok(Target {
            path: app.data.join("teams").join(format!("{id}.json")),
            rel: format!("teams/{id}.json"),
            item: format!("team:{id}"),
            problem_prefix: format!("team:{id}"),
        })
    }
    fn skill(app: &App, name: &str) -> ApiResult<Target> {
        let ok = name.chars().next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
            && name.len() <= 64
            && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
        if !ok {
            return Err(ApiError::bad("a skill name is lowercase letters, digits and hyphens"));
        }
        Ok(Target {
            path: app.data.join("skills").join(name).join("SKILL.md"),
            rel: format!("skills/{name}/SKILL.md"),
            item: format!("skill:{name}"),
            problem_prefix: "skill".into(),
        })
    }
    fn mcp(app: &App) -> Target {
        Target { path: app.data.join("mcp.json"), rel: "mcp.json".into(), item: "mcp".into(), problem_prefix: "mcp".into() }
    }
}

/// Check `content` (`None`: remove the file) as the loader will see it, then
/// write it, record the change and reload. Refuses a stale base, an invalid
/// item and a change that breaks something that loads fine now.
fn save(app: &App, user: &str, t: &Target, content: Option<String>, base_hash: Option<&str>) -> Result<Value, ApiError> {
    let (current, hash) = file_state(&t.path);
    if let Some(base) = base_hash
        && base != hash
    {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            format!(
                "{} changed since you opened it (someone else saved it, or the file was edited on the server); reload and apply your change again",
                t.rel
            ),
        ));
    }
    if content.is_none() && current.is_none() {
        return Err(not_found(format!("{} does not exist", t.rel)));
    }
    let now = app.agents();
    let known: HashSet<(String, String)> = now.errors().map(|p| (p.item.clone(), p.message.clone())).collect();
    let mut overlay = Overlay::new();
    overlay.insert(t.path.clone(), content.clone());
    let checked = AgentConfig::load_with(&app.data, &app.cfg, None, &overlay);
    let blocking: Vec<&Problem> = checked
        .errors()
        .filter(|p| p.item.starts_with(&t.problem_prefix) || !known.contains(&(p.item.clone(), p.message.clone())))
        .collect();
    if !blocking.is_empty() {
        let text = blocking.iter().map(|p| format!("{}: {}", p.item, p.message)).collect::<Vec<_>>().join("; ");
        return Err(ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, format!("not saved: {text}")));
    }
    match &content {
        Some(text) => {
            if let Some(dir) = t.path.parent() {
                std::fs::create_dir_all(dir).map_err(|e| ApiError::from(AppError::Internal(format!("{}: {e}", dir.display()))))?;
            }
            genie_core::vault::atomic_write(&t.path, text.as_bytes())?;
        }
        None => std::fs::remove_file(&t.path).map_err(|e| ApiError::from(AppError::Internal(format!("{}: {e}", t.rel))))?,
    }
    app.with_server(|db| db.record_config_change(user, &t.item, &t.rel, current.as_deref(), content.as_deref()))?;
    let fresh = app.reload_agents();
    let problems: Vec<&Problem> = fresh.problems.iter().filter(|p| p.item.starts_with(&t.problem_prefix)).collect();
    Ok(json!({
        "ok": true,
        "path": t.rel,
        "hash": content.as_deref().map(content_hash).unwrap_or_default(),
        "problems": problems,
    }))
}

fn problems_of<'a>(cfg: &'a AgentConfig, item: &str) -> Vec<&'a Problem> {
    cfg.problems.iter().filter(|p| p.item == item).collect()
}

/// Automations that name a template or a role in their steps.
fn automation_refs(app: &App, key: &str, id: &str) -> Vec<Value> {
    let Ok(rules) = app.with_server(|db| db.automations(None)) else { return Vec::new() };
    rules
        .into_iter()
        .filter(|a| {
            a.spec["steps"].as_array().is_some_and(|steps| {
                steps.iter().any(|s| s.as_object().is_some_and(|o| o.values().any(|v| v.get(key).and_then(Value::as_str) == Some(id))))
            })
        })
        .map(|a| json!({ "id": a.id, "project": a.project, "name": a.name }))
        .collect()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileBody {
    content: Option<String>,
    /// A template as JSON instead of text.
    template: Option<Value>,
    base_hash: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct DeleteQuery {
    base_hash: Option<String>,
}

// --- catalogue and history ----------------------------------------------------------

async fn catalogue(State(app): State<Arc<App>>, ctx: Ctx) -> ApiResult<Json<Value>> {
    let access = ctx.access(&app, None).await?;
    let mut v = agent_config::catalogue(&app.agents(), Some(&access.project));
    v["project"] = json!(access.project);
    v["admin"] = json!(ctx.server_admin().is_ok());
    v["mcpAdapter"] = json!(app.cfg.runtime.mcp_adapter());
    v["mcpGateway"] = json!(app.cfg.runtime.mcp_gateway);
    Ok(Json(v))
}

#[derive(Deserialize, Default)]
struct HistoryQuery {
    item: Option<String>,
    limit: Option<i64>,
}

async fn history(State(app): State<Arc<App>>, ctx: Ctx, Query(q): Query<HistoryQuery>) -> ApiResult<Json<Value>> {
    ctx.server_admin()?;
    let out =
        app.blocking(move |app| app.with_server(|db| db.config_changes(q.item.as_deref(), q.limit.unwrap_or(50).clamp(1, 500)))).await?;
    Ok(Json(json!(out)))
}

// --- roles ----------------------------------------------------------------------------

async fn role(State(app): State<Arc<App>>, ctx: Ctx, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    ctx.access(&app, None).await?;
    let admin = ctx.server_admin().is_ok();
    app.blocking(move |app| {
        let agents = app.agents();
        let Some(def) = agents.roles.get(&id) else { return Ok(Err(not_found(format!("role {id} not found")))) };
        let t = match Target::role(app, &id) {
            Ok(t) => t,
            Err(e) => return Ok(Err(e)),
        };
        let (content, hash) = file_state(&t.path);
        let used_by: Vec<&str> = agents.teams.values().filter(|x| x.members.iter().any(|m| m.role == id)).map(|x| x.id.as_str()).collect();
        Ok(Ok(json!({
            "role": def,
            "file": { "path": t.rel, "content": content, "hash": hash },
            "builtin": agent_config::builtin_role_text(&id),
            "usedBy": { "templates": used_by, "automations": automation_refs(app, "role", &id) },
            "problems": problems_of(&agents, &t.item),
            "admin": admin,
        })))
    })
    .await?
    .map(Json)
}

async fn put_role(State(app): State<Arc<App>>, ctx: Ctx, Path(id): Path<String>, Json(b): Json<FileBody>) -> ApiResult<Json<Value>> {
    let user = ctx.server_admin()?.login.clone();
    let content = b.content.ok_or_else(|| ApiError::bad("pass the role file as `content`"))?;
    app.blocking(move |app| {
        let t = match Target::role(app, &id) {
            Ok(t) => t,
            Err(e) => return Ok(Err(e)),
        };
        Ok(save(app, &user, &t, Some(content), b.base_hash.as_deref()))
    })
    .await?
    .map(Json)
}

async fn delete_role(
    State(app): State<Arc<App>>,
    ctx: Ctx,
    Path(id): Path<String>,
    Query(q): Query<DeleteQuery>,
) -> ApiResult<Json<Value>> {
    let user = ctx.server_admin()?.login.clone();
    app.blocking(move |app| {
        let t = match Target::role(app, &id) {
            Ok(t) => t,
            Err(e) => return Ok(Err(e)),
        };
        let refs = automation_refs(app, "role", &id);
        if agent_config::builtin_role_text(&id).is_none() && !refs.is_empty() {
            let names: Vec<String> =
                refs.iter().map(|r| format!("{} ({})", r["name"].as_str().unwrap_or_default(), r["project"])).collect();
            return Ok(Err(ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                format!("role {id} is used by automations: {}", names.join(", ")),
            )));
        }
        Ok(save(app, &user, &t, None, q.base_hash.as_deref()))
    })
    .await?
    .map(Json)
}

// --- templates ----------------------------------------------------------------------

async fn template(State(app): State<Arc<App>>, ctx: Ctx, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    ctx.access(&app, None).await?;
    let admin = ctx.server_admin().is_ok();
    app.blocking(move |app| {
        let agents = app.agents();
        let Some(def) = agents.teams.get(&id) else { return Ok(Err(not_found(format!("team template {id} not found")))) };
        let t = match Target::team(app, &id) {
            Ok(t) => t,
            Err(e) => return Ok(Err(e)),
        };
        let (content, hash) = file_state(&t.path);
        Ok(Ok(json!({
            "template": def,
            "file": { "path": t.rel, "content": content, "hash": hash },
            "builtin": agent_config::builtin_team_text(&id),
            "usedBy": { "automations": automation_refs(app, "template", &id) },
            "problems": problems_of(&agents, &t.item),
            "admin": admin,
        })))
    })
    .await?
    .map(Json)
}

async fn put_template(State(app): State<Arc<App>>, ctx: Ctx, Path(id): Path<String>, Json(b): Json<FileBody>) -> ApiResult<Json<Value>> {
    let user = ctx.server_admin()?.login.clone();
    let content = match (b.content, b.template) {
        (Some(c), _) => c,
        (None, Some(v)) => format!("{}\n", serde_json::to_string_pretty(&v).unwrap_or_default()),
        (None, None) => return Err(ApiError::bad("pass the template as `content` (text) or `template` (JSON)")),
    };
    app.blocking(move |app| {
        let t = match Target::team(app, &id) {
            Ok(t) => t,
            Err(e) => return Ok(Err(e)),
        };
        Ok(save(app, &user, &t, Some(content), b.base_hash.as_deref()))
    })
    .await?
    .map(Json)
}

async fn delete_template(
    State(app): State<Arc<App>>,
    ctx: Ctx,
    Path(id): Path<String>,
    Query(q): Query<DeleteQuery>,
) -> ApiResult<Json<Value>> {
    let user = ctx.server_admin()?.login.clone();
    app.blocking(move |app| {
        let t = match Target::team(app, &id) {
            Ok(t) => t,
            Err(e) => return Ok(Err(e)),
        };
        let refs = automation_refs(app, "template", &id);
        if agent_config::builtin_team_text(&id).is_none() && !refs.is_empty() {
            let names: Vec<String> =
                refs.iter().map(|r| format!("{} ({})", r["name"].as_str().unwrap_or_default(), r["project"])).collect();
            return Ok(Err(ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                format!("template {id} is used by automations: {}", names.join(", ")),
            )));
        }
        Ok(save(app, &user, &t, None, q.base_hash.as_deref()))
    })
    .await?
    .map(Json)
}

#[derive(Deserialize, Default)]
struct PreviewBody {
    task: Option<String>,
}

/// What every member of a template would get as its kickoff, for a task of the project.
async fn preview(State(app): State<Arc<App>>, ctx: Ctx, Path(id): Path<String>, body: Option<Json<PreviewBody>>) -> ApiResult<Json<Value>> {
    let access = ctx.access(&app, None).await?;
    let slug = access.project.clone();
    let task_id = body.and_then(|Json(b)| b.task);
    let out = app
        .blocking(move |app| {
            let agents = app.agents();
            let t = agents.team_for(&slug, &id)?.clone();
            let task: Task = match &task_id {
                Some(tid) => app.with_tracker(&slug, |tr| tr.get(tid))?,
                None => serde_json::from_value(json!({
                    "id": "TASK-1", "title": "Example task", "type": "task", "status": "ready", "priority": 2,
                    "description": "", "acceptance": [], "plan": "", "notes": "", "mergeStrategy": "",
                    "children": [], "deps": [], "labels": [], "assignees": [], "comments": [], "artifacts": [], "history": [],
                    "created": "", "updated": ""
                }))
                .map_err(|e| AppError::Internal(e.to_string()))?,
            };
            let members: Vec<SpecMember> = t
                .members
                .iter()
                .map(|m| SpecMember {
                    key: m.key.clone(),
                    name: m.name.clone().unwrap_or_else(|| {
                        agents.roles.get(&m.role).and_then(|r| r.names.first().cloned()).unwrap_or_else(|| m.key.clone())
                    }),
                    role: m.role.clone(),
                })
                .collect();
            let spec = TeamSpec {
                template: Some(t.id.clone()),
                title: Some(t.title.clone()),
                stage: t.stage,
                workspace: t.workspace,
                mail: t.mail,
                members,
                relations: t.relations.clone(),
                charter: t.charter.clone(),
                template_hash: None,
            };
            let k = Kickoff {
                team: &task.id,
                task: &task,
                cwd: "<the team's working directory>",
                worktree: None,
                spec: &spec,
                agents: &agents,
                note: None,
                epic: None,
                joining: false,
            };
            let members: Vec<Value> =
                spec.members.iter().map(|m| json!({ "key": m.key, "name": m.name, "role": m.role, "kickoff": k.text(m) })).collect();
            Ok(json!({ "template": t.id, "task": task.id, "members": members, "warnings": t.warnings }))
        })
        .await?;
    Ok(Json(out))
}

// --- skills ---------------------------------------------------------------------------

async fn skill(State(app): State<Arc<App>>, ctx: Ctx, Path(name): Path<String>) -> ApiResult<Json<Value>> {
    ctx.access(&app, None).await?;
    let admin = ctx.server_admin().is_ok();
    app.blocking(move |app| {
        let agents = app.agents();
        let Some(def) = agents.skills.get(&name) else { return Ok(Err(not_found(format!("skill {name} not found")))) };
        let text = std::fs::read_to_string(def.dir.join("SKILL.md")).ok();
        let editable = def.dir.starts_with(app.data.join("skills"));
        let mut files = Vec::new();
        let mut stack = vec![def.dir.clone()];
        while let Some(d) = stack.pop() {
            for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p);
                } else if files.len() < 200
                    && let Ok(rel) = p.strip_prefix(&def.dir)
                {
                    files.push(rel.to_string_lossy().into_owned());
                }
            }
        }
        files.sort();
        let used_by: Vec<&str> =
            agents.roles.values().filter(|r| r.skills.iter().flatten().any(|s| s == &name)).map(|r| r.id.as_str()).collect();
        Ok(Ok(json!({
            "skill": def,
            "content": text.as_deref(),
            "hash": text.as_deref().map(content_hash).unwrap_or_default(),
            "files": files,
            "editable": editable,
            "usedBy": used_by,
            "admin": admin,
        })))
    })
    .await?
    .map(Json)
}

async fn put_skill(State(app): State<Arc<App>>, ctx: Ctx, Path(name): Path<String>, Json(b): Json<FileBody>) -> ApiResult<Json<Value>> {
    let user = ctx.server_admin()?.login.clone();
    let content = b.content.ok_or_else(|| ApiError::bad("pass SKILL.md as `content`"))?;
    app.blocking(move |app| {
        let t = match Target::skill(app, &name) {
            Ok(t) => t,
            Err(e) => return Ok(Err(e)),
        };
        Ok(save(app, &user, &t, Some(content), b.base_hash.as_deref()))
    })
    .await?
    .map(Json)
}

async fn delete_skill(State(app): State<Arc<App>>, ctx: Ctx, Path(name): Path<String>) -> ApiResult<Json<Value>> {
    let user = ctx.server_admin()?.login.clone();
    app.blocking(move |app| {
        let t = match Target::skill(app, &name) {
            Ok(t) => t,
            Err(e) => return Ok(Err(e)),
        };
        let dir = app.data.join("skills").join(&name);
        if !dir.is_dir() {
            return Ok(Err(not_found(format!("skill {name} is not in {}", app.data.join("skills").display()))));
        }
        let (before, _) = file_state(&t.path);
        std::fs::remove_dir_all(&dir).map_err(|e| AppError::Internal(format!("{}: {e}", dir.display())))?;
        app.with_server(|db| db.record_config_change(&user, &t.item, &t.rel, before.as_deref(), None))?;
        let fresh = app.reload_agents();
        Ok(Ok(json!({ "ok": true, "problems": fresh.problems.iter().filter(|p| p.level == Level::Error).collect::<Vec<_>>() })))
    })
    .await?
    .map(Json)
}

// --- MCP connections --------------------------------------------------------------------

async fn mcp(State(app): State<Arc<App>>, ctx: Ctx) -> ApiResult<Json<Value>> {
    let access = ctx.access(&app, None).await?;
    let admin = ctx.server_admin().is_ok();
    let agents = app.agents();
    let servers: Vec<&agent_config::McpServer> = agents.mcp.values().filter(|s| admin || s.available_in(&access.project)).collect();
    let mut out = json!({ "servers": servers, "admin": admin });
    if admin {
        // The file holds commands and `${env:…}` references, never secret values.
        let (content, hash) = file_state(&app.data.join("mcp.json"));
        out["file"] = json!({ "path": "mcp.json", "content": content, "hash": hash });
        out["problems"] = json!(agents.problems.iter().filter(|p| p.item.starts_with("mcp")).collect::<Vec<_>>());
    }
    Ok(Json(out))
}

async fn put_mcp(State(app): State<Arc<App>>, ctx: Ctx, Json(b): Json<FileBody>) -> ApiResult<Json<Value>> {
    let user = ctx.server_admin()?.login.clone();
    let content = b.content.ok_or_else(|| ApiError::bad("pass mcp.json as `content`"))?;
    app.blocking(move |app| Ok(save(app, &user, &Target::mcp(app), Some(content), b.base_hash.as_deref()))).await?.map(Json)
}

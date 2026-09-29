//! Tracker routes: the TypeScript server's `/api/meta` and `/api/tasks…` with the
//! same JSON, plus the operations agents need (split, block, deps, create in draft).

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use genie_core::*;
use serde::Deserialize;
use serde_json::{Value, json};

use super::ctx::{Access, Ctx};
use super::{ApiError, ApiResult};
use crate::state::App;

pub fn routes() -> Router<Arc<App>> {
    Router::new()
        .route("/meta", get(meta))
        .route("/tasks", get(list).post(create))
        .route("/tasks/{id}", get(show).patch(update))
        .route("/tasks/{id}/status", post(status))
        .route("/tasks/{id}/comments", post(comment))
        .route("/tasks/{id}/acceptance/{n}", post(check))
        .route("/tasks/{id}/artifacts", post(add_artifact))
        .route("/tasks/{id}/artifacts/{n}", get(read_artifact))
        .route("/tasks/{id}/split", post(split))
        .route("/tasks/{id}/block", post(block).delete(unblock))
        .route("/journal", get(journal))
}

/// Tracker call in the caller's project, off the async runtime.
pub async fn tracker<T: Send + 'static>(
    app: &Arc<App>,
    access: &Access,
    f: impl FnOnce(&Tracker) -> Result<T> + Send + 'static,
) -> ApiResult<T> {
    let slug = access.project.clone();
    let out = app.blocking(move |app| app.with_tracker(&slug, f)).await?;
    Ok(out)
}

/// What an agent does to a task: change it, or only leave a note (comment, artifact).
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Touch {
    Edit,
    Note,
}

/// Agents act within their assignment: a team member (or job) changes only its
/// own task and its subtasks, and may leave notes on that task's epic. The
/// orchestrator and people are not limited here (the workflow rules still apply).
pub async fn in_scope(app: &Arc<App>, access: &Access, id: &str, touch: Touch) -> ApiResult<()> {
    if !access.agent || access.actor.role == Role::Orchestrator {
        return Ok(());
    }
    let (slug, team, job, id) = (access.project.clone(), access.agent_team.clone(), access.agent_job, id.to_string());
    let verdict = app
        .blocking(move |app| {
            let home = match (&team, job) {
                (Some(t), _) => Some(app.with_tracker(&slug, |tr| Ok(tr.bus().get(t)?.task))?),
                (None, Some(j)) => app.with_server(|db| db.job(j))?.task,
                _ => None,
            };
            let Some(home) = home else { return Ok(Err("this agent has no task to work on".to_string())) };
            app.with_tracker(&slug, |t| {
                let target = t.normalize_id(&id)?;
                let home = t.normalize_id(&home)?;
                // The task itself or one of its descendants.
                let mut cur = Some(target.clone());
                for _ in 0..10 {
                    match cur {
                        Some(c) if c == home => return Ok(Ok(())),
                        Some(c) => cur = t.get(&c).ok().and_then(|x| x.parent),
                        None => break,
                    }
                }
                if touch == Touch::Note && t.epic_of(&home)?.as_deref() == Some(target.as_str()) {
                    return Ok(Ok(()));
                }
                Ok(Err(format!(
                    "agents change only their own task ({home}) and its subtasks, and leave notes on its epic; {target} is outside"
                )))
            })
        })
        .await?;
    verdict.map_err(|m| ApiError::new(StatusCode::FORBIDDEN, m))
}

/// Something changed in a project: wake the workers that react to it.
pub fn changed(app: &App) {
    app.wake_engine.notify_one();
    app.wake_runtime.notify_one();
}

fn to_json<T: serde::Serialize>(v: T) -> Json<Value> {
    Json(serde_json::to_value(v).unwrap_or(Value::Null))
}

async fn meta(State(app): State<Arc<App>>, ctx: Ctx) -> ApiResult<Json<Value>> {
    let access = ctx.access(&app, None).await?;
    let (meta, counts) = tracker(&app, &access, |t| Ok((t.meta()?, t.counts()?))).await?;
    // Team roles of the agent configuration available here, with their default models.
    let agents = app.agents();
    let team_roles: Vec<&crate::agent_config::RoleDef> =
        agents.roles.values().filter(|r| r.class != Role::Orchestrator && r.available_in(&access.project)).collect();
    let roles: Vec<&str> = team_roles.iter().map(|r| r.id.as_str()).collect();
    let mut role_models = serde_json::Map::new();
    for r in agents.roles.values() {
        let by_id = app.cfg.role_models.get(&r.id);
        let by_class = app.cfg.role_models.get(r.class.as_str());
        let model = r.model.clone().or_else(|| by_id.and_then(|d| d.model.clone())).or_else(|| by_class.and_then(|d| d.model.clone()));
        let thinking =
            r.thinking.clone().or_else(|| by_id.and_then(|d| d.thinking.clone())).or_else(|| by_class.and_then(|d| d.thinking.clone()));
        role_models.insert(r.id.clone(), json!({ "model": model, "thinking": thinking }));
    }
    Ok(Json(json!({
        "prefix": meta.prefix,
        "project": meta.project,
        "slug": access.project,
        "created": meta.created,
        "counts": counts,
        "statuses": Status::ALL,
        "roles": roles,
        "roleModels": role_models,
        "types": TaskType::ALL,
        "user": access.actor.name,
        "access": access.role,
        "server": "rust",
    })))
}

#[derive(Debug, Default, Deserialize)]
struct ListQuery {
    status: Option<String>,
    #[serde(rename = "type")]
    task_type: Option<String>,
    epics: Option<String>,
    closed: Option<String>,
    q: Option<String>,
    parent: Option<String>,
    team: Option<String>,
    label: Option<String>,
    ready: Option<String>,
}

/// Parse a comma list, ignoring unknown values (the TypeScript server does the same).
fn parse_list<T: std::str::FromStr>(v: &Option<String>) -> Vec<T> {
    v.as_deref().unwrap_or_default().split(',').filter_map(|s| s.trim().parse().ok()).collect()
}

async fn list(State(app): State<Arc<App>>, ctx: Ctx, Query(q): Query<ListQuery>) -> ApiResult<Json<Value>> {
    let access = ctx.access(&app, None).await?;
    let ready = q.ready.as_deref() == Some("1");
    let filter = ListFilter {
        status: parse_list(&q.status),
        task_type: parse_list(&q.task_type),
        exclude_epics: q.epics.as_deref() == Some("0"),
        include_closed: q.closed.as_deref() == Some("1"),
        search: q.q.filter(|s| !s.is_empty()),
        parent: q.parent.filter(|s| !s.is_empty()),
        team: q.team.filter(|s| !s.is_empty()),
        label: q.label.filter(|s| !s.is_empty()),
    };
    let rows = tracker(&app, &access, move |t| if ready { t.ready_queue() } else { t.list(&filter) }).await?;
    Ok(to_json(rows))
}

async fn show(State(app): State<Arc<App>>, ctx: Ctx, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let access = ctx.access(&app, None).await?;
    let (task, epic) = tracker(&app, &access, move |t| Ok((t.get(&id)?, t.epic_context(&id)?))).await?;
    let mut v = serde_json::to_value(task).unwrap_or_default();
    if let Some(e) = epic.epic {
        v["epic"] = json!({ "id": e.id, "title": e.title, "description": e.description, "artifacts": e.artifacts });
    }
    Ok(Json(v))
}

fn strings(v: &Value) -> Option<Vec<String>> {
    v.as_array().map(|a| {
        a.iter()
            .filter_map(|x| x.as_str().map(str::to_string).or_else(|| x.as_i64().map(|n| n.to_string())))
            .filter(|s| !s.is_empty())
            .collect()
    })
}

fn text(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Null => None,
        other => Some(other.to_string()),
    }
}

async fn create(State(app): State<Arc<App>>, ctx: Ctx, Json(b): Json<Value>) -> ApiResult<impl IntoResponse> {
    let access = ctx.access(&app, None).await?;
    access.write()?;
    if access.agent && access.actor.role != Role::Orchestrator {
        let parent = b["parent"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| ApiError::new(StatusCode::FORBIDDEN, "agents create only subtasks of their own task (pass parent)"))?;
        in_scope(&app, &access, parent, Touch::Edit).await?;
    }
    let input = CreateInput {
        title: b["title"].as_str().unwrap_or_default().to_string(),
        task_type: b["type"].as_str().and_then(|t| t.parse().ok()),
        description: b.get("description").and_then(text).filter(|s| !s.is_empty()),
        acceptance: strings(&b["acceptance"]).unwrap_or_default(),
        priority: b["priority"].as_i64(),
        parent: b["parent"].as_str().filter(|s| !s.is_empty()).map(str::to_string),
        deps: strings(&b["deps"]).unwrap_or_default(),
        labels: strings(&b["labels"]),
        merge_strategy: b["mergeStrategy"].as_str().map(str::to_string),
        // People submit to the inbox (the orchestrator takes it from there); agents create drafts.
        status: if access.is_human() && b["draft"] != json!(true) { Some(Status::Inbox) } else { None },
    };
    let actor = access.actor.clone();
    let task = tracker(&app, &access, move |t| t.create(&actor, input)).await?;
    changed(&app);
    Ok((StatusCode::CREATED, to_json(task)))
}

async fn update(State(app): State<Arc<App>>, ctx: Ctx, Path(id): Path<String>, Json(b): Json<Value>) -> ApiResult<Json<Value>> {
    let access = ctx.access(&app, None).await?;
    access.write()?;
    in_scope(&app, &access, &id, Touch::Edit).await?;
    let input = UpdateInput {
        title: b.get("title").and_then(text),
        task_type: b["type"].as_str().and_then(|t| t.parse().ok()),
        description: b.get("description").and_then(text),
        plan: b.get("plan").and_then(text),
        append_notes: b.get("appendNotes").and_then(text),
        notes: b.get("notes").and_then(text),
        priority: b["priority"].as_i64().or_else(|| b["priority"].as_str().and_then(|p| p.parse().ok())),
        labels: strings(&b["labels"]),
        assignees: strings(&b["assignees"]),
        merge_strategy: b.get("mergeStrategy").and_then(text),
        assignee: b.get("assignee").map(|v| v.as_str().map(|s| s.trim().trim_start_matches('@').to_lowercase()).filter(|s| !s.is_empty())),
        add_acceptance: strings(&b["addAcceptance"]).unwrap_or_default(),
        remove_acceptance: b["removeAcceptance"].as_array().map(|a| a.iter().filter_map(Value::as_i64).collect()).unwrap_or_default(),
        add_deps: strings(&b["addDeps"]).unwrap_or_default(),
        remove_deps: strings(&b["removeDeps"]).unwrap_or_default(),
        parent: match b.get("parent") {
            None => None,
            Some(Value::Null) => Some(None),
            Some(v) => Some(v.as_str().filter(|s| !s.is_empty()).map(str::to_string)),
        },
    };
    // The person responsible is someone who works in the project.
    let assigned = input.assignee.clone().flatten();
    if let Some(login) = assigned.clone() {
        let project = access.project.clone();
        let member = app
            .blocking(move |app| {
                app.with_server(|db| match db.user_by_login(&login)? {
                    Some(u) if !u.disabled => Ok(db.project_role(&project, &u)?.is_some()),
                    _ => Ok(false),
                })
            })
            .await?;
        if !member {
            return Err(ApiError::bad(format!("{} is not a member of this project", assigned.unwrap_or_default())));
        }
    }
    let before = match assigned {
        Some(_) => {
            tracker(&app, &access, {
                let id = id.clone();
                move |t| t.get(&id)
            })
            .await?
            .assignee
        }
        None => None,
    };
    let actor = access.actor.clone();
    let task = tracker(&app, &access, move |t| t.update(&actor, &id, input)).await?;
    // A new person responsible hears of it (not when they assign themselves).
    if let Some(login) = task.assignee.clone().filter(|l| before.as_ref() != Some(l) && *l != access.actor.name) {
        let (project, id, title, by) = (access.project.clone(), task.id.clone(), task.title.clone(), access.actor.name.clone());
        app.blocking(move |app| {
            let users = crate::notify::resolve(app, &project, &[format!("@{login}")], &json!({}))?;
            let msg = crate::notify::Message {
                kind: "assigned".into(),
                title: format!("{id}: вы ответственный"),
                body: format!("{title}\n\nНазначил(а): {by}"),
                project: Some(project.clone()),
                task: Some(id.clone()),
                link: Some(format!("/mine?task={id}")),
                ..Default::default()
            };
            crate::notify::send(app, &users, &msg, None).map(|_| ())
        })
        .await?;
    }
    changed(&app);
    Ok(to_json(task))
}

/// People named `@login` in a text who work in the project.
fn mentioned(app: &App, project: &str, text: &str) -> crate::state::AppResult<Vec<i64>> {
    let logins: std::collections::BTreeSet<String> = text
        .split(|c: char| c.is_whitespace() || ",;:!?()[]<>\"'«»".contains(c))
        .filter_map(|w| w.strip_prefix('@'))
        .map(|w| w.trim_end_matches(['.', '-']).to_lowercase())
        .filter(|w| !w.is_empty() && w.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)))
        .collect();
    app.with_server(|db| {
        let mut out = Vec::new();
        for login in logins {
            if let Some(u) = db.user_by_login(&login)?
                && !u.disabled
                && db.project_role(project, &u)?.is_some()
            {
                out.push(u.id);
            }
        }
        Ok(out)
    })
}

async fn status(State(app): State<Arc<App>>, ctx: Ctx, Path(id): Path<String>, Json(b): Json<Value>) -> ApiResult<Json<Value>> {
    let access = ctx.access(&app, None).await?;
    access.write()?;
    in_scope(&app, &access, &id, Touch::Edit).await?;
    let to_raw = b["status"].as_str().unwrap_or_default().to_string();
    let to: Status = to_raw.parse().map_err(|_| ApiError::bad(format!("unknown status {to_raw}")))?;
    // The owner's moves in the web UI are authoritative (as in the TypeScript server);
    // agents follow the workflow and may only force as orchestrator when asked to.
    // In an `assisted` project people close tasks; the orchestrator asks one instead.
    if !access.is_human() && access.actor.role == Role::Orchestrator && CLOSED.contains(&to) {
        let slug = access.project.clone();
        let autonomy = app.blocking(move |app| app.with_server(|db| db.project(&slug)).map(|p| p.autonomy)).await?;
        if autonomy == "assisted" {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "people close tasks in this project (assisted): move the task to needs_owner with a short summary of the result and what to check",
            ));
        }
    }
    let force = access.is_human() || (access.actor.role == Role::Orchestrator && b["force"] == json!(true));
    let opts = StatusOptions { note: b.get("note").and_then(text).filter(|n| !n.is_empty()), force };
    let actor = access.actor.clone();
    let task = tracker(&app, &access, move |t| t.set_status(&actor, &id, to, opts)).await?;
    if CLOSED.contains(&to) {
        crate::runtime::reap_closed(&app, &access.project).await;
    }
    changed(&app);
    Ok(to_json(task))
}

async fn comment(State(app): State<Arc<App>>, ctx: Ctx, Path(id): Path<String>, Json(b): Json<Value>) -> ApiResult<impl IntoResponse> {
    let access = ctx.access(&app, None).await?;
    access.write()?;
    in_scope(&app, &access, &id, Touch::Note).await?;
    let text = b["text"].as_str().unwrap_or_default().to_string();
    let kind =
        if access.is_human() { CommentKind::Owner } else { b["kind"].as_str().and_then(|k| k.parse().ok()).unwrap_or(CommentKind::Note) };
    let actor = access.actor.clone();
    let said = text.clone();
    let task = tracker(&app, &access, move |t| t.comment(&actor, &id, &text, kind)).await?;
    // People named with `@login` hear of it — from people and agents alike.
    if said.contains('@') {
        let (project, id, title, by) = (access.project.clone(), task.id.clone(), task.title.clone(), access.actor.name.clone());
        app.blocking(move |app| {
            let me = app.with_server(|db| db.user_by_login(&by))?.map(|u| u.id);
            let users: Vec<i64> = mentioned(app, &project, &said)?.into_iter().filter(|u| Some(*u) != me).collect();
            if users.is_empty() {
                return Ok(());
            }
            let excerpt: String = said.chars().take(500).collect();
            let msg = crate::notify::Message {
                kind: "mention".into(),
                title: format!("Вас упомянули в {id}"),
                body: format!("{by}: {excerpt}\n\n{title}"),
                project: Some(project.clone()),
                task: Some(id.clone()),
                link: Some(format!("/active?task={id}")),
                ..Default::default()
            };
            crate::notify::send(app, &users, &msg, None).map(|_| ())
        })
        .await?;
    }
    changed(&app);
    Ok((StatusCode::CREATED, to_json(task)))
}

async fn check(
    State(app): State<Arc<App>>,
    ctx: Ctx,
    Path((id, n)): Path<(String, i64)>,
    body: Option<Json<Value>>,
) -> ApiResult<Json<Value>> {
    let access = ctx.access(&app, None).await?;
    access.write()?;
    in_scope(&app, &access, &id, Touch::Edit).await?;
    let done = body.map(|Json(b)| b["done"] != json!(false)).unwrap_or(true);
    let actor = access.actor.clone();
    let task = tracker(&app, &access, move |t| t.check(&actor, &id, n, done)).await?;
    changed(&app);
    Ok(to_json(task))
}

async fn add_artifact(State(app): State<Arc<App>>, ctx: Ctx, Path(id): Path<String>, Json(b): Json<Value>) -> ApiResult<impl IntoResponse> {
    let access = ctx.access(&app, None).await?;
    access.write()?;
    in_scope(&app, &access, &id, Touch::Note).await?;
    let kind = b["kind"].as_str().and_then(|k| k.parse().ok()).or(Some(ArtifactKind::Doc));
    let content = match b["contentBase64"].as_str() {
        Some(b64) => base64::engine::general_purpose::STANDARD.decode(b64).map_err(|e| ApiError::bad(format!("contentBase64: {e}")))?,
        None => b["text"].as_str().unwrap_or_default().as_bytes().to_vec(),
    };
    let input = ArtifactInput {
        kind,
        source: ArtifactSource::Content(content),
        name: b["name"].as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string),
        note: b["note"].as_str().filter(|s| !s.is_empty()).map(str::to_string),
    };
    let actor = access.actor.clone();
    let task = tracker(&app, &access, move |t| t.add_artifact(&actor, &id, input)).await?;
    changed(&app);
    Ok((StatusCode::CREATED, to_json(task)))
}

/// PNG, JPEG, GIF or WebP by magic bytes (the only formats shown inline).
pub fn image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

#[derive(Deserialize, Default)]
struct ArtifactQuery {
    download: Option<String>,
    raw: Option<String>,
}

async fn read_artifact(
    State(app): State<Arc<App>>,
    ctx: Ctx,
    Path((id, n)): Path<(String, i64)>,
    Query(q): Query<ArtifactQuery>,
) -> ApiResult<Response> {
    let access = ctx.access(&app, None).await?;
    let a = tracker(&app, &access, move |t| t.read_artifact(&id, n)).await?;
    let safe_name: String = a.name.chars().filter(|c| *c != '"' && !c.is_control()).collect();
    if q.download.as_deref() == Some("1") {
        let mut h = HeaderMap::new();
        h.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/octet-stream"));
        if let Ok(v) = HeaderValue::from_str(&format!("attachment; filename=\"{safe_name}\"")) {
            h.insert(header::CONTENT_DISPOSITION, v);
        }
        return Ok((h, Bytes::from(a.content)).into_response());
    }
    let mime = image_mime(&a.content);
    if q.raw.as_deref() == Some("1") {
        let Some(mime) = mime else {
            return Err(ApiError::new(StatusCode::UNSUPPORTED_MEDIA_TYPE, "artifact is not a supported raster image"));
        };
        let mut h = HeaderMap::new();
        h.insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
        h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
        if let Ok(v) = HeaderValue::from_str(&format!("inline; filename=\"{safe_name}\"")) {
            h.insert(header::CONTENT_DISPOSITION, v);
        }
        return Ok((h, Bytes::from(a.content)).into_response());
    }
    let mut v = json!({ "name": a.name, "kind": a.kind, "size": a.content.len(), "text": a.text });
    if let Some(m) = mime {
        v["mime"] = json!(m);
    }
    Ok(Json(v).into_response())
}

async fn split(State(app): State<Arc<App>>, ctx: Ctx, Path(id): Path<String>, Json(b): Json<Value>) -> ApiResult<impl IntoResponse> {
    let access = ctx.access(&app, None).await?;
    access.write()?;
    in_scope(&app, &access, &id, Touch::Edit).await?;
    let children: Vec<CreateInput> = b["children"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|c| match c {
                    Value::String(title) => CreateInput { title: title.clone(), ..Default::default() },
                    c => CreateInput {
                        title: c["title"].as_str().unwrap_or_default().to_string(),
                        description: c["description"].as_str().map(str::to_string),
                        acceptance: strings(&c["acceptance"]).unwrap_or_default(),
                        priority: c["priority"].as_i64(),
                        deps: strings(&c["deps"]).unwrap_or_default(),
                        labels: strings(&c["labels"]),
                        ..Default::default()
                    },
                })
                .collect()
        })
        .unwrap_or_default();
    if children.is_empty() {
        return Err(ApiError::bad("children are required"));
    }
    let actor = access.actor.clone();
    let tasks = tracker(&app, &access, move |t| t.split(&actor, &id, children)).await?;
    changed(&app);
    Ok((StatusCode::CREATED, to_json(tasks)))
}

async fn block(State(app): State<Arc<App>>, ctx: Ctx, Path(id): Path<String>, Json(b): Json<Value>) -> ApiResult<Json<Value>> {
    let access = ctx.access(&app, None).await?;
    access.write()?;
    in_scope(&app, &access, &id, Touch::Edit).await?;
    let reason = b["reason"].as_str().unwrap_or_default().trim().to_string();
    if reason.is_empty() {
        return Err(ApiError::bad("reason is required"));
    }
    let actor = access.actor.clone();
    let task = tracker(&app, &access, move |t| t.block(&actor, &id, &reason)).await?;
    changed(&app);
    Ok(to_json(task))
}

async fn unblock(State(app): State<Arc<App>>, ctx: Ctx, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let access = ctx.access(&app, None).await?;
    access.write()?;
    in_scope(&app, &access, &id, Touch::Edit).await?;
    let actor = access.actor.clone();
    let task = tracker(&app, &access, move |t| t.unblock(&actor, &id)).await?;
    changed(&app);
    Ok(to_json(task))
}

#[derive(Debug, Deserialize)]
struct JournalQuery {
    after: Option<i64>,
    limit: Option<usize>,
}

/// Journal page for debugging and external subscribers: `?after=<id>&limit=<n>`.
async fn journal(State(app): State<Arc<App>>, ctx: Ctx, Query(q): Query<JournalQuery>) -> ApiResult<Json<Value>> {
    let access = ctx.access(&app, None).await?;
    let (after, limit) = (q.after.unwrap_or(0), q.limit.unwrap_or(100).min(1000));
    let (events, last) = tracker(&app, &access, move |t| Ok((t.events_after(after, limit)?, t.last_event_id()?))).await?;
    Ok(Json(json!({ "events": events, "last": last })))
}

//! The agent side of the bus: deliveries into live sessions (lease, ack,
//! release), asks and replies, full messages, the team board, peeking into an
//! agent's session and pausing agents.

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use genie_core::team::{self, ORCHESTRATOR, SendMail};
use genie_core::{Capability, Role};
use serde::Deserialize;
use serde_json::{Value, json};

use super::ctx::{Access, Ctx};
use super::{ApiError, ApiResult};
use crate::runtime::AgentKey;
use crate::state::App;

pub fn routes() -> Router<Arc<App>> {
    Router::new()
        .route("/agent/inbox/lease", post(lease))
        .route("/agent/inbox/ack", post(ack))
        .route("/agent/inbox/release", post(release))
        .route("/agent/mail/{id}", get(mail))
        .route("/agent/ask", post(ask))
        .route("/agent/reply", post(reply))
        .route("/agents", get(board))
        .route("/agents/{team}/{member}/peek", get(peek))
        .route("/agents/{team}/{member}/pause", post(pause))
        .route("/agents/{team}/{member}/resume", post(resume))
}

/// The mailbox of the calling agent: `(team, recipient)`.
fn own_mailbox(access: &Access) -> ApiResult<(Option<String>, String)> {
    if !access.agent {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "only agents have a session inbox"));
    }
    if access.actor.role == Role::Orchestrator {
        return Ok((None, ORCHESTRATOR.to_string()));
    }
    match &access.agent_team {
        Some(t) => Ok((Some(t.clone()), access.actor.name.clone())),
        None => Err(ApiError::new(StatusCode::FORBIDDEN, "only team members and the orchestrator have a session inbox")),
    }
}

fn wake(app: &App) {
    app.wake_runtime.notify_one();
}

#[derive(Deserialize, Default)]
struct LeaseBody {
    #[serde(default)]
    seen: Vec<i64>,
}

async fn lease(State(app): State<Arc<App>>, ctx: Ctx, Json(b): Json<LeaseBody>) -> ApiResult<Json<Value>> {
    let access = ctx.access(&app, None).await?;
    let (team, recipient) = own_mailbox(&access)?;
    let slug = access.project.clone();
    let budget = app.cfg.runtime.delivery_budget.max(500);
    let delivery = app
        .blocking(move |app| {
            app.with_tracker(&slug, |t| {
                t.bus().lease_delivery(team.as_deref(), &recipient, &b.seen[b.seen.len().saturating_sub(500)..], budget)
            })
        })
        .await?;
    Ok(Json(match delivery {
        None => json!({ "delivery": null }),
        Some(d) => json!({
            "delivery": d.id,
            "ids": d.mails.iter().map(|m| m.id).collect::<Vec<_>>(),
            "more": d.more,
            "text": team::render_delivery(&d, access.actor.role == Role::Orchestrator),
        }),
    }))
}

#[derive(Deserialize)]
struct DeliveryBody {
    delivery: i64,
}

async fn ack(State(app): State<Arc<App>>, ctx: Ctx, Json(b): Json<DeliveryBody>) -> ApiResult<Json<Value>> {
    let access = ctx.access(&app, None).await?;
    let (_, recipient) = own_mailbox(&access)?;
    let slug = access.project.clone();
    let n = app.blocking(move |app| app.with_tracker(&slug, |t| t.bus().ack_delivery(b.delivery, &recipient))).await?;
    Ok(Json(json!({ "ok": true, "delivered": n })))
}

async fn release(State(app): State<Arc<App>>, ctx: Ctx, Json(b): Json<DeliveryBody>) -> ApiResult<Json<Value>> {
    let access = ctx.access(&app, None).await?;
    let (_, recipient) = own_mailbox(&access)?;
    let slug = access.project.clone();
    let n = app
        .blocking(move |app| {
            app.with_tracker(&slug, |t| {
                let owner = t.bus().open_deliveries("9999")?.into_iter().find(|d| d.id == b.delivery).map(|d| d.recipient);
                if owner.as_deref().is_some_and(|o| o != recipient) {
                    return Err(genie_core::GenieError::Denied(format!("delivery {} is not yours", b.delivery)));
                }
                t.bus().release_delivery(b.delivery)
            })
        })
        .await?;
    wake(&app);
    Ok(Json(json!({ "ok": true, "released": n })))
}

async fn mail(State(app): State<Arc<App>>, ctx: Ctx, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let access = ctx.access(&app, None).await?;
    let slug = access.project.clone();
    let m = app
        .blocking(move |app| {
            app.with_tracker(&slug, |t| t.bus().mail(id).map_err(|_| genie_core::GenieError::not_found(format!("message {id} not found"))))
        })
        .await?;
    if access.agent && access.actor.role != Role::Orchestrator {
        let me = &access.actor.name;
        if (&m.to != me && &m.from != me) || m.team != access.agent_team {
            return Err(ApiError::new(StatusCode::FORBIDDEN, format!("message {id} is not yours")));
        }
    }
    Ok(Json(json!(m)))
}

#[derive(Deserialize)]
struct AskBody {
    to: String,
    text: String,
    team: Option<String>,
    timeout: Option<u64>,
}

/// Ask a teammate and wait for the answer (at most `runtime.askTimeoutSecs` by default).
async fn ask(State(app): State<Arc<App>>, ctx: Ctx, Json(b): Json<AskBody>) -> ApiResult<Json<Value>> {
    let access = ctx.access(&app, None).await?;
    access.write()?;
    if !access.agent {
        return Err(ApiError::bad("asks are for agents; people answer questions in the task or the chat"));
    }
    let team = b.team.clone().or_else(|| access.agent_team.clone()).ok_or_else(|| ApiError::bad("which team? pass team"))?;
    if access.actor.role != Role::Orchestrator && access.agent_team.as_deref() != Some(team.as_str()) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, format!("team {team} is not your team")));
    }
    access.can(if b.to == ORCHESTRATOR { Capability::MailOrchestrator } else { Capability::MailTeam })?;
    let (slug, role) = (access.project.clone(), access.actor.role);
    let me = if role == Role::Orchestrator { ORCHESTRATOR.to_string() } else { access.actor.name.clone() };
    let (to, text, t2, me2) = (b.to.clone(), b.text.clone(), team.clone(), me.clone());
    let asked = app
        .blocking(move |app| {
            app.with_tracker(&slug, |t| {
                t.bus().send(SendMail {
                    team: &t2,
                    from: &me2,
                    from_role: role.as_str(),
                    to: &to,
                    text: &text,
                    level: Some("high"),
                    intent: Some("question"),
                    kind: "message",
                    awaits: true,
                    ..Default::default()
                })
            })
        })
        .await?;
    let Some(ask) = asked.first().cloned() else { return Err(ApiError::bad("nobody to ask")) };
    if asked.len() > 1 {
        return Err(ApiError::bad("ask one teammate (not all); broadcast with `genie agent send all`"));
    }
    wake(&app);
    let limit = Duration::from_secs(b.timeout.unwrap_or(app.cfg.runtime.ask_timeout_secs).clamp(1, 1800));
    let start = Instant::now();
    loop {
        let (slug, me) = (access.project.clone(), me.clone());
        let reply = app.blocking(move |app| app.with_tracker(&slug, |t| t.bus().take_reply(ask.id, &me))).await?;
        if let Some(r) = reply {
            return Ok(Json(json!({ "asked": ask.id, "reply": r, "waited": start.elapsed().as_secs_f64() })));
        }
        if start.elapsed() >= limit {
            return Ok(Json(json!({ "asked": ask.id, "reply": null, "waited": start.elapsed().as_secs_f64() })));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

#[derive(Deserialize)]
struct ReplyBody {
    id: i64,
    text: String,
}

async fn reply(State(app): State<Arc<App>>, ctx: Ctx, Json(b): Json<ReplyBody>) -> ApiResult<Json<Value>> {
    let access = ctx.access(&app, None).await?;
    access.write()?;
    let (slug, role) = (access.project.clone(), access.actor.role);
    let me = if role == Role::Orchestrator { ORCHESTRATOR.to_string() } else { access.actor.name.clone() };
    let sent = app.blocking(move |app| app.with_tracker(&slug, |t| t.bus().reply(&me, role.as_str(), b.id, &b.text))).await?;
    wake(&app);
    Ok(Json(json!(sent)))
}

/// Every agent of the project: session state, current step, waiting mail.
async fn board(State(app): State<Arc<App>>, ctx: Ctx) -> ApiResult<Json<Value>> {
    let access = ctx.access(&app, None).await?;
    let slug = access.project.clone();
    let (teams, orch_pending) = app
        .blocking(move |app| {
            app.with_tracker(&slug, |t| {
                let teams = t.bus().list(false)?;
                let mut out = Vec::new();
                for team in teams {
                    let mut members = Vec::new();
                    for m in &team.members {
                        members.push((m.clone(), t.bus().pending_count(&team.id, &m.name)?));
                    }
                    out.push((team, members));
                }
                Ok((out, t.bus().pending(None, ORCHESTRATOR)?.len()))
            })
        })
        .await?;
    let slug = access.project.clone();
    let live = |key: AgentKey| app.sessions.get(&key).map(|s| json!(s.live()));
    let mut agents = vec![json!({
        "agent": ORCHESTRATOR,
        "role": "orchestrator",
        "pending": orch_pending,
        "session": live(AgentKey::Orchestrator { project: slug.clone() }),
    })];
    for (team, members) in teams {
        for (m, pending) in members {
            agents.push(json!({
                "agent": format!("{}/{}", team.id, m.name),
                "team": team.id,
                "task": team.task,
                "name": m.name,
                "role": m.role,
                "state": m.state,
                "activity": m.activity,
                "status": m.status,
                "pending": pending,
                "session": live(AgentKey::Member { project: slug.clone(), team: team.id.clone(), member: m.name.clone() }),
            }));
        }
    }
    let slug = access.project.clone();
    let since = (chrono::Utc::now() - chrono::Duration::hours(24)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let latencies = app.blocking(move |app| app.with_tracker(&slug, |t| t.bus().delivery_latencies(&since))).await?;
    Ok(Json(json!({
        "mode": if app.cfg.runtime.live_sessions() { "sessions" } else { "turns" },
        "agents": agents,
        "latency": latency_stats(latencies),
    })))
}

/// Delivery latency over the last day by level: count, median and 95th percentile (seconds).
fn latency_stats(samples: Vec<(String, f64)>) -> Value {
    let mut by: std::collections::BTreeMap<String, Vec<f64>> = Default::default();
    for (level, secs) in samples {
        by.entry(level).or_default().push(secs.max(0.0));
    }
    let pct = |v: &[f64], p: f64| v[((v.len() as f64 - 1.0) * p).round() as usize];
    let mut out = serde_json::Map::new();
    for (level, mut v) in by {
        v.sort_by(|a, b| a.total_cmp(b));
        out.insert(level, json!({ "count": v.len(), "p50": pct(&v, 0.5), "p95": pct(&v, 0.95) }));
    }
    Value::Object(out)
}

#[derive(Deserialize, Default)]
struct PeekQuery {
    deep: Option<String>,
}

fn key_of(project: &str, team: &str, member: &str) -> AgentKey {
    if member == ORCHESTRATOR || team == ORCHESTRATOR {
        AgentKey::Orchestrator { project: project.to_string() }
    } else {
        AgentKey::Member { project: project.to_string(), team: team.to_string(), member: member.to_string() }
    }
}

/// What an agent is doing now; `deep` adds the latest messages of its conversation.
async fn peek(
    State(app): State<Arc<App>>,
    ctx: Ctx,
    Path((team, member)): Path<(String, String)>,
    Query(q): Query<PeekQuery>,
) -> ApiResult<Json<Value>> {
    let access = ctx.access(&app, None).await?;
    if access.agent && access.actor.role != Role::Orchestrator && access.agent_team.as_deref() != Some(team.as_str()) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, format!("team {team} is not your team")));
    }
    access.can(Capability::TeamPeek)?;
    let key = key_of(&access.project, &team, &member);
    let Some(s) = app.sessions.get(&key) else {
        return Ok(Json(json!({ "agent": key.label(), "session": null })));
    };
    let mut out = json!({ "agent": key.label(), "session": s.live() });
    if q.deep.as_deref().is_some_and(|d| d != "0") {
        let messages = s.request(json!({ "type": "get_messages" }), Duration::from_secs(5)).await;
        let list = messages.as_ref().and_then(|r| r["data"]["messages"].as_array().cloned()).unwrap_or_default();
        out["conversation"] = json!(list.iter().rev().take(12).collect::<Vec<_>>().into_iter().rev().map(brief).collect::<Vec<_>>());
    }
    Ok(Json(out))
}

/// One conversation message, short.
fn brief(m: &Value) -> Value {
    let clip = |s: &str, n: usize| {
        let flat = s.split_whitespace().collect::<Vec<_>>().join(" ");
        if flat.chars().count() > n { format!("{}…", flat.chars().take(n).collect::<String>()) } else { flat }
    };
    let role = m["customType"].as_str().map(|c| format!("custom:{c}")).unwrap_or_else(|| m["role"].as_str().unwrap_or("?").to_string());
    let mut parts = Vec::new();
    match &m["content"] {
        Value::String(s) => parts.push(clip(s, 500)),
        Value::Array(blocks) => {
            for b in blocks {
                match b["type"].as_str() {
                    Some("text") => parts.push(clip(b["text"].as_str().unwrap_or_default(), 500)),
                    Some("thinking") => parts.push(format!("(thinking) {}", clip(b["thinking"].as_str().unwrap_or_default(), 300))),
                    Some("toolCall") => {
                        parts.push(format!("→ {} {}", b["name"].as_str().unwrap_or("tool"), clip(&b["arguments"].to_string(), 200)))
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
    json!({ "role": role, "text": parts.join("\n") })
}

async fn set_paused(app: Arc<App>, ctx: Ctx, team: String, member: String, paused: bool) -> ApiResult<Json<Value>> {
    let access = ctx.access(&app, None).await?;
    access.write()?;
    if access.agent && access.actor.role != Role::Orchestrator {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "only the orchestrator (or a person) pauses an agent"));
    }
    let (slug, by, t2, m2) = (access.project.clone(), access.actor.name.clone(), team.clone(), member.clone());
    app.blocking(move |app| app.with_tracker(&slug, |t| t.bus().set_paused(&t2, &m2, paused, &by))).await?;
    let key = key_of(&access.project, &team, &member);
    if paused {
        crate::sessions::reset(&app, &key);
    }
    wake(&app);
    Ok(Json(json!({ "ok": true, "agent": key.label(), "paused": paused })))
}

async fn pause(State(app): State<Arc<App>>, ctx: Ctx, Path((team, member)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    set_paused(app, ctx, team, member, true).await
}

async fn resume(State(app): State<Arc<App>>, ctx: Ctx, Path((team, member)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    set_paused(app, ctx, team, member, false).await
}

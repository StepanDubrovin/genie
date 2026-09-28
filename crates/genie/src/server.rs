//! `genie serve`: HTTP API + SSE for the web UI.
//!
//! Ф0 scope: read routes compatible with the TypeScript server (`src/web/server.ts`)
//! and a live stream backed by the event journal. Write routes, teams, docs and
//! auth follow in the next steps of the port (see docs/platform/roadmap.md).
//!
//! Protections match the TypeScript server: the server binds to loopback and
//! checks the Host header against an allowlist (DNS rebinding).

use std::collections::HashSet;
use std::convert::Infallible;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::{Path, Query, Request, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use futures_util::stream::{self, Stream};
use genie_core::{GenieError, ListFilter, MEMBER_ROLES, Status, TaskType, Tracker};
use serde::Deserialize;
use serde_json::{Value, json};
use tower_http::services::{ServeDir, ServeFile};

#[derive(Clone)]
pub struct AppState {
    tracker: Arc<Mutex<Tracker>>,
    hosts: Arc<HashSet<String>>,
}

impl AppState {
    pub fn new(tracker: Tracker, port: u16, extra_hosts: &[String]) -> Self {
        let mut hosts: HashSet<String> = ["127.0.0.1", "localhost", "[::1]"].iter().map(|h| format!("{h}:{port}")).collect();
        hosts.extend(extra_hosts.iter().cloned());
        AppState { tracker: Arc::new(Mutex::new(tracker)), hosts: Arc::new(hosts) }
    }

    /// Run a tracker operation off the async runtime: SQLite calls are blocking.
    async fn with<T: Send + 'static>(&self, f: impl FnOnce(&Tracker) -> Result<T, GenieError> + Send + 'static) -> Result<T, ApiError> {
        let tracker = self.tracker.clone();
        tokio::task::spawn_blocking(move || {
            let t = tracker.lock().map_err(|_| ApiError::internal("tracker lock poisoned"))?;
            f(&t).map_err(ApiError::from)
        })
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
    }
}

pub struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn internal(message: impl Into<String>) -> Self {
        ApiError { status: StatusCode::INTERNAL_SERVER_ERROR, message: message.into() }
    }
}

impl From<GenieError> for ApiError {
    fn from(e: GenieError) -> Self {
        // Same contract as the TypeScript server: every domain error is 422 with its message.
        let status = match e {
            GenieError::Denied(_) | GenieError::NotFound(_) | GenieError::Invalid(_) => StatusCode::UNPROCESSABLE_ENTITY,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        };
        ApiError { status, message: e.to_string() }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "error": self.message }))).into_response()
    }
}

pub fn app(state: AppState, web_root: PathBuf) -> Router {
    let api = Router::new()
        .route("/health", get(health))
        .route("/meta", get(meta))
        .route("/tasks", get(list_tasks))
        .route("/tasks/{id}", get(get_task))
        .route("/journal", get(journal))
        .route("/events", get(live))
        .fallback(|| async { ApiError { status: StatusCode::NOT_FOUND, message: "not found".into() } });
    let index = web_root.join("index.html");
    let router = Router::new().nest("/api", api);
    // Client-side routes (/board, /team/G-7…) fall back to the SPA entry.
    let router = if index.exists() {
        router.fallback_service(ServeDir::new(&web_root).fallback(ServeFile::new(index)))
    } else {
        router.fallback(|| async {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "genie web UI is not built yet: run `npm install && npm run build:web` in the genie repository",
            )
        })
    };
    router.layer(middleware::from_fn_with_state(state.clone(), check_host)).with_state(state)
}

async fn check_host(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let host = req.headers().get(header::HOST).and_then(|h| h.to_str().ok()).unwrap_or_default();
    if !state.hosts.contains(host) {
        return ApiError { status: StatusCode::MISDIRECTED_REQUEST, message: "unexpected Host header".into() }.into_response();
    }
    next.run(req).await
}

async fn health() -> Json<Value> {
    Json(json!({ "ok": true, "version": env!("CARGO_PKG_VERSION") }))
}

async fn meta(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    state
        .with(|t| {
            let m = t.meta()?;
            Ok(Json(json!({
                "prefix": m.prefix,
                "project": m.project,
                "created": m.created,
                "counts": t.counts()?,
                "statuses": Status::ALL,
                "roles": MEMBER_ROLES,
                "types": TaskType::ALL,
                "user": "owner",
                "server": "rust",
            })))
        })
        .await
}

#[derive(Debug, Default, Deserialize)]
pub struct TaskQuery {
    status: Option<String>,
    #[serde(rename = "type")]
    task_type: Option<String>,
    epics: Option<String>,
    closed: Option<String>,
    q: Option<String>,
    parent: Option<String>,
}

/// Parse a comma list, ignoring unknown values (the TypeScript server does the same).
fn parse_list<T: std::str::FromStr>(v: &Option<String>) -> Vec<T> {
    v.as_deref().unwrap_or_default().split(',').filter_map(|s| s.parse().ok()).collect()
}

async fn list_tasks(State(state): State<AppState>, Query(q): Query<TaskQuery>) -> Result<Json<Value>, ApiError> {
    let filter = ListFilter {
        status: parse_list(&q.status),
        task_type: parse_list(&q.task_type),
        exclude_epics: q.epics.as_deref() == Some("0"),
        include_closed: q.closed.as_deref() == Some("1"),
        search: q.q.filter(|s| !s.is_empty()),
        parent: q.parent.filter(|s| !s.is_empty()),
        ..Default::default()
    };
    state.with(move |t| Ok(Json(serde_json::to_value(t.list(&filter)?)?))).await
}

async fn get_task(State(state): State<AppState>, Path(id): Path<String>) -> Result<Json<Value>, ApiError> {
    state.with(move |t| Ok(Json(serde_json::to_value(t.get(&id)?)?))).await
}

#[derive(Debug, Deserialize)]
pub struct JournalQuery {
    after: Option<i64>,
    limit: Option<usize>,
}

/// Journal page for debugging and external subscribers: `?after=<id>&limit=<n>`.
async fn journal(State(state): State<AppState>, Query(q): Query<JournalQuery>) -> Result<Json<Value>, ApiError> {
    let (after, limit) = (q.after.unwrap_or(0), q.limit.unwrap_or(100).min(1000));
    state.with(move |t| Ok(Json(json!({ "events": t.events_after(after, limit)?, "last": t.last_event_id()? })))).await
}

struct LiveCursor {
    state: AppState,
    last_event: i64,
    data_version: i64,
    pending: std::collections::VecDeque<SseEvent>,
}

/// Live stream for the web UI.
///
/// - `event: journal` carries each journal event with `id:` = event id, so a
///   reconnecting client resumes with `Last-Event-ID`;
/// - `event: change` is what the current SPA listens to. It also fires when
///   another process (the TypeScript tools during the migration) commits,
///   detected with `PRAGMA data_version`.
async fn live(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Sse<impl Stream<Item = Result<SseEvent, Infallible>>>, ApiError> {
    let resume = headers.get("last-event-id").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<i64>().ok());
    let (last_event, data_version) = state
        .with(move |t| {
            let dv: i64 = t.conn().query_row("PRAGMA data_version", [], |r| r.get(0))?;
            Ok((resume.unwrap_or(t.last_event_id()?), dv))
        })
        .await?;
    let cursor = LiveCursor { state, last_event, data_version, pending: Default::default() };
    let events = stream::unfold(cursor, |mut c| async move {
        loop {
            if let Some(ev) = c.pending.pop_front() {
                return Some((Ok(ev), c));
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
            let after = c.last_event;
            let polled = c
                .state
                .with(move |t| {
                    let dv: i64 = t.conn().query_row("PRAGMA data_version", [], |r| r.get(0))?;
                    Ok((t.events_after(after, 200)?, dv))
                })
                .await;
            let Ok((events, dv)) = polled else { continue };
            let changed = !events.is_empty() || dv != c.data_version;
            c.data_version = dv;
            for e in events {
                c.last_event = e.id;
                if let Ok(ev) = SseEvent::default().event("journal").id(e.id.to_string()).json_data(&e) {
                    c.pending.push_back(ev);
                }
            }
            if changed {
                c.pending.push_back(SseEvent::default().event("change").data(c.last_event.to_string()));
            }
        }
    });
    let head = stream::once(async { Ok(SseEvent::default().retry(Duration::from_secs(2)).comment("genie")) });
    Ok(Sse::new(futures_util::StreamExt::chain(head, events)).keep_alive(KeepAlive::default()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request as HttpRequest;
    use genie_core::{Actor, CreateInput, Role};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn setup() -> (tempfile::TempDir, Router) {
        let dir = tempfile::tempdir().unwrap();
        let t = Tracker::init(dir.path().join(".genie"), None, Some("demo")).unwrap();
        let orch = Actor::new("orchestrator", Role::Orchestrator);
        let epic = CreateInput { title: "Returns".into(), task_type: Some(TaskType::Epic), ..Default::default() };
        t.create(&orch, epic).unwrap();
        let child =
            CreateInput { title: "Reason codes".into(), parent: Some("G-1".into()), acceptance: vec!["a".into()], ..Default::default() };
        t.create(&orch, child).unwrap();
        let app = app(AppState::new(t, 7420, &[]), dir.path().join("no-web"));
        (dir, app)
    }

    async fn call(app: &Router, uri: &str) -> (StatusCode, Value) {
        let req = HttpRequest::get(uri).header(header::HOST, "127.0.0.1:7420").body(Body::empty()).unwrap();
        let res = app.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::String(String::from_utf8_lossy(&bytes).into())))
    }

    #[tokio::test]
    async fn meta_and_task_routes_keep_the_typescript_json_shape() {
        let (_d, app) = setup();
        let (status, meta) = call(&app, "/api/meta").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(meta["project"], "demo");
        assert_eq!(meta["counts"]["draft"], 2);
        assert_eq!(meta["statuses"][4], "in_progress");

        let (_, list) = call(&app, "/api/tasks?epics=0").await;
        let ids: Vec<_> = list.as_array().unwrap().iter().map(|t| t["id"].as_str().unwrap().to_string()).collect();
        assert_eq!(ids, vec!["G-2"]);
        let row = &list[0];
        assert_eq!(row["parent"], "G-1");
        assert_eq!(row["acceptanceTotal"], 1);
        assert_eq!(row["type"], "task");
        assert!(row.get("team").is_none(), "absent optionals are omitted like JSON.stringify(undefined)");

        let (_, epics) = call(&app, "/api/tasks?type=epic,bogus").await;
        assert_eq!(epics[0]["children"], 1);

        let (status, task) = call(&app, "/api/tasks/g-2").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(task["mergeStrategy"], "");
        assert_eq!(task["acceptance"][0]["done"], false);
        assert_eq!(task["history"][0]["event"], "created");
    }

    #[tokio::test]
    async fn domain_errors_are_422_and_unknown_routes_404() {
        let (_d, app) = setup();
        let (status, body) = call(&app, "/api/tasks/G-99").await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(body["error"], "task G-99 not found");
        let (status, _) = call(&app, "/api/nope").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, body) = call(&app, "/board").await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert!(body.as_str().unwrap().contains("npm run build:web"));
    }

    #[tokio::test]
    async fn journal_pages_through_events() {
        let (_d, app) = setup();
        let (_, page) = call(&app, "/api/journal?after=0&limit=1").await;
        assert_eq!(page["events"][0]["type"], "task.created");
        assert_eq!(page["events"][0]["subject"], "G-1");
        assert_eq!(page["last"], 2);
        let (_, rest) = call(&app, "/api/journal?after=1").await;
        assert_eq!(rest["events"][0]["subject"], "G-2");
    }

    #[tokio::test]
    async fn foreign_host_headers_are_rejected() {
        let (_d, app) = setup();
        let req = HttpRequest::get("/api/meta").header(header::HOST, "evil.example:7420").body(Body::empty()).unwrap();
        assert_eq!(app.clone().oneshot(req).await.unwrap().status(), StatusCode::MISDIRECTED_REQUEST);
    }
}

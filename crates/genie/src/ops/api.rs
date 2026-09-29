//! How an operation reaches the server's API: over HTTP with a token (the
//! command line of an agent or a person), or inside the server's process —
//! with the caller's token (the MCP server) or as the operator (the command line
//! on the server's machine, without a token: whoever reads the data directory
//! runs the server anyway).

use std::net::SocketAddr;

use axum::Router;
use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{Request, header};
use futures_util::future::BoxFuture;
use serde_json::Value;
use tower::ServiceExt;

/// With the project header: that project or an error, never another project of the caller.
pub const STRICT: &str = "x-genie-project-strict";

/// A request as the handlers of the server see it; the answer is its JSON, a
/// failure the server's error message.
pub trait Api: Send + Sync {
    fn call<'a>(&'a self, method: &'a str, path: &'a str, body: Option<Value>) -> BoxFuture<'a, Result<Value, String>>;
    /// Where the calls go, for messages.
    fn place(&self) -> String;
}

/// The server over HTTP with a bearer token.
pub struct Remote {
    http: reqwest::Client,
    base: String,
    token: String,
    /// The project to act in; a person's token reaches every project of theirs.
    project: Option<String>,
}

impl Remote {
    pub fn new(base: &str, token: &str, project: Option<String>) -> Remote {
        Remote { http: reqwest::Client::new(), base: base.trim_end_matches('/').to_string(), token: token.to_string(), project }
    }
}

impl Api for Remote {
    fn call<'a>(&'a self, method: &'a str, path: &'a str, body: Option<Value>) -> BoxFuture<'a, Result<Value, String>> {
        Box::pin(async move {
            let url = format!("{}/api{path}", self.base);
            let host = self.base.split("://").nth(1).unwrap_or("127.0.0.1:7420").split('/').next().unwrap_or_default().to_string();
            let mut req = self
                .http
                .request(method.parse().map_err(|_| "bad method".to_string())?, &url)
                .bearer_auth(&self.token)
                .header("host", host)
                .header("x-genie", "1");
            if let Some(p) = &self.project {
                req = req.header("x-genie-project", p).header(STRICT, "1");
            }
            if let Some(b) = body {
                req = req.json(&b);
            }
            let res = req.send().await.map_err(|e| format!("cannot reach genie at {}: {e}", self.base))?;
            let status = res.status();
            let v: Value = res.json().await.unwrap_or(Value::Null);
            if !status.is_success() {
                return Err(v["error"].as_str().map(str::to_string).unwrap_or_else(|| format!("HTTP {status}")));
            }
            Ok(v)
        })
    }

    fn place(&self) -> String {
        self.base.clone()
    }
}

/// Who calls inside the server's process.
#[derive(Clone)]
pub enum Auth {
    /// A person's or an agent's token, as over HTTP.
    Bearer(String),
    /// The operator of the server's machine: a server admin.
    Operator,
}

/// Marks a request made inside the server's process by the operator. Requests
/// from the network never carry it: extensions exist only inside the process.
#[derive(Clone, Copy, Debug)]
pub struct OperatorAccess;

/// The server's router, called without the network.
pub struct InProcess {
    router: Router,
    port: u16,
    auth: Auth,
    /// The project to act in (`X-Genie-Project`).
    project: Option<String>,
}

impl InProcess {
    pub fn new(router: Router, port: u16, auth: Auth, project: Option<String>) -> InProcess {
        InProcess { router, port, auth, project }
    }
}

impl Api for InProcess {
    fn call<'a>(&'a self, method: &'a str, path: &'a str, body: Option<Value>) -> BoxFuture<'a, Result<Value, String>> {
        Box::pin(async move {
            let mut req = Request::builder()
                .method(method)
                .uri(format!("/api{path}"))
                .header(header::HOST, format!("127.0.0.1:{}", self.port))
                .header("x-genie", "1");
            if let Some(p) = &self.project {
                req = req.header("x-genie-project", p).header(STRICT, "1");
            }
            if let Auth::Bearer(token) = &self.auth {
                req = req.header(header::AUTHORIZATION, format!("Bearer {token}"));
            }
            let mut req = match body {
                Some(b) => req.header(header::CONTENT_TYPE, "application/json").body(Body::from(b.to_string())),
                None => req.body(Body::empty()),
            }
            .map_err(|e| e.to_string())?;
            req.extensions_mut().insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 0))));
            if matches!(self.auth, Auth::Operator) {
                req.extensions_mut().insert(OperatorAccess);
            }
            let res = self.router.clone().oneshot(req).await.map_err(|e| e.to_string())?;
            let status = res.status();
            let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024 * 1024).await.map_err(|e| e.to_string())?;
            let v: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
            if !status.is_success() {
                return Err(v["error"].as_str().map(str::to_string).unwrap_or_else(|| format!("HTTP {status}")));
            }
            Ok(v)
        })
    }

    fn place(&self) -> String {
        "the local server data".into()
    }
}

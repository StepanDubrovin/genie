//! Git hosts: `<data>/git.json`.
//!
//! ```json
//! { "hosts": {
//!     "gitlab": { "kind": "gitlab", "url": "https://git.company.local",
//!                 "token": "${GITLAB_TOKEN}", "ca_cert": "/etc/ssl/company-ca.pem" },
//!     "github": { "kind": "github", "url": "https://github.com", "token_file": "/run/secrets/github_token" }
//! } }
//! ```
//!
//! The file is read at each use, so a rotated token or a new host applies without
//! a restart. Secrets are `${ENV}` references or files — never stored in the
//! database or shown by the API — and agents never receive them: their names go
//! into [`secret_vars`], which the runtime removes from an agent's environment.
//! The token of the host is the default: a repository of a project may have its own,
//! kept sealed in the server database (`genie_core::secrets`), which wins over it.

use std::collections::BTreeMap;
use std::path::Path;

use base64::Engine;
use serde::{Deserialize, Serialize};

/// What a host is: it decides the API that pull/merge requests go through.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Github,
    Gitlab,
    /// Any git server: transport only, no pull/merge request API.
    Plain,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Github => "github",
            Kind::Gitlab => "gitlab",
            Kind::Plain => "plain",
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields, default)]
struct CloneUrls {
    https: Option<String>,
    ssh: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields, default)]
pub struct Identity {
    /// The author of the agents' commits.
    pub name: Option<String>,
    pub email: Option<String>,
    /// The bot's login on the host (shown in the check).
    pub login: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Raw {
    kind: Kind,
    url: String,
    #[serde(default)]
    api_url: Option<String>,
    #[serde(default)]
    token: Option<String>,
    #[serde(default)]
    token_file: Option<String>,
    /// `https` (default) or `ssh`: how the server reaches the repositories. The API always uses the token.
    #[serde(default)]
    transport: Option<String>,
    #[serde(default)]
    ssh_key: Option<String>,
    /// The `ssh` program (default `ssh`): a wrapper for jump hosts or a company's own client.
    #[serde(default)]
    ssh_command: Option<String>,
    #[serde(default)]
    known_hosts: Option<String>,
    #[serde(default)]
    ca_cert: Option<String>,
    #[serde(default)]
    http_proxy: Option<String>,
    #[serde(default)]
    insecure_skip_verify: bool,
    #[serde(default)]
    clone_urls: CloneUrls,
    #[serde(default)]
    identity: Identity,
    /// Seconds between checks of open requests (default 60).
    #[serde(default)]
    poll_secs: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
struct File {
    #[serde(default)]
    hosts: BTreeMap<String, serde_json::Value>,
}

/// A host with its secrets resolved.
#[derive(Debug, Clone)]
pub struct Host {
    pub id: String,
    pub kind: Kind,
    pub url: String,
    pub api_url: Option<String>,
    pub token: Option<String>,
    pub ssh: bool,
    pub ssh_key: Option<String>,
    pub ssh_command: Option<String>,
    pub known_hosts: Option<String>,
    pub ca_cert: Option<String>,
    pub http_proxy: Option<String>,
    pub insecure_skip_verify: bool,
    https_template: Option<String>,
    ssh_template: Option<String>,
    pub identity: Identity,
    pub poll_secs: u64,
    /// Environment variables the token was read from and found empty or missing.
    pub missing: Vec<String>,
}

/// The hosts of the file and what is wrong with the entries that were left out.
#[derive(Debug, Clone, Default)]
pub struct Hosts {
    pub map: BTreeMap<String, Host>,
    pub errors: Vec<String>,
    /// Environment variables the file refers to (agents never get them).
    pub vars: Vec<String>,
}

/// Names agents never see, whatever `git.json` says: the tokens the usual tools read.
pub const WELL_KNOWN_SECRET_VARS: &[&str] =
    &["GITHUB_TOKEN", "GH_TOKEN", "GH_ENTERPRISE_TOKEN", "GITLAB_TOKEN", "GLAB_TOKEN", "GITLAB_PRIVATE_TOKEN", "GENIE_GIT_TOKEN"];

fn valid_host_id(id: &str) -> bool {
    genie_core::server_db::valid_slug(id)
}

/// `${NAME}` references in `text` replaced with the environment; the names, and those unset.
fn expand(text: &str, vars: &mut Vec<String>, missing: &mut Vec<String>) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(i) = rest.find("${") {
        out.push_str(&rest[..i]);
        let after = &rest[i + 2..];
        let Some(j) = after.find('}') else {
            out.push_str(&rest[i..]);
            rest = "";
            break;
        };
        let name = &after[..j];
        if !vars.iter().any(|v| v == name) {
            vars.push(name.to_string());
        }
        match std::env::var(name) {
            Ok(v) if !v.is_empty() => out.push_str(&v),
            _ => {
                if !missing.iter().any(|v| v == name) {
                    missing.push(name.to_string());
                }
            }
        }
        rest = &after[j + 1..];
    }
    out.push_str(rest);
    out
}

/// Read `<data>/git.json`. A missing file means no hosts; a broken entry is left out and reported.
pub fn load(data: &Path) -> Hosts {
    let path = data.join("git.json");
    let mut out = Hosts::default();
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return out,
        Err(e) => {
            out.errors.push(format!("{}: {e}", path.display()));
            return out;
        }
    };
    let file: File = match serde_json::from_str(&text) {
        Ok(f) => f,
        Err(e) => {
            out.errors.push(format!("{}: {e}", path.display()));
            return out;
        }
    };
    for (id, value) in file.hosts {
        match build(&id, value, &mut out.vars) {
            Ok(h) => {
                out.map.insert(id, h);
            }
            Err(e) => out.errors.push(format!("host {id}: {e}")),
        }
    }
    out
}

fn build(id: &str, value: serde_json::Value, vars: &mut Vec<String>) -> Result<Host, String> {
    if !valid_host_id(id) {
        return Err("the id must be lowercase letters, digits and dashes".into());
    }
    let raw: Raw = serde_json::from_value(value).map_err(|e| e.to_string())?;
    let url = raw.url.trim().trim_end_matches('/').to_string();
    if url.is_empty() || !(url.starts_with("https://") || url.starts_with("http://") || url.starts_with("file://") || url.starts_with('/'))
    {
        return Err("`url` is required: https://host, http://host or (for tests) file:///path".into());
    }
    let ssh = match raw.transport.as_deref() {
        None | Some("https") => false,
        Some("ssh") => true,
        Some(other) => return Err(format!("`transport: {other}`: https or ssh")),
    };
    if ssh && raw.ssh_key.is_none() {
        return Err("`transport: ssh` needs `ssh_key` (a private key file)".into());
    }
    let mut missing = Vec::new();
    let token = match (&raw.token, &raw.token_file) {
        (Some(_), Some(_)) => return Err("`token` and `token_file` are alternatives".into()),
        (Some(t), None) => Some(expand(t, vars, &mut missing)).filter(|t| !t.trim().is_empty()).map(|t| t.trim().to_string()),
        (None, Some(f)) => match std::fs::read_to_string(f) {
            Ok(t) => Some(t.trim().to_string()).filter(|t| !t.is_empty()),
            Err(e) => {
                missing.push(format!("{f}: {e}"));
                None
            }
        },
        (None, None) => None,
    };
    // A host without a token is fine: each repository of a project may bring its own (`ProjectRepo` token).
    Ok(Host {
        id: id.to_string(),
        kind: raw.kind,
        url,
        api_url: raw.api_url.map(|u| u.trim().trim_end_matches('/').to_string()).filter(|u| !u.is_empty()),
        token,
        ssh,
        ssh_key: raw.ssh_key,
        ssh_command: raw.ssh_command,
        known_hosts: raw.known_hosts,
        ca_cert: raw.ca_cert,
        http_proxy: raw.http_proxy,
        insecure_skip_verify: raw.insecure_skip_verify,
        https_template: raw.clone_urls.https,
        ssh_template: raw.clone_urls.ssh,
        identity: raw.identity,
        poll_secs: raw.poll_secs.unwrap_or(60).clamp(10, 3600),
        missing,
    })
}

/// Environment variables an agent must not get: the secrets `git.json` refers to and, when
/// its project has repositories on hosts (`through_proxy`), the tokens the usual tools read
/// (`GITHUB_TOKEN`…), which would let it reach the host around the proxy. A project with only
/// a local repository (`genie project add --repo`) keeps its agents' environment as it was.
pub fn secret_vars(data: &Path, through_proxy: bool) -> Vec<String> {
    let mut vars = load(data).vars;
    if through_proxy {
        vars.extend(WELL_KNOWN_SECRET_VARS.iter().map(|s| s.to_string()));
    }
    vars.sort();
    vars.dedup();
    vars
}

impl Host {
    /// The address the server clones and pushes with.
    pub fn clone_url(&self, remote: &str) -> String {
        let authority = self.url.split("://").nth(1).unwrap_or(&self.url).split('/').next().unwrap_or_default();
        let hostname = authority.rsplit('@').next().unwrap_or_default().split(':').next().unwrap_or_default();
        let fill = |t: &str| t.replace("{remote}", remote).replace("{host}", hostname).replace("{url}", &self.url);
        if self.ssh {
            fill(self.ssh_template.as_deref().unwrap_or("ssh://git@{host}/{remote}.git"))
        } else {
            fill(self.https_template.as_deref().unwrap_or("{url}/{remote}.git"))
        }
    }

    /// The page of a repository in a browser.
    pub fn web_url(&self, remote: &str) -> String {
        format!("{}/{}", self.url, remote)
    }

    /// The REST API's base address (`api_url`, or derived from `url` and `kind`).
    pub fn api_base(&self) -> Option<String> {
        if let Some(u) = &self.api_url {
            return Some(u.clone());
        }
        match self.kind {
            Kind::Github if self.url == "https://github.com" => Some("https://api.github.com".into()),
            Kind::Github => Some(format!("{}/api/v3", self.url)),
            Kind::Gitlab => Some(format!("{}/api/v4", self.url)),
            Kind::Plain => None,
        }
    }

    /// The user name that goes with the token in HTTP basic authentication.
    fn basic_user(&self) -> &'static str {
        match self.kind {
            Kind::Github => "x-access-token",
            Kind::Gitlab => "oauth2",
            Kind::Plain => "git",
        }
    }

    /// Environment for a `git` process that talks to this host: the token as a
    /// header (not in the command line, not on disk), the CA, the proxy, the SSH key.
    pub fn git_env(&self) -> Vec<(String, String)> {
        let mut env: Vec<(String, String)> = vec![("GIT_TERMINAL_PROMPT".into(), "0".into())];
        let mut config: Vec<(String, String)> = Vec::new();
        if self.ssh {
            let mut cmd = format!(
                "{} -o BatchMode=yes -o IdentitiesOnly=yes",
                self.ssh_command.as_deref().map(shell_quote).unwrap_or_else(|| "ssh".into())
            );
            if let Some(k) = &self.ssh_key {
                cmd.push_str(&format!(" -i {}", shell_quote(k)));
            }
            match &self.known_hosts {
                Some(k) => cmd.push_str(&format!(" -o UserKnownHostsFile={} -o StrictHostKeyChecking=yes", shell_quote(k))),
                None => cmd.push_str(" -o StrictHostKeyChecking=accept-new"),
            }
            env.push(("GIT_SSH_COMMAND".into(), cmd));
        } else if let Some(t) = &self.token
            && !self.url.starts_with("file://")
        {
            let basic = base64::engine::general_purpose::STANDARD.encode(format!("{}:{t}", self.basic_user()));
            config.push((format!("http.{}/.extraheader", self.url), format!("Authorization: Basic {basic}")));
        }
        if let Some(ca) = &self.ca_cert {
            env.push(("GIT_SSL_CAINFO".into(), ca.clone()));
        }
        if self.insecure_skip_verify {
            env.push(("GIT_SSL_NO_VERIFY".into(), "true".into()));
        }
        if let Some(p) = &self.http_proxy {
            config.push(("http.proxy".into(), p.clone()));
        }
        env.push(("GIT_CONFIG_COUNT".into(), config.len().to_string()));
        for (i, (k, v)) in config.into_iter().enumerate() {
            env.push((format!("GIT_CONFIG_KEY_{i}"), k));
            env.push((format!("GIT_CONFIG_VALUE_{i}"), v));
        }
        env
    }

    /// A description without secrets, for the API and `genie doctor`.
    pub fn summary(&self) -> serde_json::Value {
        serde_json::json!({
            "id": self.id,
            "kind": self.kind,
            "url": self.url,
            "apiUrl": self.api_base(),
            "transport": if self.ssh { "ssh" } else { "https" },
            "hasToken": self.token.is_some(),
            "caCert": self.ca_cert.is_some(),
            "insecureSkipVerify": self.insecure_skip_verify,
            "identity": self.identity,
            "problems": self.missing,
        })
    }
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, json: &str) {
        std::fs::write(dir.join("git.json"), json).unwrap();
    }

    #[test]
    fn no_file_means_no_hosts() {
        let d = tempfile::tempdir().unwrap();
        let h = load(d.path());
        assert!(h.map.is_empty() && h.errors.is_empty());
    }

    #[test]
    fn hosts_read_secrets_from_the_environment_and_files() {
        let d = tempfile::tempdir().unwrap();
        let tok = d.path().join("tok");
        std::fs::write(&tok, "file-token\n").unwrap();
        unsafe { std::env::set_var("GENIE_TEST_GL_TOKEN", "env-token") };
        write(
            d.path(),
            &format!(
                r#"{{"hosts": {{
                "gl": {{"kind": "gitlab", "url": "https://git.acme.io/", "token": "${{GENIE_TEST_GL_TOKEN}}"}},
                "gh": {{"kind": "github", "url": "https://github.com", "token_file": "{}"}},
                "lost": {{"kind": "gitlab", "url": "https://x.io", "token": "${{GENIE_TEST_UNSET_TOKEN}}"}}
            }}}}"#,
                tok.display()
            ),
        );
        let h = load(d.path());
        assert_eq!(h.map["gl"].token.as_deref(), Some("env-token"));
        assert_eq!(h.map["gl"].url, "https://git.acme.io");
        assert_eq!(h.map["gh"].token.as_deref(), Some("file-token"));
        assert_eq!(h.map["lost"].missing, ["GENIE_TEST_UNSET_TOKEN"]);
        assert!(h.vars.contains(&"GENIE_TEST_GL_TOKEN".to_string()));
        assert!(secret_vars(d.path(), true).contains(&"GITHUB_TOKEN".to_string()));
        let referenced = secret_vars(d.path(), false);
        assert!(referenced.contains(&"GENIE_TEST_GL_TOKEN".to_string()) && !referenced.contains(&"GITHUB_TOKEN".to_string()));
        let s = h.map["gl"].summary().to_string();
        assert!(!s.contains("env-token"), "the summary never shows a secret");
    }

    #[test]
    fn a_broken_host_is_left_out_and_reported() {
        let d = tempfile::tempdir().unwrap();
        write(
            d.path(),
            r#"{"hosts": {
              "a": {"kind": "gitlab", "url": "https://a.io", "token": "x", "tokn": "typo"},
              "b": {"kind": "gitlab", "url": "https://b.io", "token": "x", "transport": "ssh"},
              "C!": {"kind": "plain", "url": "https://c.io"},
              "ok": {"kind": "plain", "url": "https://ok.io"}
            }}"#,
        );
        let h = load(d.path());
        assert_eq!(h.map.keys().collect::<Vec<_>>(), ["ok"]);
        assert_eq!(h.errors.len(), 3, "{:?}", h.errors);
    }

    #[test]
    fn addresses_follow_the_kind_and_the_transport() {
        let d = tempfile::tempdir().unwrap();
        write(
            d.path(),
            r#"{"hosts": {
              "gh": {"kind": "github", "url": "https://github.com", "token": "t"},
              "ghe": {"kind": "github", "url": "https://ghe.acme.io", "token": "t"},
              "gl": {"kind": "gitlab", "url": "https://git.acme.io:8443/gitlab", "token": "t"},
              "ssh": {"kind": "gitlab", "url": "https://git.acme.io", "token": "t", "transport": "ssh", "ssh_key": "/k/id",
                      "clone_urls": {"ssh": "ssh://git@{host}:2222/{remote}.git"}}
            }}"#,
        );
        let h = load(d.path()).map;
        assert_eq!(h["gh"].api_base().unwrap(), "https://api.github.com");
        assert_eq!(h["ghe"].api_base().unwrap(), "https://ghe.acme.io/api/v3");
        assert_eq!(h["gl"].api_base().unwrap(), "https://git.acme.io:8443/gitlab/api/v4");
        assert_eq!(h["gl"].clone_url("g/s/r"), "https://git.acme.io:8443/gitlab/g/s/r.git");
        assert_eq!(h["ssh"].clone_url("g/r"), "ssh://git@git.acme.io:2222/g/r.git");
        let env: BTreeMap<_, _> = h["ssh"].git_env().into_iter().collect();
        assert!(env["GIT_SSH_COMMAND"].contains("-i '/k/id'") && env["GIT_SSH_COMMAND"].contains("IdentitiesOnly"));
        let env: BTreeMap<_, _> = h["gl"].git_env().into_iter().collect();
        assert!(env["GIT_CONFIG_VALUE_0"].starts_with("Authorization: Basic "));
        assert!(env["GIT_CONFIG_KEY_0"].starts_with("http.https://git.acme.io:8443/gitlab/"));
    }
}

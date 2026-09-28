//! Server configuration.
//!
//! Defaults come from the repository's `config/default.json` (embedded at build
//! time, so the binary is self-contained) and are deep-merged with
//! `<data>/config.json`. Role prompts are embedded from `agents/*.md` and can be
//! overridden by `<data>/agents/<role>.md`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;

const DEFAULT_JSON: &str = include_str!("../../../config/default.json");

const ROLE_PROMPTS: &[(&str, &str)] = &[
    ("orchestrator", include_str!("../../../agents/orchestrator.md")),
    ("analyst", include_str!("../../../agents/analyst.md")),
    ("executor", include_str!("../../../agents/executor.md")),
    ("reviewer", include_str!("../../../agents/reviewer.md")),
    ("tester", include_str!("../../../agents/tester.md")),
    ("documenter", include_str!("../../../agents/documenter.md")),
];

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RoleModel {
    pub model: Option<String>,
    pub thinking: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct MemberSpec {
    pub role: String,
    pub name: Option<String>,
    pub model: Option<String>,
    pub thinking: Option<String>,
    pub instructions: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TeamTemplate {
    pub description: String,
    pub worktree: bool,
    pub members: Vec<MemberSpec>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Limits {
    pub max_members_per_team: usize,
    pub max_active_teams: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Limits { max_members_per_team: 6, max_active_teams: 4 }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Worktrees {
    pub dir: String,
    pub branch: String,
}

impl Default for Worktrees {
    fn default() -> Self {
        Worktrees { dir: "{mainRoot}/../{repo}.worktrees/{team}".into(), branch: "genie/{team}".into() }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Language {
    pub internal: String,
    pub user: String,
}

impl Default for Language {
    fn default() -> Self {
        Language { internal: "English".into(), user: "Russian".into() }
    }
}

/// How agents run.
///
/// Team members and the orchestrator run as *live sessions* (`mode: "sessions"`):
/// one long-running `sessionCommand` process per agent (pi in RPC mode with the
/// genie-bus extension), mail delivered between its steps. Any other harness runs
/// in *turns* (`mode: "turns"`): `command` is launched for each batch of mail and
/// must finish. `"auto"` (default) uses sessions while `command` is pi's default.
/// One-shot jobs always run as turns.
///
/// Commands are lists of argument groups; a group is used only when every
/// placeholder in it resolved to a non-empty value, so optional flags
/// (`--model {model}`) disappear when unset. Placeholders: `{sessionDir}`,
/// `{sessionId}`, `{model}`, `{thinking}`, `{promptFile}`, `{message}` (turns),
/// `{extension}` (sessions), `{readonlyTools}` (read-only roles), `{cwd}`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RuntimeConfig {
    pub mode: String,
    pub command: Vec<Vec<String>>,
    pub session_command: Vec<Vec<String>>,
    /// Concurrent one-shot jobs and turns.
    pub max_concurrent: usize,
    /// Live sessions at once; an idle one is stopped to make room.
    pub max_sessions: usize,
    /// A session idle this long is stopped (its conversation is kept and resumed).
    pub idle_stop_secs: u64,
    /// A turn, or a session step without any sign of life, is stopped after this long.
    pub turn_timeout_secs: u64,
    pub max_attempts: u32,
    /// How long `genie agent ask` waits for the answer by default.
    pub ask_timeout_secs: u64,
    /// Characters of mail put into a session at one step boundary.
    pub delivery_budget: usize,
    /// Extra environment for agent processes.
    pub env: BTreeMap<String, String>,
    /// Disable to run the server without starting any agent (UI-only mode).
    pub enabled: bool,
}

impl RuntimeConfig {
    /// Whether members and the orchestrator run as live sessions.
    pub fn live_sessions(&self) -> bool {
        match self.mode.as_str() {
            "sessions" => true,
            "turns" => false,
            _ => self.command == RuntimeConfig::default().command,
        }
    }
}

impl Default for RuntimeConfig {
    fn default() -> Self {
        let g = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        RuntimeConfig {
            mode: "auto".into(),
            command: vec![
                g(&["pi", "--print"]),
                g(&["--session-dir", "{sessionDir}"]),
                g(&["--session-id", "{sessionId}"]),
                g(&["--model", "{model}"]),
                g(&["--thinking", "{thinking}"]),
                g(&["--append-system-prompt", "{promptFile}"]),
                g(&["--exclude-tools", "{readonlyTools}"]),
                g(&["{message}"]),
            ],
            session_command: vec![
                g(&["pi", "--mode", "rpc"]),
                g(&["--session-dir", "{sessionDir}"]),
                g(&["--session-id", "{sessionId}"]),
                g(&["--model", "{model}"]),
                g(&["--thinking", "{thinking}"]),
                g(&["--append-system-prompt", "{promptFile}"]),
                g(&["--exclude-tools", "{readonlyTools}"]),
                g(&["-e", "{extension}"]),
            ],
            max_concurrent: 4,
            max_sessions: 12,
            idle_stop_secs: 900,
            turn_timeout_secs: 1800,
            max_attempts: 3,
            ask_timeout_secs: 180,
            delivery_budget: genie_core::team::DELIVERY_BUDGET,
            env: BTreeMap::new(),
            enabled: true,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TelegramConfig {
    pub token: String,
    /// Bot API base, for tests and proxies.
    pub api_base: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SmtpConfig {
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub password: Option<String>,
    pub from: String,
    /// "starttls" (default), "tls" or "none" (local test servers such as Mailpit).
    pub security: String,
}

impl Default for SmtpConfig {
    fn default() -> Self {
        SmtpConfig { host: String::new(), port: 587, username: None, password: None, from: String::new(), security: "starttls".into() }
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct VaultConfig {
    /// Vault directory; defaults to `<data>/vault`.
    pub path: Option<PathBuf>,
    /// Commit writes when the vault is a git repository (default true).
    pub commit: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub port: u16,
    pub bind: String,
    /// Base URL used in links sent by mail and Telegram.
    pub public_url: Option<String>,
    pub allow_hosts: Vec<String>,
    pub role_models: BTreeMap<String, RoleModel>,
    pub teams: BTreeMap<String, TeamTemplate>,
    pub limits: Limits,
    pub worktrees: Worktrees,
    pub language: Language,
    pub runtime: RuntimeConfig,
    pub telegram: Option<TelegramConfig>,
    pub smtp: Option<SmtpConfig>,
    pub vault: VaultConfig,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            port: 7420,
            bind: "127.0.0.1".into(),
            public_url: None,
            allow_hosts: Vec::new(),
            role_models: BTreeMap::new(),
            teams: BTreeMap::new(),
            limits: Limits::default(),
            worktrees: Worktrees::default(),
            language: Language::default(),
            runtime: RuntimeConfig::default(),
            telegram: None,
            smtp: None,
            vault: VaultConfig::default(),
        }
    }
}

fn merge(base: &mut Value, over: Value) {
    match (base, over) {
        (Value::Object(b), Value::Object(o)) => {
            for (k, v) in o {
                merge(b.entry(k).or_insert(Value::Null), v);
            }
        }
        (b, o) => *b = o,
    }
}

impl Config {
    /// Embedded defaults merged with `<data>/config.json` when present.
    pub fn load(data: &Path) -> Result<Config, String> {
        let mut value: Value = serde_json::from_str(DEFAULT_JSON).map_err(|e| format!("config/default.json: {e}"))?;
        // Keys of the TypeScript config that the server does not use.
        if let Some(obj) = value.as_object_mut() {
            for k in ["spawn", "orchestrator", "notify", "gates", "docs", "web", "names"] {
                obj.remove(k);
            }
        }
        let file = data.join("config.json");
        if file.exists() {
            let text = std::fs::read_to_string(&file).map_err(|e| format!("{}: {e}", file.display()))?;
            let over: Value = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", file.display()))?;
            merge(&mut value, over);
        }
        serde_json::from_value(value).map_err(|e| format!("config: {e}"))
    }

    pub fn public_url(&self) -> String {
        self.public_url.clone().unwrap_or_else(|| format!("http://127.0.0.1:{}", self.port)).trim_end_matches('/').to_string()
    }

    pub fn vault_path(&self, data: &Path) -> PathBuf {
        self.vault.path.clone().unwrap_or_else(|| data.join("vault"))
    }
}

/// Role prompt body (frontmatter stripped): `<data>/agents/<role>.md` or the embedded default.
pub fn role_prompt(data: &Path, role: &str) -> String {
    let custom = data.join("agents").join(format!("{role}.md"));
    let raw = std::fs::read_to_string(&custom)
        .ok()
        .or_else(|| ROLE_PROMPTS.iter().find(|(r, _)| *r == role).map(|(_, p)| p.to_string()))
        .unwrap_or_default();
    strip_frontmatter(&raw).to_string()
}

/// Frontmatter `excludeTools` of a role (read-only roles cannot edit files).
pub fn role_excluded_tools(data: &Path, role: &str) -> Option<String> {
    let custom = data.join("agents").join(format!("{role}.md"));
    let raw =
        std::fs::read_to_string(&custom).ok().or_else(|| ROLE_PROMPTS.iter().find(|(r, _)| *r == role).map(|(_, p)| p.to_string()))?;
    let fm = raw.strip_prefix("---\n")?.split("\n---").next()?;
    fm.lines()
        .find_map(|l| l.strip_prefix("excludeTools:"))
        .map(|v| v.trim().trim_matches(['[', ']']).replace(' ', ""))
        .filter(|v| !v.is_empty())
}

fn strip_frontmatter(raw: &str) -> &str {
    if let Some(rest) = raw.strip_prefix("---\n")
        && let Some(end) = rest.find("\n---")
    {
        return rest[end + 4..].trim_start_matches('\n');
    }
    raw
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_come_from_the_repository_config() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = Config::load(dir.path()).unwrap();
        assert!(cfg.teams.contains_key("research"));
        assert_eq!(cfg.teams["standard"].members.len(), 3);
        assert_eq!(cfg.limits.max_active_teams, 4);
        assert!(role_prompt(dir.path(), "executor").contains("executor"));
        assert!(!role_prompt(dir.path(), "executor").starts_with("---"));
    }

    #[test]
    fn data_config_overrides_deeply() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("config.json"),
            r#"{"port": 9000, "runtime": {"maxConcurrent": 1}, "limits": {"maxActiveTeams": 2}}"#,
        )
        .unwrap();
        let cfg = Config::load(dir.path()).unwrap();
        assert_eq!(cfg.port, 9000);
        assert_eq!(cfg.runtime.max_concurrent, 1);
        assert_eq!(cfg.runtime.turn_timeout_secs, 1800, "unset runtime fields keep defaults");
        assert_eq!(cfg.limits.max_members_per_team, 6);
    }

    #[test]
    fn read_only_roles_exclude_edit_tools() {
        let dir = tempfile::tempdir().unwrap();
        let reviewer = role_excluded_tools(dir.path(), "reviewer");
        let executor = role_excluded_tools(dir.path(), "executor");
        assert!(executor.is_none());
        if let Some(r) = reviewer {
            assert!(r.contains("edit"));
        }
    }
}

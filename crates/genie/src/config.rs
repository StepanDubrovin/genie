//! Server configuration.
//!
//! Defaults come from the repository's `config/default.json` (embedded at build
//! time, so the binary is self-contained) and are deep-merged with
//! `<data>/config.json`. Roles, team templates, skills and MCP connections live
//! next to it and are loaded by `agent_config`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;

const DEFAULT_JSON: &str = include_str!("../../../config/default.json");

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

/// Where skills are found besides `<data>/skills` (e.g. a clone of a skills repository).
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SkillsConfig {
    pub paths: Vec<PathBuf>,
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
/// `{extension}` (sessions), `{readonlyTools}` (read-only roles), `{cwd}`,
/// `{guard}` (the genie guard extension), `{mcpConfig}` (the role's MCP
/// connections for pi-mcp-adapter), `{limitSkills}` (the role lists its skills)
/// and `{skill}` — a list: its group is repeated for each skill directory.
/// `{?name}` adds nothing but keeps its group only when `name` is set
/// (`["--no-skills", "{?limitSkills}"]`).
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
    /// Whether pi loads pi-mcp-adapter, so agents get their MCP config (`{mcpConfig}`):
    /// unset — found in pi's settings (`pi install npm:pi-mcp-adapter`); `true`/`false` — say so.
    pub mcp_adapter: Option<bool>,
    /// Agents reach MCP connections through the genie gateway (default): secrets
    /// stay on the server and every call is in the project's journal. `false`:
    /// the harness gets the connections themselves.
    pub mcp_gateway: bool,
    /// Disable to run the server without starting any agent (UI-only mode).
    pub enabled: bool,
}

impl RuntimeConfig {
    /// Whether pi loads pi-mcp-adapter (which reads `--mcp-config`; pi refuses the flag
    /// without it): `mcpAdapter`, else a command loading it, else pi's settings — its
    /// packages and extensions — or its extensions directory.
    pub fn mcp_adapter(&self) -> bool {
        const NAME: &str = "pi-mcp-adapter";
        if let Some(v) = self.mcp_adapter {
            return v;
        }
        if self.command.iter().chain(&self.session_command).flatten().any(|a| a.contains(NAME)) {
            return true;
        }
        let home = std::env::var("HOME").unwrap_or_default();
        let dir = match self.env.get("PI_CODING_AGENT_DIR").cloned().or_else(|| std::env::var("PI_CODING_AGENT_DIR").ok()) {
            Some(d) => match d.strip_prefix("~/") {
                Some(rest) => PathBuf::from(&home).join(rest),
                None => PathBuf::from(d),
            },
            None => PathBuf::from(&home).join(".pi").join("agent"),
        };
        let settings: serde_json::Value =
            std::fs::read_to_string(dir.join("settings.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        let listed = ["packages", "extensions"]
            .iter()
            .filter_map(|k| settings[*k].as_array())
            .flatten()
            .any(|e| e.as_str().or_else(|| e["source"].as_str()).is_some_and(|s| s.contains(NAME)));
        listed
            || std::fs::read_dir(dir.join("extensions"))
                .is_ok_and(|rd| rd.flatten().any(|e| e.file_name().to_string_lossy().contains(NAME)))
    }

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
                g(&["--no-skills", "{?limitSkills}"]),
                g(&["--skill", "{skill}"]),
                g(&["-e", "{guard}"]),
                g(&["--mcp-config", "{mcpConfig}"]),
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
                g(&["--no-skills", "{?limitSkills}"]),
                g(&["--skill", "{skill}"]),
                g(&["-e", "{extension}"]),
                g(&["-e", "{guard}"]),
                g(&["--mcp-config", "{mcpConfig}"]),
            ],
            max_concurrent: 4,
            max_sessions: 12,
            idle_stop_secs: 900,
            turn_timeout_secs: 1800,
            max_attempts: 3,
            ask_timeout_secs: 180,
            delivery_budget: genie_core::team::DELIVERY_BUDGET,
            env: BTreeMap::new(),
            mcp_adapter: None,
            mcp_gateway: true,
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
    pub limits: Limits,
    pub worktrees: Worktrees,
    pub language: Language,
    pub runtime: RuntimeConfig,
    pub telegram: Option<TelegramConfig>,
    pub smtp: Option<SmtpConfig>,
    pub vault: VaultConfig,
    pub skills: SkillsConfig,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            port: 7420,
            bind: "127.0.0.1".into(),
            public_url: None,
            allow_hosts: Vec::new(),
            role_models: BTreeMap::new(),
            limits: Limits::default(),
            worktrees: Worktrees::default(),
            language: Language::default(),
            runtime: RuntimeConfig::default(),
            telegram: None,
            smtp: None,
            vault: VaultConfig::default(),
            skills: SkillsConfig::default(),
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
        // Keys of the TypeScript config that the server does not use (its team
        // presets are `config/teams/*.json`, see `agent_config`).
        if let Some(obj) = value.as_object_mut() {
            for k in ["spawn", "orchestrator", "notify", "gates", "docs", "web", "names", "teams"] {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_come_from_the_repository_config() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = Config::load(dir.path()).unwrap();
        assert_eq!(cfg.limits.max_active_teams, 4);
        assert!(cfg.role_models.contains_key("executor"));
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
    fn pi_mcp_adapter_is_found_in_pis_settings() {
        let dir = tempfile::tempdir().unwrap();
        let mut rt = RuntimeConfig::default();
        rt.env.insert("PI_CODING_AGENT_DIR".into(), dir.path().to_string_lossy().into_owned());
        assert!(!rt.mcp_adapter(), "no settings");
        let settings = |v: &str| std::fs::write(dir.path().join("settings.json"), v).unwrap();
        settings(r#"{"packages": ["npm:pi-web-access"]}"#);
        assert!(!rt.mcp_adapter());
        settings(r#"{"packages": ["npm:pi-web-access", "npm:pi-mcp-adapter@3.1.0"]}"#);
        assert!(rt.mcp_adapter(), "pi install npm:pi-mcp-adapter");
        settings(r#"{"packages": [{"source": "git:github.com/nicobailon/pi-mcp-adapter", "extensions": ["index.ts"]}]}"#);
        assert!(rt.mcp_adapter(), "a filtered package entry");
        settings("{}");
        std::fs::create_dir_all(dir.path().join("extensions/pi-mcp-adapter")).unwrap();
        assert!(rt.mcp_adapter(), "the extensions directory");
        rt.mcp_adapter = Some(false);
        assert!(!rt.mcp_adapter(), "the setting wins");
    }
}

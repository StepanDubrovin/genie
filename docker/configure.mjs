// Container start-up configuration, run by docker-entrypoint.sh as the service user.
//
// The server reads its settings only from <data>/config.json, so environment variables are
// applied to that file here (idempotently, and only for the keys they cover):
//
//   GENIE_BIND         bind address        (default 0.0.0.0 — a loopback bind is unreachable through published ports)
//   GENIE_PUBLIC_URL   base URL of links in mail and Telegram; its host is also added to allowHosts
//   GENIE_ALLOW_HOSTS  comma-separated Host header values accepted besides localhost:<port>
//   GENIE_SANDBOX      runtime.sandbox.mode: auto | bwrap | off (see docker-compose.sandbox.yml)
//
// Everything else in config.json is left alone. The script also registers pi-mcp-adapter
// (shipped in the image) in pi's settings so roles with MCP connections work; opt out with
// GENIE_MCP_ADAPTER=0.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const env = process.env;
const data = env.GENIE_DATA || "/data";
const log = (msg) => console.error(`genie-entrypoint: ${msg}`);

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch (e) {
    log(`error: ${path} is not valid JSON (${e.message}); fix or remove it`);
    process.exit(1);
  }
  log(`error: ${path} must contain a JSON object`);
  process.exit(1);
}

function writeJson(path, value, mode) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

// --- <data>/config.json ---------------------------------------------------------------

const configPath = join(data, "config.json");
const config = readJson(configPath, {});
const before = JSON.stringify(config);
const fresh = !existsSync(configPath);

const bind = (env.GENIE_BIND || "").trim();
if (bind) config.bind = bind;
else if (config.bind === undefined) config.bind = "0.0.0.0";
else if (["127.0.0.1", "localhost", "::1"].includes(config.bind)) {
  log(
    `warning: config.json binds ${config.bind}: the server is not reachable through a published port. ` +
      "Set bind to 0.0.0.0 (or GENIE_BIND=0.0.0.0) unless the container uses host networking.",
  );
}

const hosts = new Set(Array.isArray(config.allowHosts) ? config.allowHosts : []);
for (const h of (env.GENIE_ALLOW_HOSTS || "").split(",")) if (h.trim()) hosts.add(h.trim());

const publicUrl = (env.GENIE_PUBLIC_URL || "").trim();
if (publicUrl) {
  let url;
  try {
    url = new URL(publicUrl);
  } catch {
    log(`error: GENIE_PUBLIC_URL is not a valid URL: ${publicUrl}`);
    process.exit(1);
  }
  config.publicUrl = publicUrl.replace(/\/+$/, "");
  hosts.add(url.host); // as clients send it: with the port when it is not the default one
  hosts.add(url.hostname);
}
if (hosts.size > 0) config.allowHosts = [...hosts];

const sandbox = (env.GENIE_SANDBOX || "").trim();
if (sandbox) {
  if (!["auto", "bwrap", "off"].includes(sandbox)) {
    log(`error: GENIE_SANDBOX must be auto, bwrap or off, got '${sandbox}'`);
    process.exit(1);
  }
  const runtime = config.runtime && typeof config.runtime === "object" ? config.runtime : {};
  const box = runtime.sandbox && typeof runtime.sandbox === "object" ? runtime.sandbox : {};
  config.runtime = { ...runtime, sandbox: { ...box, mode: sandbox } };
}

if (JSON.stringify(config) !== before || fresh) {
  writeJson(configPath, config, 0o600);
  log(`${fresh ? "created" : "updated"} ${configPath}`);
}

// --- pi: pi-mcp-adapter ---------------------------------------------------------------

const adapterDir = env.GENIE_MCP_ADAPTER_DIR || "/opt/genie/pi-seed/npm/node_modules/pi-mcp-adapter";
if (env.GENIE_MCP_ADAPTER !== "0" && existsSync(adapterDir)) {
  const agentDir = env.PI_CODING_AGENT_DIR || join(env.HOME || "/data/home", ".pi", "agent");
  const settingsPath = join(agentDir, "settings.json");
  const settings = readJson(settingsPath, {});
  const packages = Array.isArray(settings.packages) ? settings.packages : [];
  const source = (p) => (typeof p === "string" ? p : p && typeof p.source === "string" ? p.source : "");
  // Any entry naming the adapter (npm:pi-mcp-adapter@x, a git source, our path) counts as installed.
  if (!packages.some((p) => source(p).includes("pi-mcp-adapter"))) {
    settings.packages = [...packages, adapterDir];
    writeJson(settingsPath, settings, 0o600);
    log(`registered pi-mcp-adapter in ${settingsPath}`);
  }
}

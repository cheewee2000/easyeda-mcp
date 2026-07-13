#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { edaTools } from "./eda-tools.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(__dirname, "logs");
const BRIDGE_SCRIPT =
  process.env.EASYEDA_BRIDGE_SCRIPT ||
  "/Users/cwwang/CW&T Dropbox/Che-Wei Wang/My Mac (9.local)/Documents/GitHub/easyeda-api-skill/scripts/bridge-server.mjs";
const PORT_START = 49620;
const PORT_END = 49629;
const STARTUP_TIMEOUT_MS = 10000;
const DEFAULT_EXECUTE_TIMEOUT_MS = 30000;

if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

async function httpJson(url, opts = {}, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: null, error: e.message };
  } finally {
    clearTimeout(t);
  }
}

let cachedPort = null;

async function probeBridgePort(p) {
  const r = await httpJson(`http://127.0.0.1:${p}/health`, {}, 600);
  return r.ok && r.data && r.data.service === "easyeda-bridge" ? p : null;
}

async function discoverBridgePort() {
  const ports = [];
  for (let p = PORT_START; p <= PORT_END; p++) ports.push(p);
  const results = await Promise.all(ports.map(probeBridgePort));
  return results.find((p) => p !== null) ?? null;
}

function invalidatePort() {
  cachedPort = null;
}

async function getPort({ autostart = true } = {}) {
  if (cachedPort) return cachedPort;
  let port = await discoverBridgePort();
  if (!port && autostart) {
    const r = await ensureBridge();
    port = r.port;
  }
  cachedPort = port;
  return port;
}

async function executeCode(code, { windowId, timeoutMs = DEFAULT_EXECUTE_TIMEOUT_MS } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const port = await getPort();
    if (!port) {
      return { ok: false, error: "Bridge unavailable; auto-start failed. Is EasyEDA Pro running with the run-api-gateway extension loaded?" };
    }
    const body = { code, timeoutMs };
    if (windowId) body.windowId = windowId;
    const r = await httpJson(
      `http://127.0.0.1:${port}/execute`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      timeoutMs + 1000
    );
    if (r.status === 0) {
      // connection-level failure: stale port — rediscover once
      invalidatePort();
      continue;
    }
    return { ok: r.ok, status: r.status, response: r.data, error: r.error };
  }
  return { ok: false, error: "Bridge unreachable after rediscovery retry." };
}

async function ensureBridge() {
  const existing = await discoverBridgePort();
  if (existing) return { port: existing, started: false };

  if (!existsSync(BRIDGE_SCRIPT)) {
    return { port: null, started: false, error: `Bridge script not found at ${BRIDGE_SCRIPT}` };
  }

  const logPath = join(LOG_DIR, "bridge.log");
  const out = openSync(logPath, "a");
  const err = openSync(logPath, "a");
  const child = spawn("node", [BRIDGE_SCRIPT], {
    detached: true,
    stdio: ["ignore", out, err],
    cwd: dirname(BRIDGE_SCRIPT),
  });
  child.unref();

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    const port = await discoverBridgePort();
    if (port) return { port, started: true, pid: child.pid };
  }
  return { port: null, started: true, pid: child.pid, error: "Bridge did not respond within timeout" };
}

function pidOnPort(port) {
  return new Promise((resolve) => {
    const proc = spawn("lsof", ["-ti", `:${port}`]);
    let out = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.on("close", () => {
      const pid = parseInt(out.trim().split("\n")[0], 10);
      resolve(Number.isFinite(pid) ? pid : null);
    });
    proc.on("error", () => resolve(null));
  });
}

const tools = [
  {
    name: "easyeda_health",
    description:
      "Discover the EasyEDA bridge server (scans ports 49620-49629) and return health + EDA-connection status. Auto-starts the bridge if not running (unless autostart=false).",
    inputSchema: {
      type: "object",
      properties: {
        autostart: { type: "boolean", default: true },
      },
    },
  },
  {
    name: "easyeda_list_windows",
    description:
      "List all EasyEDA Pro windows currently connected to the bridge. Returns activeWindowId and the windowId list.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "easyeda_select_window",
    description: "Select which connected EasyEDA window subsequent execute calls target.",
    inputSchema: {
      type: "object",
      properties: {
        windowId: { type: "string", description: "Window ID from easyeda_list_windows" },
      },
      required: ["windowId"],
    },
  },
  {
    name: "easyeda_execute",
    description:
      "Execute JavaScript inside the running EasyEDA Pro client. Code body runs as `async function(eda) { <code> }` — must use `return` to surface a result. Browser context (no Node fs/path). See the easyeda-api skill at ~/Documents/GitHub/easyeda-api-skill for the full API surface, enums, and unit conventions (PCB=1mil, Schematic=0.01inch).",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "JS body. Use `return` to send a result back." },
        windowId: { type: "string", description: "Optional: target a specific window." },
        timeoutMs: { type: "number", description: "Request timeout (default 30000)." },
      },
      required: ["code"],
    },
  },
  {
    name: "easyeda_start_bridge",
    description: "Force-start the bridge server (no-op if already running).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "easyeda_stop_bridge",
    description: "Stop the bridge server if running.",
    inputSchema: { type: "object", properties: {} },
  },
];

const server = new Server(
  { name: "easyeda-mcp", version: "0.2.1" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...tools, ...edaTools.map((t) => t.definition)] }));

function reply(obj) {
  return {
    content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }],
  };
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  try {
    if (name === "easyeda_health") {
      const autostart = args.autostart !== false;
      let port = await getPort({ autostart: false });
      let started = false;
      if (!port && autostart) {
        const r = await ensureBridge();
        if (r.port) {
          cachedPort = r.port;
          port = r.port;
          started = r.started;
        } else {
          return reply({
            ok: false,
            message: "Bridge auto-start failed",
            error: r.error,
            logPath: join(LOG_DIR, "bridge.log"),
          });
        }
      }
      if (!port) {
        return reply({ ok: false, message: "Bridge not running (autostart disabled)." });
      }
      const h = await httpJson(`http://127.0.0.1:${port}/health`);
      if (!h.ok) invalidatePort();
      return reply({ ok: h.ok, port, started, health: h.data });
    }

    if (name === "easyeda_list_windows") {
      const port = await getPort({ autostart: false });
      if (!port) return reply({ ok: false, message: "Bridge not running. Call easyeda_health to start it." });
      const r = await httpJson(`http://127.0.0.1:${port}/eda-windows`);
      return reply({ ok: r.ok, port, windows: r.data });
    }

    if (name === "easyeda_select_window") {
      if (!args.windowId) return reply({ ok: false, message: "windowId required" });
      const port = await getPort({ autostart: false });
      if (!port) return reply({ ok: false, message: "Bridge not running" });
      const r = await httpJson(`http://127.0.0.1:${port}/eda-windows/select`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ windowId: args.windowId }),
      });
      return reply({ ok: r.ok, status: r.status, response: r.data });
    }

    if (name === "easyeda_execute") {
      if (typeof args.code !== "string" || !args.code.trim()) {
        return reply({ ok: false, message: "code (non-empty string) required" });
      }
      const r = await executeCode(args.code, { windowId: args.windowId, timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : DEFAULT_EXECUTE_TIMEOUT_MS });
      return reply(r);
    }

    if (name === "easyeda_start_bridge") {
      const existing = await getPort({ autostart: false });
      if (existing) return reply({ ok: true, message: "Already running", port: existing });
      const r = await ensureBridge();
      if (r.port) cachedPort = r.port;
      return reply({
        ok: !!r.port,
        port: r.port,
        pid: r.pid,
        error: r.error,
        logPath: join(LOG_DIR, "bridge.log"),
      });
    }

    if (name === "easyeda_stop_bridge") {
      const port = await getPort({ autostart: false });
      if (!port) return reply({ ok: true, message: "Not running" });
      const pid = await pidOnPort(port);
      if (!pid) return reply({ ok: false, message: `Could not resolve PID for port ${port}` });
      try {
        process.kill(pid, "SIGTERM");
      } catch (e) {
        return reply({ ok: false, message: e.message });
      }
      invalidatePort();
      return reply({ ok: true, message: `Stopped bridge (pid=${pid}, port=${port})` });
    }

    const hl = edaTools.find((t) => t.definition.name === name);
    if (hl) {
      const r = await executeCode(hl.buildCode(args), { timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : DEFAULT_EXECUTE_TIMEOUT_MS });
      return reply(r);
    }

    return reply({ ok: false, message: `Unknown tool: ${name}` });
  } catch (e) {
    return reply({ ok: false, message: e.message, stack: e.stack });
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

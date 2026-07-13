#!/usr/bin/env node
// Spawns the MCP server, exercises listTools + a couple of tool calls over stdio.
// Prints PASS/FAIL summary and exits non-zero on failure.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const child = spawn("node", [join(__dirname, "index.mjs")], {
  stdio: ["pipe", "pipe", "inherit"],
});

let buf = "";
const pending = new Map();

child.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  const payload = { jsonrpc: "2.0", id, method, params };
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify(payload) + "\n");
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`Timeout for ${method}`));
      }
    }, 15000);
  });
}

async function main() {
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const list = await rpc("tools/list", {});
  const names = (list.result?.tools || []).map((t) => t.name);
  const expected = [
    "easyeda_health",
    "easyeda_list_windows",
    "easyeda_select_window",
    "easyeda_execute",
    "easyeda_start_bridge",
    "easyeda_stop_bridge",
    "easyeda_drc_get_rules",
    "easyeda_drc_set_rules",
    "easyeda_drc_check",
    "easyeda_drc_net_classes",
  ];
  const missing = expected.filter((n) => !names.includes(n));
  if (missing.length) throw new Error(`Missing tools: ${missing.join(", ")}`);
  console.log(`PASS  tools/list — ${names.length} tools registered`);

  const health = await rpc("tools/call", { name: "easyeda_health", arguments: { autostart: false } });
  const healthText = health.result?.content?.[0]?.text || "";
  console.log(`PASS  easyeda_health(autostart=false) responded`);
  console.log(`        → ${healthText.slice(0, 200).replace(/\n/g, " ")}`);

  console.log("\nAll smoke checks passed.");
  child.kill();
  process.exit(0);
}

main().catch((e) => {
  console.error("FAIL", e.message);
  child.kill();
  process.exit(1);
});

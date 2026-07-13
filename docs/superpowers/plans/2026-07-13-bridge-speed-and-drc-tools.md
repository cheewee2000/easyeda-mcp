# easyeda-mcp v0.2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every MCP tool call fast (cached port, parallel discovery, single round trip) and add high-level DRC + convenience tools so common EasyEDA actions need zero manual clicks and one tool call.

**Architecture:** `index.mjs` stays the thin MCP/stdio layer and owns bridge discovery, the port cache, and a shared `executeCode()` helper. A new `eda-tools.mjs` exports high-level tool definitions, each pairing an MCP tool schema with a `buildCode(args)` function that returns a JS snippet executed inside EasyEDA via the existing `/execute` path. `deepMerge` is a pure exported function (unit-tested) whose source is embedded into the set-rules snippet.

**Tech Stack:** Node ≥18 ESM, `@modelcontextprotocol/sdk`, `node:test` for unit tests, live EasyEDA Pro + JLCEDA bridge for verification.

## Global Constraints

- Do not modify the JLCEDA bridge (`easyeda-api-skill/scripts/bridge-server.mjs`) or the `.eext` extension.
- All EasyEDA-side code runs as `async function(eda){...}` in a browser context — no Node APIs, results must be `return`ed.
- Every tool returns JSON with an `ok` field; failures carry `error` text naming the fix. Never fake success.
- `eda.pcb_Drc` APIs are BETA — wrap in try/catch, surface errors verbatim.
- Verified live facts (2026-07-13 probe): bridge on port 49620; rule config shape is `{name: string, config: {Spacing: {...}, Physics: {...}, ...}}` with leaf objects carrying `unit`, `form`/`table`; `eda.dmt_EditorControl.getCurrentDocumentInfo` does NOT exist; `PCB_Document.save()`/`SCH_Document.save()` DO exist.
- Version becomes `0.2.0` in package.json AND the `Server` constructor in index.mjs (Task 5).

---

### Task 1: Port cache + parallel discovery + single-round-trip execute

**Files:**
- Modify: `index.mjs` (lines 41–74 discovery; handlers at 157–257)
- Test: `smoke-test.mjs` (no changes needed yet; used to verify)

**Interfaces:**
- Produces: `getPort({autostart}) → Promise<number|null>`, `invalidatePort()`, `executeCode(code, {windowId, timeoutMs}) → Promise<{ok, status, response, error}>` — Tasks 3–4 dispatch through `executeCode`.

- [ ] **Step 1: Replace sequential discovery with parallel + cache in index.mjs**

Replace the existing `discoverBridgePort()` (index.mjs:41-47) with:

```js
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
```

`ensureBridge()` keeps its 250ms poll loop but now benefits from parallel discovery. Remove its leading `discoverBridgePort()` call duplication is fine to keep — it is only hit on cold start.

- [ ] **Step 2: Add the shared executeCode helper**

Insert after `getPort`:

```js
async function executeCode(code, { windowId, timeoutMs = DEFAULT_EXECUTE_TIMEOUT_MS } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const port = await getPort();
    if (!port) {
      return { ok: false, error: "Bridge unavailable; auto-start failed. Is EasyEDA Pro running with the run-api-gateway extension loaded?" };
    }
    const body = { code };
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
```

- [ ] **Step 3: Rewire all handlers onto getPort/executeCode**

In the `CallToolRequestSchema` handler:
- `easyeda_health`: replace the `discoverBridgePort()` + `ensureBridge()` block with `const port = await getPort({ autostart });` then the existing `/health` fetch; on `!port` return the existing failure replies. On unhealthy response (`!h.ok`), call `invalidatePort()`.
- `easyeda_list_windows` / `easyeda_select_window`: replace `await discoverBridgePort()` with `await getPort({ autostart: false })`.
- `easyeda_execute`: whole body becomes:

```js
if (name === "easyeda_execute") {
  if (typeof args.code !== "string" || !args.code.trim()) {
    return reply({ ok: false, message: "code (non-empty string) required" });
  }
  const r = await executeCode(args.code, { windowId: args.windowId, timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : DEFAULT_EXECUTE_TIMEOUT_MS });
  return reply(r);
}
```

- `easyeda_stop_bridge`: after successful kill, add `invalidatePort();`.
- `easyeda_start_bridge`: replace `discoverBridgePort()` with `getPort({ autostart: false })`; after successful `ensureBridge()`, set `cachedPort = r.port;`.

- [ ] **Step 4: Run smoke test**

Run: `cd "/Users/cwwang/CW&T Dropbox/Che-Wei Wang/My Mac (9.local)/Desktop/easyeda MCP" && npm run smoke`
Expected: `PASS tools/list — 6 tools registered`, `PASS easyeda_health…`, `All smoke checks passed.`

- [ ] **Step 5: Verify warm-call latency drop live**

Run (bridge is on 49620 with EasyEDA connected):

```bash
node -e '
import("node:child_process");
const t0 = Date.now();
const r1 = await fetch("http://127.0.0.1:49620/execute", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code:"return 1+1"})}).then(r=>r.json());
console.log("direct execute ms:", Date.now()-t0, JSON.stringify(r1));
'
```

Then exercise `easyeda_execute` twice through the MCP stdio (extend a throwaway copy of smoke-test or use it interactively) and confirm the second call completes in roughly the direct-execute time (< ~200ms overhead).
Expected: second warm call ≈ direct time, no port scan delay.

- [ ] **Step 6: Commit**

```bash
git add index.mjs
git commit -m "perf: cache bridge port, parallel discovery, single round-trip execute"
```

---

### Task 2: deepMerge (TDD) in eda-tools.mjs

**Files:**
- Create: `eda-tools.mjs`
- Create: `test/deep-merge.test.mjs`

**Interfaces:**
- Produces: `export function deepMerge(base, patch)` — plain objects merged recursively; arrays, primitives, and null replace wholesale; `patch` wins; inputs not mutated. Task 3 embeds `deepMerge.toString()` into the set-rules snippet, so the function must be self-contained (no closures, no imports).

- [ ] **Step 1: Write the failing test**

```js
// test/deep-merge.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { deepMerge } from "../eda-tools.mjs";

test("merges nested objects, patch wins on leaves", () => {
  const base = { config: { Physics: { Track: { form: { strokeWidthMin: 0.127, strokeWidthMax: 2.54 } } } }, name: "Custom" };
  const patch = { config: { Physics: { Track: { form: { strokeWidthMin: 0.2 } } } } };
  const out = deepMerge(base, patch);
  assert.equal(out.config.Physics.Track.form.strokeWidthMin, 0.2);
  assert.equal(out.config.Physics.Track.form.strokeWidthMax, 2.54);
  assert.equal(out.name, "Custom");
});

test("arrays are replaced wholesale, not merged", () => {
  const out = deepMerge({ t: { table: [[1], [2, 3]] } }, { t: { table: [[9]] } });
  assert.deepEqual(out.t.table, [[9]]);
});

test("does not mutate inputs", () => {
  const base = { a: { b: 1 } };
  const patch = { a: { c: 2 } };
  deepMerge(base, patch);
  assert.deepEqual(base, { a: { b: 1 } });
  assert.deepEqual(patch, { a: { c: 2 } });
});

test("null and primitives in patch replace objects", () => {
  const out = deepMerge({ a: { b: 1 }, c: 5 }, { a: null, c: { d: 1 } });
  assert.equal(out.a, null);
  assert.deepEqual(out.c, { d: 1 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/deep-merge.test.mjs`
Expected: FAIL — `Cannot find module .../eda-tools.mjs`

- [ ] **Step 3: Write minimal implementation**

```js
// eda-tools.mjs
// High-level EasyEDA tools: each entry pairs an MCP tool definition with a
// buildCode(args) that returns the JS body executed inside EasyEDA.

export function deepMerge(base, patch) {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch;
  if (base === null || typeof base !== "object" || Array.isArray(base)) base = {};
  const out = {};
  for (const k of Object.keys(base)) out[k] = base[k];
  for (const k of Object.keys(patch)) out[k] = deepMerge(base[k], patch[k]);
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/deep-merge.test.mjs`
Expected: 4 passing tests.

- [ ] **Step 5: Commit**

```bash
git add eda-tools.mjs test/deep-merge.test.mjs
git commit -m "feat: deepMerge for DRC rule patching (TDD)"
```

---

### Task 3: DRC tools

**Files:**
- Modify: `eda-tools.mjs` (append tool table)
- Modify: `index.mjs` (register + dispatch high-level tools)
- Modify: `smoke-test.mjs` (expected tool list)

**Interfaces:**
- Consumes: `executeCode(code, {timeoutMs})` from Task 1; `deepMerge` from Task 2.
- Produces: `export const edaTools = [{ definition, buildCode(args) }, ...]` — `definition` is a standard MCP tool schema `{name, description, inputSchema}`; `buildCode(args)` returns a string JS body. index.mjs dispatches any tool whose name matches an `edaTools` entry via `executeCode(buildCode(args))`.

- [ ] **Step 1: Append DRC tool entries to eda-tools.mjs**

```js
const DEEP_MERGE_SRC = deepMerge.toString();

export const edaTools = [
  {
    definition: {
      name: "easyeda_drc_get_rules",
      description:
        "Get the current PCB DRC rule configuration (shape: {name, config:{Spacing,Physics,...}}), plus the list of saved configuration names. Values are in mm. Requires a PCB document open in EasyEDA Pro.",
      inputSchema: { type: "object", properties: {} },
    },
    buildCode: () => `
      const name = await eda.pcb_Drc.getCurrentRuleConfigurationName();
      const config = await eda.pcb_Drc.getCurrentRuleConfiguration();
      let saved = [];
      try {
        const all = (await eda.pcb_Drc.getAllRuleConfigurations(true)) || [];
        saved = all.map((c) => (c && typeof c === "object" ? (c.name ?? JSON.stringify(c).slice(0, 60)) : String(c)));
      } catch (e) { saved = ["<getAllRuleConfigurations failed: " + e.message + ">"]; }
      if (!config) return { ok: false, error: "getCurrentRuleConfiguration returned undefined — is a PCB document open and active?" };
      return { ok: true, name, config, savedConfigurations: saved };
    `,
  },
  {
    definition: {
      name: "easyeda_drc_set_rules",
      description:
        "Modify the current PCB DRC rules without any manual clicking. Pass a partial object matching the shape returned by easyeda_drc_get_rules (e.g. {config:{Physics:{Track:{copperThickness1oz:{form:{strokeWidthMin:0.15}}}}}}). It is deep-merged into the current configuration (objects merge recursively; arrays like spacing tables are replaced wholesale — pass the full table) and written back. Optionally save the result as a named configuration.",
      inputSchema: {
        type: "object",
        properties: {
          rules: { type: "object", description: "Partial rule configuration to merge in. Units: mm." },
          saveAs: { type: "string", description: "Optional: also persist the merged config under this name (overwrites same-named custom config)." },
        },
        required: ["rules"],
      },
    },
    buildCode: (args) => `
      const current = await eda.pcb_Drc.getCurrentRuleConfiguration();
      if (!current) return { ok: false, error: "No current rule configuration — is a PCB document open and active?" };
      const patch = ${JSON.stringify(args.rules)};
      const deepMerge = ${DEEP_MERGE_SRC};
      const merged = deepMerge(current, patch);
      const wrote = await eda.pcb_Drc.overwriteCurrentRuleConfiguration(merged);
      let savedAs = null;
      ${args.saveAs ? `savedAs = await eda.pcb_Drc.saveRuleConfiguration(merged, ${JSON.stringify(args.saveAs)}, true);` : ""}
      return { ok: wrote === true, wrote, savedAs, configName: merged.name };
    `,
  },
  {
    definition: {
      name: "easyeda_drc_check",
      description:
        "Run the PCB design rule check and return the violation list. Requires a PCB document open. Set showUi=true to also open EasyEDA's DRC panel.",
      inputSchema: {
        type: "object",
        properties: {
          showUi: { type: "boolean", default: false },
        },
      },
    },
    buildCode: (args) => `
      const violations = await eda.pcb_Drc.check(true, ${args.showUi === true}, true);
      if (!Array.isArray(violations)) return { ok: false, error: "check() did not return a violation array", raw: violations };
      return { ok: true, count: violations.length, violations };
    `,
  },
  {
    definition: {
      name: "easyeda_drc_net_classes",
      description:
        "Manage PCB net classes and differential pairs (DRC rule groups) without manual clicking. kind='net_class' (default) or 'differential_pair'. Actions — net_class: list|create|delete|add_nets|remove_nets (args: name, nets[], color). differential_pair: list|create|delete (args: name, positiveNet, negativeNet).",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "create", "delete", "add_nets", "remove_nets"] },
          kind: { type: "string", enum: ["net_class", "differential_pair"], default: "net_class" },
          name: { type: "string" },
          nets: { type: "array", items: { type: "string" } },
          color: { type: "string", description: "Hex color for create, e.g. #FF0000" },
          positiveNet: { type: "string" },
          negativeNet: { type: "string" },
        },
        required: ["action"],
      },
    },
    buildCode: (args) => {
      const { action, kind = "net_class", name, nets = [], color = "#1E90FF", positiveNet, negativeNet } = args;
      const n = JSON.stringify(name ?? "");
      const netsJson = JSON.stringify(nets);
      if (kind === "differential_pair") {
        if (action === "list") return `const r = await eda.pcb_Drc.getAllDifferentialPairs(); return { ok: true, differentialPairs: r };`;
        if (action === "create") return `const r = await eda.pcb_Drc.createDifferentialPair(${n}, ${JSON.stringify(positiveNet)}, ${JSON.stringify(negativeNet)}); return { ok: r === true, result: r };`;
        if (action === "delete") return `const r = await eda.pcb_Drc.deleteDifferentialPair(${n}); return { ok: r === true, result: r };`;
        return `return { ok: false, error: "Unsupported action '${action}' for differential_pair (use list|create|delete)" };`;
      }
      switch (action) {
        case "list": return `const r = await eda.pcb_Drc.getAllNetClasses(); return { ok: true, netClasses: r };`;
        case "create": return `const r = await eda.pcb_Drc.createNetClass(${n}, ${netsJson}, ${JSON.stringify(color)}); return { ok: r === true, result: r };`;
        case "delete": return `const r = await eda.pcb_Drc.deleteNetClass(${n}); return { ok: r === true, result: r };`;
        case "add_nets": return `const r = await eda.pcb_Drc.addNetToNetClass(${n}, ${netsJson}); return { ok: r === true, result: r };`;
        case "remove_nets": return `const r = await eda.pcb_Drc.removeNetFromNetClass(${n}, ${netsJson}); return { ok: r === true, result: r };`;
        default: return `return { ok: false, error: "Unknown action" };`;
      }
    },
  },
];
```

- [ ] **Step 2: Register and dispatch in index.mjs**

At top: `import { edaTools } from "./eda-tools.mjs";`
Tool list: change `server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))` to `({ tools: [...tools, ...edaTools.map((t) => t.definition)] })`.
In the call handler, before the final `Unknown tool` return:

```js
const hl = edaTools.find((t) => t.definition.name === name);
if (hl) {
  const r = await executeCode(hl.buildCode(args), { timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : DEFAULT_EXECUTE_TIMEOUT_MS });
  return reply(r);
}
```

Wrap `hl.buildCode(args)` dispatch in the existing try/catch (already present around the whole handler).

- [ ] **Step 3: Update smoke-test expected list**

In `smoke-test.mjs`, extend `expected` with: `"easyeda_drc_get_rules", "easyeda_drc_set_rules", "easyeda_drc_check", "easyeda_drc_net_classes"`.

Run: `npm run smoke`
Expected: PASS with 10+ tools registered.

- [ ] **Step 4: Live verification against running EasyEDA**

Using direct HTTP to the bridge (port from `/health` scan), exercise each snippet exactly as `buildCode` emits it:

1. get_rules → expect `{ok:true, name:"Custom Config", config:{...}}`.
2. Round-trip set_rules with a no-op patch (read `config.Physics.Track.copperThickness1oz.form.strokeWidthMin` from step 1, patch it to the same value) → expect `{ok:true}`.
3. Real change: patch `strokeWidthMin` to a different value, re-run get_rules to confirm it stuck, then patch it back to the original. Confirm restored.
4. drc_check → expect `{ok:true, count:N, violations:[...]}`.
5. net_classes list (both kinds) → expect `{ok:true, ...}`.

Expected: all five return ok:true; EasyEDA never shows a dialog.

- [ ] **Step 5: Commit**

```bash
git add eda-tools.mjs index.mjs smoke-test.mjs
git commit -m "feat: DRC tools — get/set rules, check, net classes/diff pairs"
```

---

### Task 4: Convenience tools (get_state, open_project, save)

**Files:**
- Modify: `eda-tools.mjs` (append three entries to `edaTools`)
- Modify: `smoke-test.mjs` (expected tool list)

**Interfaces:**
- Consumes: `edaTools` registration/dispatch from Task 3 (no index.mjs changes needed — new entries are picked up automatically).

- [ ] **Step 1: Append the three tool entries**

```js
  {
    definition: {
      name: "easyeda_get_state",
      description:
        "One-call orientation: current project, board, PCB, schematic, and active DRC config name. Fields that don't apply to the current editor context return {error} instead of failing the call.",
      inputSchema: { type: "object", properties: {} },
    },
    buildCode: () => `
      const tryCall = async (fn) => { try { return await fn(); } catch (e) { return { error: e.message }; } };
      const [project, board, pcb, schematic, drcConfigName] = await Promise.all([
        tryCall(() => eda.dmt_Project.getCurrentProjectInfo()),
        tryCall(() => eda.dmt_Board.getCurrentBoardInfo()),
        tryCall(() => eda.dmt_Pcb.getCurrentPcbInfo()),
        tryCall(() => eda.dmt_Schematic.getCurrentSchematicInfo()),
        tryCall(() => eda.pcb_Drc.getCurrentRuleConfigurationName()),
      ]);
      return { ok: true, project, board, pcb, schematic, drcConfigName };
    `,
  },
  {
    definition: {
      name: "easyeda_open_project",
      description:
        "Open a project by (partial, case-insensitive) name. Scans all teams/folders in parallel inside EasyEDA. If multiple projects match, returns the candidate list instead of opening. NOTE: openProject may discard unsaved changes in the current project.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Project name or substring" },
        },
        required: ["name"],
      },
    },
    buildCode: (args) => `
      const needle = ${JSON.stringify(args.name)}.toLowerCase();
      const teams = (await eda.dmt_Team.getAllTeamsInfo()) || [];
      const matches = [];
      await Promise.all(teams.map(async (team) => {
        const teamUuid = team.uuid ?? team.teamUuid ?? team.id;
        if (!teamUuid) return;
        let folderUuids = [];
        try { folderUuids = (await eda.dmt_Folder.getAllFoldersUuid(teamUuid)) || []; } catch (e) {}
        const scopes = [undefined, ...folderUuids];
        await Promise.all(scopes.map(async (folderUuid) => {
          let uuids = [];
          try { uuids = (await eda.dmt_Project.getAllProjectsUuid(teamUuid, folderUuid)) || []; } catch (e) { return; }
          await Promise.all(uuids.map(async (uuid) => {
            try {
              const info = await eda.dmt_Project.getProjectInfo(uuid);
              const label = String((info && (info.friendlyName ?? info.name ?? info.projectName)) ?? "");
              if (label.toLowerCase().includes(needle)) matches.push({ uuid, name: label });
            } catch (e) {}
          }));
        }));
      }));
      const unique = [...new Map(matches.map((m) => [m.uuid, m])).values()];
      if (unique.length === 0) return { ok: false, error: "No project name matched: " + needle };
      if (unique.length > 1) return { ok: false, error: "Multiple projects matched — be more specific.", matches: unique };
      await eda.dmt_Project.openProject(unique[0].uuid);
      return { ok: true, opened: unique[0] };
    `,
  },
  {
    definition: {
      name: "easyeda_save",
      description:
        "Save the currently open PCB and/or schematic documents (whichever are active). Returns per-document results.",
      inputSchema: { type: "object", properties: {} },
    },
    buildCode: () => `
      const results = {};
      try { results.pcb = await eda.pcb_Document.save(); } catch (e) { results.pcb = { error: e.message }; }
      try { results.schematic = await eda.sch_Document.save(); } catch (e) { results.schematic = { error: e.message }; }
      const anyOk = [results.pcb, results.schematic].some((r) => r === true || (r && r.error === undefined));
      return { ok: anyOk, results };
    `,
  },
```

- [ ] **Step 2: Update smoke-test expected list**

Extend `expected` in `smoke-test.mjs` with: `"easyeda_get_state", "easyeda_open_project", "easyeda_save"`.

Run: `npm run smoke`
Expected: PASS, 13 tools registered.

- [ ] **Step 3: Live verification**

Via direct HTTP `/execute` with the exact emitted snippets:
1. get_state → expect `{ok:true, project:{...}}` with real project info; fields for closed editors return `{error}`.
2. open_project with the current project's own name (harmless reopen) OR with a nonsense name expecting `{ok:false, error:"No project name matched..."}` — run the nonsense-name case at minimum; only reopen the real project if the user's current work is saved (check via get_state first, ask nothing — skip the destructive variant if in doubt, the field-name verification is what matters: confirm `getProjectInfo` labels resolve non-empty for at least one project).
3. save → expect `{ok:true}` with at least one of pcb/schematic saved.

Adjust field-name fallbacks (`friendlyName ?? name ?? projectName`) if the live probe shows different keys.

- [ ] **Step 4: Commit**

```bash
git add eda-tools.mjs smoke-test.mjs
git commit -m "feat: convenience tools — get_state, open_project, save"
```

---

### Task 5: Version bump + final verification

**Files:**
- Modify: `package.json` (version), `index.mjs` (Server version string)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Bump versions**

`package.json`: `"version": "0.2.0"`.
`index.mjs`: `new Server({ name: "easyeda-mcp", version: "0.2.0" }, ...)`.

- [ ] **Step 2: Full test pass**

Run: `node --test test/ && npm run smoke`
Expected: all unit tests pass; smoke reports 13 tools and health PASS.

- [ ] **Step 3: Commit**

```bash
git add package.json index.mjs
git commit -m "chore: v0.2.0"
```

- [ ] **Step 4: Tell the user to restart their MCP session**

The running Claude session holds the old tool list; the new tools appear after the easyeda MCP server restarts (e.g. `/mcp` reconnect or new session).

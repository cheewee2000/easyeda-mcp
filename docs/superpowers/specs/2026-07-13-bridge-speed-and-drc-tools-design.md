# easyeda-mcp v0.2 — Speed fixes + DRC & convenience tools

**Date:** 2026-07-13
**Status:** Approved

## Problem

1. **Slow:** every MCP tool call re-discovers the bridge by sequentially probing
   ports 49620–49629 (600ms timeout each) before doing any work, and
   `easyeda_execute` adds a redundant health round trip. Warm calls can carry
   seconds of pure overhead.
2. **Manual clicking:** changing DRC rules requires hand-editing dialogs in
   EasyEDA Pro, even though `eda.pcb_Drc` exposes the rule configuration
   programmatically (`getCurrentRuleConfiguration`,
   `overwriteCurrentRuleConfiguration`, `saveRuleConfiguration`, `check`, net
   classes, differential pairs — all BETA).
3. **Round-trip tax:** the MCP only exposes raw `easyeda_execute`, so the agent
   issues many small execute calls per task.

## Scope

Modify only this repo (the MCP wrapper). The JLCEDA bridge server
(`easyeda-api-skill/scripts/bridge-server.mjs`) and the `run-api-gateway.eext`
extension are published artifacts and stay untouched.

## Design

### 1. Request-path speed (index.mjs)

- **Port cache:** module-level `cachedPort`. Tool calls use it directly; on a
  connection failure, invalidate → rediscover → retry once.
- **Parallel discovery:** probe all 10 ports concurrently (`Promise.all`);
  worst case ~600ms instead of ~6s.
- **Single round trip:** `easyeda_execute` no longer pre-checks `/health`; it
  POSTs to `/execute` on the cached port and handles failure by rediscovery.

### 2. DRC tools

All implemented as canned scripts sent through the existing `/execute` path.

| Tool | Behavior |
|---|---|
| `easyeda_drc_get_rules` | Current rule configuration + its name + list of saved configuration names. |
| `easyeda_drc_set_rules` | Deep-merge a partial rules object into the current configuration, write back via `overwriteCurrentRuleConfiguration()`. Optional `saveAs` name → `saveRuleConfiguration()`. |
| `easyeda_drc_check` | Run `pcb_Drc.check(strict, ui, verbose=true)`, return violations. |
| `easyeda_drc_net_classes` | `action`: list / create / delete / add_nets / remove_nets; also list/create/delete differential pairs. |

**Constraint:** the rule-configuration object shape is undocumented
(`{[key:string]: any}`). Implementation starts with a live probe of
`getCurrentRuleConfiguration()` against the running EasyEDA to learn the real
schema; merge logic is built and tested against that. BETA APIs may fail —
tools must surface `{ok:false, error}` clearly, never fake success.

### 3. Convenience tools

| Tool | Behavior |
|---|---|
| `easyeda_get_state` | One call: current project, open documents, active editor type. |
| `easyeda_open_project` | Open project by name; team/folder/project scan runs inside one execute with parallelized lookups. |
| `easyeda_save` | Save current document/project. |
| Export (Gerber/BOM) | Only if the API supports it — verify during implementation; drop silently if not. |

### 4. Structure, errors, testing

- Canned scripts + tool definitions live in a new `eda-tools.mjs`; `index.mjs`
  stays the thin MCP/stdio layer (discovery, HTTP, dispatch).
- Every tool returns `{ok, ...}`; when the EDA WebSocket is down, the error
  names the fix (open EasyEDA / reload extension).
- Extend `smoke-test.mjs`; verify live against the running EasyEDA instance.
- Version → 0.2.0.

## Success criteria

- Warm tool calls add <50ms overhead beyond EasyEDA execution time.
- DRC rules can be read, modified, and saved from Claude with zero manual
  clicks in EasyEDA.
- Common tasks (orient, open project, save, DRC cycle) each take one tool call.

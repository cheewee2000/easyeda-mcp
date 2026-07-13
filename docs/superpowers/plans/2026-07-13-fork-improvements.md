# easyeda-api-skill Fork Improvements Plan

> **For agentic workers:** Execute task-by-task with review. Steps use checkbox syntax.

**Goal:** Four upstream-PR-ready improvements to the forked bridge server (branch `improvements` in ~/Documents/GitHub/easyeda-api-skill), plus a matching easyeda-mcp update.

**Architecture:** All bridge changes in `scripts/bridge-server.mjs` (499 lines, plain Node + `ws`). One commit per improvement, each independently revertable. Verified with a mock EDA WebSocket client (connect to `ws://127.0.0.1:PORT/eda`, send `{type:"register", windowId}`, answer `execute` messages) so the user's live EasyEDA connection is not disturbed during development; live swap happens once at the end.

## Global Constraints

- Keep JLCEDA's code style (plain JS, existing log prefix conventions); minimal diffs — these are upstream PR candidates.
- Backward compatible: existing clients that send `{code, windowId}` only must behave exactly as before (30s default timeout).
- Do not touch the `references/` docs or anything outside `scripts/bridge-server.mjs` + `SKILL.md` + `README.md`.
- Test with a mock EDA client on a scratch port; do NOT kill the running bridge (port 49620) during development.

---

### Task F1: Per-request timeout on /execute

- `POST /execute` and agent-WS `{type:"execute"}` accept optional `timeoutMs` (number, clamp to [1000, 600000]); default stays `REQUEST_TIMEOUT_MS` (30s).
- Thread it through `executeOnEda(code, windowId, timeoutMs)` to the pending-request timer.
- Timeout error message includes the actual timeout used.
- Commit: `feat(bridge): per-request timeoutMs on /execute (default 30s)`

### Task F2: Parallel cold-start port scan

- `findExistingInstance()` and `findAvailablePort()` probe all 10 ports with `Promise.all` instead of sequential await.
- SKILL.md startup snippet: replace `sleep 2` + sequential curl scans with a single parallelized scan loop (background curls + wait) and a short poll instead of fixed sleep.
- Commit: `perf(bridge): parallel port scan on startup; faster SKILL startup snippet`

### Task F3: Log hygiene

- Add `LOG_LEVEL` env (`debug|info|error`, default `info`). Ping/pong and per-message chatter → `debug`. Connections, registrations, executes (id + code length only), errors → `info` with ISO timestamps.
- Commit: `feat(bridge): LOG_LEVEL env; ping/pong moved to debug`

### Task F4: Richer /health

- On EDA window registration, bridge sends itself an `execute` to that window fetching app metadata (version etc. via `eda.sys_Environment` — read references/classes/SYS_Environment.md for the real method; wrap in try/catch, cache result on the window record; never block registration on it).
- `/health` gains `edaVersion` (from active window, null if unknown) and `windows: [{windowId, active, edaVersion}]`.
- Commit: `feat(bridge): report EasyEDA version and window details in /health`

### Task F5 (easyeda-mcp repo, after F1 lands): pass timeoutMs through

- `executeCode` body includes `timeoutMs` (client keeps its own abort at timeoutMs+1000). Version → 0.2.1. Smoke + unit pass. Push.

### Final: review whole fork diff, live swap (restart bridge on new code), verify EDA extension reconnects, run one warm easyeda_execute + health check.

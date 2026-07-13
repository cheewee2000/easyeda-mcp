# easyeda-mcp

MCP server that controls a running [EasyEDA Pro](https://pro.easyeda.com) instance from Claude Code (or any MCP client), via JLCEDA's [easyeda-api-skill](https://github.com/easyeda/easyeda-api-skill) bridge and the `run-api-gateway` extension.

**Version 0.2.0**

## How it works

```
MCP client ⇄ (stdio) ⇄ easyeda-mcp ⇄ (HTTP, port 49620-49629) ⇄ bridge server ⇄ (WebSocket) ⇄ EasyEDA Pro
```

The bridge server and the EasyEDA-side extension are JLCEDA's published artifacts — this server wraps them with fast discovery (cached port, parallel scan, single round trip per call) and high-level tools so common actions are one tool call instead of hand-written scripts.

## Tools

| Tool | What it does |
|---|---|
| `easyeda_execute` | Run arbitrary JS inside EasyEDA (`async function(eda){...}` body) |
| `easyeda_health` / `easyeda_start_bridge` / `easyeda_stop_bridge` | Bridge lifecycle (auto-starts on demand) |
| `easyeda_list_windows` / `easyeda_select_window` | Multi-window targeting |
| `easyeda_drc_get_rules` | Current DRC rule configuration + net/region/net-by-net rules (mm) |
| `easyeda_drc_set_rules` | Patch DRC rules via deep merge (see caveat below) |
| `easyeda_drc_check` | Run DRC, return the violation list |
| `easyeda_drc_net_classes` | Net classes & differential pairs: list/create/delete/add/remove |
| `easyeda_get_state` | One-call orientation: project, board, PCB, schematic, DRC config |
| `easyeda_open_project` | Open a project by (partial) name |
| `easyeda_save` | Save open PCB/schematic documents |

## Setup

1. Install the [easyeda-api-skill](https://github.com/easyeda/easyeda-api-skill) bridge and the `run-api-gateway.eext` extension in EasyEDA Pro (enable its External Interactions permission).
2. Point this server at the bridge script if it's not at the default path: `EASYEDA_BRIDGE_SCRIPT=/path/to/bridge-server.mjs`
3. Register with your MCP client, e.g. for Claude Code:

```json
{
  "mcpServers": {
    "easyeda": { "command": "node", "args": ["/path/to/easyeda-mcp/index.mjs"] }
  }
}
```

## Known limitation: global DRC rule writes

EasyEDA Pro v2.2.47.x has an engine bug: the BETA `overwriteCurrentRuleConfiguration()` API deadlocks and `saveRuleConfiguration()` is non-functional. `easyeda_drc_set_rules` therefore fast-fails global config writes (~5s) with guidance, while per-net, region, and net-by-net rule writes work fully. If a newer EasyEDA build fixes the API, the fast-fail can be removed.

## Development

```bash
npm run smoke                        # spawns the server, checks tool registration + health
node --test test/deep-merge.test.mjs # unit tests
```

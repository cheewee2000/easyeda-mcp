import { test } from "node:test";
import assert from "node:assert/strict";
import { edaTools } from "../eda-tools.mjs";

// Every tool's buildCode must emit a syntactically valid async function body,
// for a representative set of args, so a malformed snippet fails CI instead of
// only blowing up inside EasyEDA at call time.
const SAMPLE_ARGS = {
  easyeda_drc_get_rules: [{}],
  easyeda_drc_set_rules: [{}, { rules: { config: { Physics: {} } } }, { netRules: [] }, { regionRules: [] }, { netByNetRules: {} }],
  easyeda_drc_check: [{}, { showUi: true }],
  easyeda_drc_net_classes: [
    { action: "list" },
    { action: "create", name: "PWR", nets: ["3V3"], color: "#FF0000" },
    { action: "create", kind: "differential_pair", name: "USB", positiveNet: "DP", negativeNet: "DM" },
    { action: "delete", name: "PWR" },
    { action: "add_nets", name: "PWR", nets: ["GND"] },
  ],
  easyeda_get_state: [{}],
  easyeda_open_project: [{ name: "Super" }],
  easyeda_save: [{}],
  easyeda_get_netlist: [{}, { verbose: true }],
  easyeda_survey_pcb: [{}, { net: "GND" }],
  easyeda_sync_to_pcb: [{}, { apply: true }],
};

function assertValidAsyncBody(code) {
  // Throws SyntaxError if the emitted snippet is not a valid function body.
  new Function("eda", `return (async function(eda){${code}})`);
}

test("every buildCode emits valid JS for representative args", () => {
  for (const tool of edaTools) {
    const name = tool.definition.name;
    const argSets = SAMPLE_ARGS[name];
    assert.ok(argSets, `no sample args defined for ${name} — add some so it is covered`);
    for (const args of argSets) {
      assert.doesNotThrow(() => assertValidAsyncBody(tool.buildCode(args)), `${name} emitted invalid JS for args ${JSON.stringify(args)}`);
    }
  }
});

test("every tool definition has name, description, and object inputSchema", () => {
  for (const tool of edaTools) {
    const d = tool.definition;
    assert.equal(typeof d.name, "string");
    assert.ok(d.name.startsWith("easyeda_"), `${d.name} should be namespaced easyeda_`);
    assert.ok(d.description && d.description.length > 20, `${d.name} needs a real description`);
    assert.equal(d.inputSchema.type, "object");
  }
});

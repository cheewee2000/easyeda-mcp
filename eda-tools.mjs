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

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
        "Get the current PCB DRC rule configuration (shape: {name, config:{Spacing,Physics,...}}), the list of saved configuration names, and the per-net/region/net-by-net rule tables (netRules, regionRules, netByNetRules). Values are in mm. Requires a PCB document open in EasyEDA Pro. Use this before easyeda_drc_set_rules to read-modify-write netRules/regionRules/netByNetRules (the only rule writes that reliably work in EasyEDA Pro v2.2.47.x — see easyeda_drc_set_rules description).",
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
      let netRules = null, netRulesError = null;
      try { netRules = await eda.pcb_Drc.getNetRules(); } catch (e) { netRulesError = e.message; }
      let regionRules = null, regionRulesError = null;
      try { regionRules = await eda.pcb_Drc.getRegionRules(); } catch (e) { regionRulesError = e.message; }
      let netByNetRules = null, netByNetRulesError = null;
      try { netByNetRules = await eda.pcb_Drc.getNetByNetRules(); } catch (e) { netByNetRulesError = e.message; }
      if (!config) return { ok: false, error: "getCurrentRuleConfiguration returned undefined — is a PCB document open and active?" };
      return {
        ok: true,
        name,
        config,
        savedConfigurations: saved,
        netRules,
        netRulesError,
        regionRules,
        regionRulesError,
        netByNetRules,
        netByNetRulesError,
      };
    `,
  },
  {
    definition: {
      name: "easyeda_drc_set_rules",
      description:
        "Write PCB DRC rules without any manual clicking. KNOWN ENGINE BUG in EasyEDA Pro v2.2.47.x: writing the global rule configuration (the `rules` param, which merges into Physics/Spacing/etc via overwriteCurrentRuleConfiguration) deadlocks the underlying BETA API — this tool races it against a 5s timer and fails fast with guidance instead of hanging. saveRuleConfiguration (used by saveAs) is also non-functional in that build (returns false, no-ops). By contrast, per-net rules (netRules), region rules (regionRules), and net-by-net rules (netByNetRules) use working overwrite*Rules APIs that resolve in milliseconds — prefer these when possible. Pass any combination of rules/netRules/regionRules/netByNetRules; at least one is required. Read current values first via easyeda_drc_get_rules — netRules/regionRules/netByNetRules are full-array/object replacements, not merges.",
      inputSchema: {
        type: "object",
        properties: {
          rules: {
            type: "object",
            description:
              "Partial global rule configuration to deep-merge in (e.g. {config:{Physics:{Track:{copperThickness1oz:{form:{strokeWidthMin:0.15}}}}}}). Units: mm. WARNING: writing this is known to hang for 5s and then fail in EasyEDA Pro v2.2.47.x (overwriteCurrentRuleConfiguration deadlocks upstream) — prefer netRules/regionRules/netByNetRules when the change fits there.",
          },
          netRules: {
            type: "array",
            description:
              "Full net-rules array, written via the working overwriteNetRules API; arrays replace the full rule set — read first via easyeda_drc_get_rules.",
          },
          regionRules: {
            type: "array",
            description:
              "Full region-rules array, written via the working overwriteRegionRules API; arrays replace the full rule set — read first via easyeda_drc_get_rules.",
          },
          netByNetRules: {
            type: "object",
            description:
              "Full net-by-net rules object, written via the working overwriteNetByNetRules API; arrays replace the full rule set — read first via easyeda_drc_get_rules.",
          },
          saveAs: { type: "string", description: "Optional: also persist the merged global config under this name (only applies when rules is provided; overwrites same-named custom config). Known non-functional in EasyEDA Pro v2.2.47.x (saveRuleConfiguration no-ops)." },
        },
      },
    },
    buildCode: (args) => {
      const hasRules = args.rules !== undefined && args.rules !== null;
      const hasNetRules = Array.isArray(args.netRules);
      const hasRegionRules = Array.isArray(args.regionRules);
      const hasNetByNetRules = args.netByNetRules !== undefined && args.netByNetRules !== null && typeof args.netByNetRules === "object";

      if (!hasRules && !hasNetRules && !hasRegionRules && !hasNetByNetRules) {
        return `return { ok: false, error: "easyeda_drc_set_rules requires at least one of: rules, netRules, regionRules, netByNetRules." };`;
      }

      const steps = [`const results = {};`];

      if (hasNetRules) {
        steps.push(`
      try {
        const r = await eda.pcb_Drc.overwriteNetRules(${JSON.stringify(args.netRules)});
        results.netRules = { ok: r === true, wrote: r };
      } catch (e) { results.netRules = { ok: false, error: e.message }; }`);
      }
      if (hasRegionRules) {
        steps.push(`
      try {
        const r = await eda.pcb_Drc.overwriteRegionRules(${JSON.stringify(args.regionRules)});
        results.regionRules = { ok: r === true, wrote: r };
      } catch (e) { results.regionRules = { ok: false, error: e.message }; }`);
      }
      if (hasNetByNetRules) {
        steps.push(`
      try {
        const r = await eda.pcb_Drc.overwriteNetByNetRules(${JSON.stringify(args.netByNetRules)});
        results.netByNetRules = { ok: r === true, wrote: r };
      } catch (e) { results.netByNetRules = { ok: false, error: e.message }; }`);
      }

      if (hasRules) {
        steps.push(`
      {
        const current = await eda.pcb_Drc.getCurrentRuleConfiguration();
        if (!current) {
          results.globalConfig = { ok: false, error: "No current rule configuration — is a PCB document open and active?" };
        } else {
          const patch = ${JSON.stringify(args.rules)};
          const deepMerge = ${DEEP_MERGE_SRC};
          const merged = deepMerge(current, patch);
          const race = await Promise.race([
            eda.pcb_Drc.overwriteCurrentRuleConfiguration(merged).then((v) => ({ status: "resolved", value: v })),
            new Promise((resolve) => setTimeout(() => resolve({ status: "timeout" }), 5000)),
          ]);
          if (race.status === "timeout") {
            results.globalConfig = {
              ok: false,
              error: "overwriteCurrentRuleConfiguration hung (>5s) — known engine bug in EasyEDA Pro v2.2.47.x: the BETA global rule-write APIs deadlock (saveRuleConfiguration is also non-functional). Workarounds: edit global rules manually via Design > Design Rules, or update EasyEDA Pro. Per-net/region rules CAN be written: use the netRules/regionRules/netByNetRules parameters of this tool.",
            };
          } else {
            const wrote = race.value;
            let savedAs = null;
            ${args.saveAs ? `savedAs = await eda.pcb_Drc.saveRuleConfiguration(merged, ${JSON.stringify(args.saveAs)}, true);` : ""}
            results.globalConfig = { ok: wrote === true, wrote, savedAs, configName: merged.name };
          }
        }
      }`);
      }

      steps.push(`
      const overallOk = Object.values(results).every((r) => r.ok);
      return { ok: overallOk, results };`);

      return steps.join("\n");
    },
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

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
      try {
        const current = await eda.pcb_Drc.getCurrentRuleConfiguration();
        if (!current) {
          results.globalConfig = { ok: false, error: "No current rule configuration — is a PCB document open and active?" };
        } else {
          const patch = ${JSON.stringify(args.rules)};
          const deepMerge = ${DEEP_MERGE_SRC};
          const merged = deepMerge(current, patch);
          const race = await Promise.race([
            eda.pcb_Drc.overwriteCurrentRuleConfiguration(merged)
              .then((v) => ({ status: "resolved", value: v }))
              .catch((e) => ({ status: "rejected", error: String((e && e.message) || e) })),
            new Promise((resolve) => setTimeout(() => resolve({ status: "timeout" }), 5000)),
          ]);
          if (race.status === "timeout") {
            results.globalConfig = {
              ok: false,
              error: "overwriteCurrentRuleConfiguration hung (>5s) — known engine bug in EasyEDA Pro v2.2.47.x: the BETA global rule-write APIs deadlock (saveRuleConfiguration is also non-functional). Workarounds: edit global rules manually via Design > Design Rules, or update EasyEDA Pro. Per-net/region rules CAN be written: use the netRules/regionRules/netByNetRules parameters of this tool.",
            };
          } else if (race.status === "rejected") {
            results.globalConfig = { ok: false, error: race.error };
          } else {
            const wrote = race.value;
            let savedAs = null;
            ${args.saveAs ? `savedAs = await eda.pcb_Drc.saveRuleConfiguration(merged, ${JSON.stringify(args.saveAs)}, true);` : ""}
            results.globalConfig = { ok: wrote === true, wrote, savedAs, configName: merged.name };
          }
        }
      } catch (e) { results.globalConfig = { ok: false, error: e.message }; }`);
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
      const isNonEmptyString = (v) => typeof v === "string" && v.length > 0;
      if (kind === "differential_pair") {
        if (action === "list") return `const r = await eda.pcb_Drc.getAllDifferentialPairs(); return { ok: true, differentialPairs: r };`;
        if (action === "create") {
          if (!isNonEmptyString(positiveNet) || !isNonEmptyString(negativeNet)) {
            return `return { ok: false, error: ${JSON.stringify("positiveNet and negativeNet (non-empty strings) are required for differential_pair create")} };`;
          }
          return `const r = await eda.pcb_Drc.createDifferentialPair(${n}, ${JSON.stringify(positiveNet)}, ${JSON.stringify(negativeNet)}); return { ok: r === true, result: r };`;
        }
        if (action === "delete") return `const r = await eda.pcb_Drc.deleteDifferentialPair(${n}); return { ok: r === true, result: r };`;
        return `return { ok: false, error: ${JSON.stringify(`Unsupported action '${action}' for differential_pair (use list|create|delete)`)} };`;
      }
      if (["create", "add_nets", "remove_nets"].includes(action) && !isNonEmptyString(name)) {
        return `return { ok: false, error: ${JSON.stringify(`name (non-empty string) is required for net_class ${action}`)} };`;
      }
      switch (action) {
        case "list": return `const r = await eda.pcb_Drc.getAllNetClasses(); return { ok: true, netClasses: r };`;
        case "create": return `const r = await eda.pcb_Drc.createNetClass(${n}, ${netsJson}, ${JSON.stringify(color)}); return { ok: r === true, result: r };`;
        case "delete": return `const r = await eda.pcb_Drc.deleteNetClass(${n}); return { ok: r === true, result: r };`;
        case "add_nets": return `const r = await eda.pcb_Drc.addNetToNetClass(${n}, ${netsJson}); return { ok: r === true, result: r };`;
        case "remove_nets": return `const r = await eda.pcb_Drc.removeNetFromNetClass(${n}, ${netsJson}); return { ok: r === true, result: r };`;
        default: return `return { ok: false, error: ${JSON.stringify(`Unknown action '${action}'`)} };`;
      }
    },
  },
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
    buildCode: (args) => {
      if (typeof args.name !== "string" || !args.name.trim()) {
        return `return { ok: false, error: "name must be a non-empty string" };`;
      }
      return `
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
    `;
    },
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
  {
    definition: {
      name: "easyeda_get_netlist",
      description:
        "Get the schematic netlist — the source of truth for connectivity — as a compact per-component map of {designator, uniqueId, pins:{pinNumber:net}} plus a net→pins index. Handles the well-known 'i is not iterable' trap (sch_Netlist.getNetlist throws when a PCB tab is active) by opening the schematic page, reading, then restoring the PCB tab. Flags components whose Unique ID attribute is empty in `unsyncableComponents` — those never sync to the PCB via importChanges (a common bug for API-created parts). Set verbose=true to also include each component's full property block (large). Requires an open project containing a schematic.",
      inputSchema: {
        type: "object",
        properties: {
          verbose: { type: "boolean", default: false, description: "Also include each component's full property block (large output)." },
        },
      },
    },
    buildCode: (args) => `
      const proj = await eda.dmt_Project.getCurrentProjectInfo();
      if (!proj) return { ok: false, error: "No current project — open a project first." };
      const board = (proj.data || [])[0];
      const pages = (board && board.schematic && board.schematic.page) || [];
      const schPageUuid = pages[0] && pages[0].uuid;
      const pcbUuid = board && board.pcb && board.pcb.uuid;
      if (!schPageUuid) return { ok: false, error: "No schematic page found in the current board." };
      await eda.dmt_EditorControl.openDocument(schPageUuid);
      await new Promise((r) => setTimeout(r, 1500));
      let raw = null, err = null;
      try { raw = JSON.parse(await eda.sch_Netlist.getNetlist()); } catch (e) { err = e.message; }
      if (pcbUuid) { try { await eda.dmt_EditorControl.openDocument(pcbUuid); } catch (e) {} }
      if (!raw) return { ok: false, error: "sch_Netlist.getNetlist() failed: " + err };
      const components = Object.entries(raw).map(([key, c]) => {
        const p = (c && c.props) || {};
        return { key, uniqueId: p["Unique ID"] || null, designator: p["Designator"] || null, pins: (c && c.pins) || {} };
      });
      const unsyncableComponents = components.filter((c) => !c.uniqueId).map((c) => c.designator || c.key);
      const netIndex = {};
      for (const c of components) {
        for (const [pin, net] of Object.entries(c.pins)) {
          (netIndex[net] = netIndex[net] || []).push((c.designator || c.key) + "." + pin);
        }
      }
      const out = { ok: true, componentCount: components.length, netCount: Object.keys(netIndex).length, components, netIndex, unsyncableComponents };
      ${args.verbose === true ? "out.raw = raw;" : ""}
      return out;
    `,
  },
  {
    definition: {
      name: "easyeda_survey_pcb",
      description:
        "One-call PCB geometry survey, unit-normalized to mils (hides the 1-mil vs 10-mil getter trap) and token-bounded. Default returns every component (designator, uniqueId, x_mil, y_mil, rotation, layer), a per-net summary (pad/track/via counts), and per-layer track counts. Pass net='<NET>' to additionally return that net's pads, tracks, and vias in detail. Coordinates use EasyEDA's convention (Y extends downward as negative). Requires a PCB document in the current board.",
      inputSchema: {
        type: "object",
        properties: {
          net: { type: "string", description: "Optional net name to also return detailed pad/track/via geometry for." },
        },
      },
    },
    buildCode: (args) => {
      const netFilter = typeof args.net === "string" && args.net.length ? JSON.stringify(args.net) : "null";
      return `
      const netFilter = ${netFilter};
      const round = (v) => (typeof v === "number" ? Math.round(v * 100) / 100 : v);
      const comps = await eda.pcb_PrimitiveComponent.getAll();
      const components = [];
      for (const c of comps) {
        components.push({
          id: await c.getState_PrimitiveId(),
          designator: c.getState_Designator ? await c.getState_Designator() : null,
          uniqueId: c.getState_UniqueId ? await c.getState_UniqueId() : null,
          x_mil: round(await c.getState_X()),
          y_mil: round(await c.getState_Y()),
          rotation: c.getState_Rotation ? await c.getState_Rotation() : null,
          layer: c.getState_Layer ? await c.getState_Layer() : null,
        });
      }
      const pads = await eda.pcb_PrimitivePad.getAll();
      const lines = await eda.pcb_PrimitiveLine.getAll();
      const vias = await eda.pcb_PrimitiveVia.getAll();
      const netSummary = {};
      const bump = (net, field) => { if (!net) return; (netSummary[net] = netSummary[net] || { padCount: 0, trackCount: 0, viaCount: 0 })[field]++; };
      const layerTrackCount = {};
      const detail = netFilter ? { pads: [], tracks: [], vias: [] } : null;
      for (const p of pads) {
        const net = p.getState_Net ? await p.getState_Net() : "";
        bump(net, "padCount");
        if (detail && net === netFilter) detail.pads.push({ id: await p.getState_PrimitiveId(), x_mil: round(await p.getState_X()), y_mil: round(await p.getState_Y()), net });
      }
      for (const l of lines) {
        const net = l.getState_Net ? await l.getState_Net() : "";
        const layer = l.getState_Layer ? await l.getState_Layer() : null;
        layerTrackCount[layer] = (layerTrackCount[layer] || 0) + 1;
        bump(net, "trackCount");
        if (detail && net === netFilter) detail.tracks.push({ layer, width_mil: l.getState_LineWidth ? round(await l.getState_LineWidth()) : null, x1_mil: round(await l.getState_StartX()), y1_mil: round(await l.getState_StartY()), x2_mil: round(await l.getState_EndX()), y2_mil: round(await l.getState_EndY()), net });
      }
      for (const v of vias) {
        const net = v.getState_Net ? await v.getState_Net() : "";
        bump(net, "viaCount");
        if (detail && net === netFilter) detail.vias.push({ id: await v.getState_PrimitiveId(), x_mil: round(await v.getState_X()), y_mil: round(await v.getState_Y()), net });
      }
      const out = { ok: true, counts: { components: components.length, pads: pads.length, tracks: lines.length, vias: vias.length, nets: Object.keys(netSummary).length }, components, netSummary, layerTrackCount };
      if (detail) out.netDetail = Object.assign({ net: netFilter }, detail);
      return out;
      `;
    },
  },
  {
    definition: {
      name: "easyeda_sync_to_pcb",
      description:
        "Reconcile the schematic netlist with the PCB — the safe wrapper around importChanges, which is known to silently no-op in several cases. DEFAULT is a dry run: it reads the authoritative schematic netlist (opening the schematic, then restoring the PCB tab), diffs it against the actual PCB pad nets (matched by Unique ID), and reports (a) per-pad net mismatches, (b) schematic components missing from the PCB, (c) PCB-only components (mechanical/free parts), and (d) schematic components with an EMPTY Unique ID — those can NEVER sync via importChanges and must be fixed first. Pass apply=true to save both documents, run importChanges with the explicit schematic UUID, and re-verify (before vs after). Requires an open project with both a schematic and a PCB.",
      inputSchema: {
        type: "object",
        properties: {
          apply: {
            type: "boolean",
            default: false,
            description: "Actually save both documents, run importChanges(schematicUuid), and re-verify. WARNING: modifies the PCB; importChanges may re-instantiate footprints for changed devices. Default false (diagnose only).",
          },
        },
      },
    },
    buildCode: (args) => {
      const apply = args.apply === true;
      const reconcileSrc = `
      const readNetlist = async () => {
        await eda.dmt_EditorControl.openDocument(schPageUuid);
        await new Promise((r) => setTimeout(r, 1500));
        let raw = null; try { raw = JSON.parse(await eda.sch_Netlist.getNetlist()); } catch (e) {}
        await eda.dmt_EditorControl.openDocument(pcbUuid);
        await new Promise((r) => setTimeout(r, 300));
        return raw;
      };
      const reconcile = async () => {
        const raw = await readNetlist();
        if (!raw) return { error: "Could not read schematic netlist (sch_Netlist.getNetlist returned nothing)." };
        const schByUid = {}; const unsyncable = [];
        for (const [key, c] of Object.entries(raw)) {
          const p = (c && c.props) || {}; const uid = p["Unique ID"] || ""; const des = p["Designator"] || key;
          if (!uid) { unsyncable.push(des); continue; }
          schByUid[uid] = { designator: des, pins: (c && c.pins) || {} };
        }
        const comps = await eda.pcb_PrimitiveComponent.getAll();
        const pcbByUid = {};
        for (const c of comps) {
          const uid = await c.getState_UniqueId(); const des = await c.getState_Designator();
          const pins = {}; const pl = (await c.getAllPins()) || [];
          for (const pad of pl) { const num = pad.getState_PadNumber ? await pad.getState_PadNumber() : null; if (num != null) pins[num] = pad.getState_Net ? await pad.getState_Net() : ""; }
          pcbByUid[uid] = { designator: des, pins };
        }
        const netMismatches = []; const missingOnPcb = [];
        for (const [uid, s] of Object.entries(schByUid)) {
          const pc = pcbByUid[uid];
          if (!pc) { missingOnPcb.push(s.designator); continue; }
          for (const [pin, net] of Object.entries(s.pins)) {
            const pcbNet = pc.pins[pin];
            if (pcbNet === undefined) netMismatches.push({ designator: s.designator, pin, schematic: net, pcb: "<no such pad on PCB>" });
            else if ((pcbNet || "") !== (net || "")) netMismatches.push({ designator: s.designator, pin, schematic: net, pcb: pcbNet });
          }
        }
        const schUids = new Set(Object.keys(schByUid));
        const extraOnPcb = Object.entries(pcbByUid).filter(([uid]) => !schUids.has(uid)).map(([, v]) => v.designator);
        // A designator appearing in BOTH missing and extra means the schematic and PCB
        // copies of that part carry DIFFERENT Unique IDs — importChanges cannot link them,
        // so the part silently fails to update. This is the actionable diagnosis.
        const extraSet = new Set(extraOnPcb);
        const designatorUidMismatch = missingOnPcb.filter((d) => extraSet.has(d));
        const mismatchSet = new Set(designatorUidMismatch);
        return {
          counts: { schematicComponents: Object.keys(schByUid).length, pcbComponents: comps.length, netMismatches: netMismatches.length, missingOnPcb: missingOnPcb.length, extraOnPcb: extraOnPcb.length, designatorUidMismatch: designatorUidMismatch.length, unsyncableInSchematic: unsyncable.length },
          unsyncableInSchematic: unsyncable,
          designatorUidMismatch,
          missingOnPcb: missingOnPcb.filter((d) => !mismatchSet.has(d)),
          extraOnPcb: extraOnPcb.filter((d) => !mismatchSet.has(d)),
          netMismatches: netMismatches.slice(0, 100),
          netMismatchesTruncated: netMismatches.length > 100,
          inSync: netMismatches.length === 0 && missingOnPcb.length === 0 && unsyncable.length === 0 && designatorUidMismatch.length === 0,
        };
      };`;
      return `
      const proj = await eda.dmt_Project.getCurrentProjectInfo();
      if (!proj) return { ok: false, error: "No current project — open a project first." };
      const board = (proj.data || [])[0];
      const schUuid = board && board.schematic && board.schematic.uuid;
      const pages = (board && board.schematic && board.schematic.page) || [];
      const schPageUuid = pages[0] && pages[0].uuid;
      const pcbUuid = board && board.pcb && board.pcb.uuid;
      if (!schPageUuid || !pcbUuid || !schUuid) return { ok: false, error: "Current board needs both a schematic and a PCB." };
      ${reconcileSrc}
      ${apply
        ? `
      const before = await reconcile();
      if (before.error) return { ok: false, error: before.error };
      const saved = {};
      try { saved.schematic = await eda.sch_Document.save(); } catch (e) { saved.schematic = { error: e.message }; }
      try { saved.pcb = await eda.pcb_Document.save(); } catch (e) { saved.pcb = { error: e.message }; }
      await new Promise((r) => setTimeout(r, 3000));
      await eda.dmt_EditorControl.openDocument(pcbUuid);
      let importResult = null, importError = null;
      try { importResult = await eda.pcb_Document.importChanges(schUuid); } catch (e) { importError = e.message; }
      await new Promise((r) => setTimeout(r, 1500));
      const after = await reconcile();
      return {
        ok: true, mode: "apply", saved, importResult, importError,
        before: before.counts, after,
        warning: before.unsyncableInSchematic.length ? ("These schematic components have empty Unique IDs and were NOT synced: " + before.unsyncableInSchematic.join(", ") + ". Fix their Unique ID attributes, then re-run.") : null,
      };`
        : `
      const r = await reconcile();
      if (r.error) return { ok: false, error: r.error };
      return Object.assign({ ok: true, mode: "dryRun" }, r);`}
      `;
    },
  },
];

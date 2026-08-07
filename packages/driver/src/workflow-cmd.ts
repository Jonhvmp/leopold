// `leopold-driver workflow` — compile the brief into a dynamic workflow, and
// optionally run it headlessly through the experimental in-driver runtime.
//
//   leopold-driver workflow            compile + emit .claude/workflows/leopold-run.js
//                                       and .leopold/workflow-args.json (deterministic)
//   leopold-driver workflow --print    print the compiled args JSON to stdout
//   leopold-driver workflow --run      execute it via the experimental runtime (real
//                                       agents, git still locked). Marked experimental.
//
// The compile half is deterministic and unit-tested (compile.ts). The --run half uses
// the experimental runtime (runtime.ts) with a query-backed agent; it is not exercised
// end-to-end in CI, consistent with the SDK driver's alpha posture.

import fs from "node:fs";
import path from "node:path";
import { query } from "./sdk.js";
import { loadBrief } from "./config.js";
import { compileBrief } from "./compile.js";
import { executeWorkflow, type AgentOpts } from "./runtime.js";
import { assetRoot } from "./harness.js";
import { makeGuard } from "./guard.js";
import { logEvent } from "./log.js";
import { notify } from "./notify.js";

const CANONICAL = ["skills", "leopold-workflow", "reference", "leopold-run.workflow.js"];

function findCanonicalScript(): string | null {
  const bundled = path.join(assetRoot(), ...CANONICAL);
  return fs.existsSync(bundled) ? bundled : null;
}

/** A query-backed agent for the runtime. Runs a fresh Claude Code session with the
 *  prompt; git stays locked via the same guard the worker uses. */
function makeRunAgent(leoDir: string, root: string, addTokens: (n: number) => void) {
  const onBlock = (tool: string, reason: string): void => logEvent(leoDir, { event: "guard_block", tool, reason });
  const guard = makeGuard(leoDir, onBlock);
  // The workflow's judging nodes get the same read-only guard the SDK driver gives
  // them: they may read the run and the diff, and may write neither. The label is the
  // seam the compiled script already carries (`node:feedback:i7`), so the two engines
  // enforce the bounds the same way instead of one of them merely asking.
  const readOnlyGuard = makeGuard(leoDir, onBlock, { readOnly: true });
  const READ_ONLY_LABEL = /^node:(feedback|gate|verify):/;
  return async function runAgent(prompt: string, opts: AgentOpts): Promise<unknown> {
    const wantsJson = !!opts.schema;
    const full = wantsJson
      ? `${prompt}\n\nReturn ONLY a single JSON object (no prose, no code fence) matching this shape:\n${JSON.stringify(opts.schema)}`
      : prompt;
    const q = query({
      prompt: full,
      options: {
        cwd: root,
        maxTurns: 30,
        permissionMode: "acceptEdits",
        canUseTool: (READ_ONLY_LABEL.test(opts.label ?? "") ? readOnlyGuard : guard) as never,
        settingSources: ["user", "project"] as never,
        ...(opts.effort ? { effort: opts.effort } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        systemPrompt: { type: "preset", preset: "claude_code" } as never,
      } as never,
    });
    let text = "";
    for await (const msg of q as AsyncIterable<{ type: string; message?: { content?: Array<{ type: string; text?: string }>; usage?: { output_tokens?: number } }; result?: string; usage?: { output_tokens?: number } }>) {
      if (msg.type === "assistant") {
        for (const b of msg.message?.content ?? []) if (b.type === "text" && b.text) text += b.text;
        const ot = msg.message?.usage?.output_tokens;
        if (typeof ot === "number") addTokens(ot);
      } else if (msg.type === "result") {
        if (!text && typeof msg.result === "string") text = msg.result;
      }
    }
    if (!wantsJson) return text;
    const raw = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? text.match(/\{[\s\S]*\}/)?.[0] ?? "";
    try { return JSON.parse(raw); } catch { return {}; }
  };
}

export async function runWorkflowCommand(cwd: string, argv: string[]): Promise<number> {
  let brief;
  try { brief = loadBrief(cwd); }
  catch (e) { console.error(`leopold workflow: ${(e as Error).message}`); return 1; }

  const planText = fs.readFileSync(brief.planPath, "utf8");
  let compiled;
  try {
    compiled = compileBrief({ mission: brief.mission, charter: brief.charter, guardrails: brief.guardrails, planText });
  } catch (e) {
    console.error(`leopold workflow: cannot compile the plan — ${(e as Error).message}`);
    return 1;
  }

  const items = compiled.waves.flat().length;
  const waveDesc = compiled.waves.map((w, i) => `  wave ${i + 1}: ${w.map((it) => it.id).join(", ")}`).join("\n");

  if (argv.includes("--print")) {
    console.log(JSON.stringify(compiled, null, 2));
    return 0;
  }

  const script = findCanonicalScript();
  if (!script) {
    console.error("leopold workflow: canonical workflow script not found (skills/leopold-workflow/reference/leopold-run.workflow.js).");
    return 1;
  }

  if (argv.includes("--run")) {
    console.log(`Leopold workflow (EXPERIMENTAL runtime): ${items} item(s), ${compiled.waves.length} wave(s). Git is locked.\n${waveDesc}\n`);
    logEvent(brief.leoDir, { event: "run_start", mode: "workflow", items, waves: compiled.waves.length });
    let tokens = 0;
    const runAgent = makeRunAgent(brief.leoDir, brief.root, (n) => { tokens += n; });
    try {
      const out = await executeWorkflow(fs.readFileSync(script, "utf8"), {
        args: compiled,
        runAgent,
        onPhase: (t) => { console.log(`— phase: ${t}`); logEvent(brief.leoDir, { event: "wf_phase", title: t }); },
        onLog: (m) => { console.log(`  ${m}`); logEvent(brief.leoDir, { event: "wf_log", msg: m }); },
        tokensSpent: () => tokens,
      });
      logEvent(brief.leoDir, { event: "stop", reason: "plan_complete", mode: "workflow", agents: out.agentCount });
      console.log(`\nWorkflow finished: ${out.agentCount} agents. Everything is staged; nothing was committed.`);
      await notify(brief.leoDir, undefined, "Leopold workflow finished",
        `Ran ${items} item(s) across ${compiled.waves.length} wave(s) via ${out.agentCount} agents. Staged for your review.`);
      return 0;
    } catch (e) {
      console.error(`leopold workflow --run: ${(e as Error).message}`);
      logEvent(brief.leoDir, { event: "stop", reason: "error", mode: "workflow" });
      return 1;
    }
  }

  // Default: emit the compiled workflow for the native runtime (or a later --run).
  const wfDir = path.join(brief.root, ".claude", "workflows");
  fs.mkdirSync(wfDir, { recursive: true });
  fs.copyFileSync(script, path.join(wfDir, "leopold-run.js"));
  fs.writeFileSync(path.join(brief.leoDir, "workflow-args.json"), JSON.stringify(compiled, null, 2));
  console.log(
    `Compiled the brief into a dynamic workflow: ${items} item(s), ${compiled.waves.length} wave(s).\n${waveDesc}\n\n` +
    `  script  .claude/workflows/leopold-run.js\n  args    .leopold/workflow-args.json\n\n` +
    `Run it with the native runtime (in a Claude Code session):\n` +
    `  Workflow({ scriptPath: ".claude/workflows/leopold-run.js", args: <.leopold/workflow-args.json> })\n` +
    `Or headless via the experimental runtime:  leopold-driver workflow --run`,
  );
  return 0;
}

// Root-cause panel for a stuck item.
//
// When the same plan item fails repeatedly, a single context tends to double down
// on its own theory — self-preferential bias. This panel structurally prevents
// that: three INDEPENDENT hypothesis generators, each looking at a DISJOINT slice
// of evidence (the diff itself, the verification output, the item's assumptions
// against the codebase), then a refuter pass over each hypothesis. The strongest
// surviving hypothesis is handed to the next worker attempt as a concrete lead
// instead of "try again".
//
// Everything here is read-only: generators and refuters inspect, they never edit.

import { query } from "./sdk.js";
import type { Brief, DriverConfig } from "./types.js";

export interface Hypothesis {
  /** Which evidence angle produced it. */
  angle: string;
  theory: string;
  evidence: string;
  fix: string;
}

export interface Refutation {
  refuted: boolean;
  confidence: number; // 0-10, refuter's confidence that the theory is RIGHT
  why: string;
}

export interface PanelResult {
  /** The strongest surviving hypothesis, if any survived refutation. */
  survivor?: Hypothesis & { confidence: number };
  considered: number;
  survived: number;
}

// The three disjoint evidence angles. Each generator is told to look ONLY through
// its own angle so the theories are genuinely independent.
const ANGLES: Array<{ key: string; focus: string }> = [
  {
    key: "diff",
    focus:
      "Look ONLY at the change itself: run `git --no-pager diff HEAD` and read the touched files. What in this diff could make the item fail — a wrong edit, a half-wired change, an edit in the wrong place?",
  },
  {
    key: "verify",
    focus:
      "Look ONLY at verification: re-run the cheapest relevant check read-only (build/lint/a single test) or read its last output. What does the actual error say, taken literally, without assuming the previous attempt's interpretation was right?",
  },
  {
    key: "assumptions",
    focus:
      "Question the item's premise against the codebase: is the item pointing at the right file/module? Does the API it assumes still exist (check with Grep)? Is a dependency, config, or environment piece missing? Assume the previous attempts' framing may be wrong.",
  },
];

function generatorSystem(item: string, failureContext: string, focus: string): string {
  return `You are one investigator on a Leopold root-cause panel. A plan item has failed repeatedly and the panel exists because the previous attempts may be stuck on a wrong theory. Form ONE independent hypothesis about the true root cause.

The stuck item:
  ${item}

What the failed attempts reported:
${failureContext || "(no detail recorded)"}

Your evidence angle — stay inside it; other panelists cover the rest:
${focus}

Investigate read-only (Bash for read-only commands, Read, Grep, Glob). Do NOT edit files, commit, or push.

Respond with ONLY a single JSON object, no prose, no code fence, shaped exactly:
{"theory":"the root cause, one or two sentences","evidence":"what you observed that supports it","fix":"the concrete change that would resolve it"}`;
}

function refuterSystem(h: Hypothesis, item: string): string {
  return `You are a skeptic on a Leopold root-cause panel. Your job is to try to REFUTE this hypothesis about why a plan item keeps failing. Default to refuted when the evidence is thin — a wrong lead costs the next attempt more than no lead.

The stuck item:
  ${item}

The hypothesis (from the "${h.angle}" evidence angle):
  THEORY: ${h.theory}
  EVIDENCE: ${h.evidence}
  PROPOSED FIX: ${h.fix}

Check it against the actual repo, read-only (Bash read-only, Read, Grep, Glob). Does the cited evidence hold? Does the theory explain the failure better than a simpler alternative? Would the proposed fix plausibly resolve it? Do NOT edit files.

Respond with ONLY a single JSON object, no prose, no code fence, shaped exactly:
{"refuted": true|false, "confidence": 0-10, "why": "one or two sentences"}
confidence is how confident you are the theory is RIGHT (10 = certain it is the root cause).`;
}

export function parseHypothesis(text: string, angle: string): Hypothesis | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text.match(/\{[\s\S]*\}/)?.[0] ?? "";
  try {
    const o = JSON.parse(raw) as Partial<Hypothesis>;
    if (typeof o.theory !== "string" || !o.theory.trim()) return null;
    return {
      angle,
      theory: o.theory.trim(),
      evidence: String(o.evidence ?? "").trim(),
      fix: String(o.fix ?? "").trim(),
    };
  } catch {
    return null;
  }
}

export function parseRefutation(text: string): Refutation {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text.match(/\{[\s\S]*\}/)?.[0] ?? "";
  try {
    const o = JSON.parse(raw) as Partial<Refutation>;
    const conf = Number(o.confidence);
    return {
      refuted: o.refuted !== false, // absent/ambiguous -> refuted (fail closed)
      confidence: Number.isFinite(conf) ? Math.max(0, Math.min(10, conf)) : 0,
      why: String(o.why ?? "").slice(0, 300),
    };
  } catch {
    return { refuted: true, confidence: 0, why: "unparseable refutation (fail closed)" };
  }
}

/** Format the surviving hypothesis as a concrete lead for the next worker attempt. */
export function formatLead(p: PanelResult): string | undefined {
  const s = p.survivor;
  if (!s) return undefined;
  return (
    `A root-cause panel investigated why this item keeps failing. The surviving hypothesis (confidence ${s.confidence}/10, from the ${s.angle} evidence):\n` +
    `THEORY: ${s.theory}\n` +
    `EVIDENCE: ${s.evidence}\n` +
    `START WITH THIS FIX: ${s.fix}\n` +
    `Verify the theory quickly before committing to it; if it is wrong, say so in your status and take your own path.`
  );
}

async function ask(cfg: DriverConfig, brief: Brief, cwd: string, system: string, prompt: string, maxTurns: number): Promise<string> {
  const q = query({
    prompt,
    options: {
      cwd,
      systemPrompt: system,
      allowedTools: ["Bash", "Read", "Grep", "Glob"],
      disallowedTools: ["Edit", "Write", "MultiEdit", "NotebookEdit"],
      settingSources: ["user", "project"],
      permissionMode: "default",
      maxTurns,
      effort: "medium",
      ...(cfg.conductorModel ? { model: cfg.conductorModel } : {}),
    } as never,
  });
  let text = "";
  for await (const msg of q as AsyncIterable<{ type: string; message?: { content?: Array<{ type: string; text?: string }> }; result?: string }>) {
    if (msg.type === "assistant") {
      for (const b of msg.message?.content ?? []) if (b.type === "text" && b.text) text += b.text;
    } else if (msg.type === "result") {
      if (!text && typeof msg.result === "string") text = msg.result;
    }
  }
  return text;
}

/** Run the panel: 3 disjoint-evidence generators in parallel, then one refuter per
 *  surviving-shaped hypothesis. Returns the strongest survivor (highest refuter
 *  confidence). Cheap by construction: 3 + up to 3 short read-only sessions. */
export async function rootCausePanel(
  cfg: DriverConfig,
  brief: Brief,
  item: string,
  cwd: string,
  failureContext: string,
): Promise<PanelResult> {
  const generated = await Promise.all(
    ANGLES.map(async (a) => {
      const text = await ask(cfg, brief, cwd, generatorSystem(item, failureContext, a.focus), "Investigate now and return the JSON hypothesis.", 6);
      return parseHypothesis(text, a.key);
    }),
  );
  const hypotheses = generated.filter((h): h is Hypothesis => h !== null);
  if (hypotheses.length === 0) return { considered: 0, survived: 0 };

  const judged = await Promise.all(
    hypotheses.map(async (h) => {
      const text = await ask(cfg, brief, cwd, refuterSystem(h, item), "Check the hypothesis now and return the JSON verdict.", 6);
      return { h, r: parseRefutation(text) };
    }),
  );

  const survivors = judged.filter((j) => !j.r.refuted);
  if (survivors.length === 0) return { considered: hypotheses.length, survived: 0 };
  survivors.sort((a, b) => b.r.confidence - a.r.confidence);
  const best = survivors[0];
  return {
    survivor: { ...best.h, confidence: best.r.confidence },
    considered: hypotheses.length,
    survived: survivors.length,
  };
}

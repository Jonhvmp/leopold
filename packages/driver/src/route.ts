// Optional smart routing: an LLM classifier that RESEARCHES the item before
// setting effort/criticality, instead of keyword-matching its text.
//
// classify.ts stays the default — deterministic, free, unit-testable. But keywords
// only see the item's WORDING: "explain how the auth module works" is critical by
// keyword, trivial in practice; "update the retry helper" is medium by keyword,
// dangerous if half the codebase calls it. With --smart-routing, a short read-only
// session peeks at the repo (which files, how many callers, what the blast radius
// really is) and returns the same ItemClass shape. Any failure — no verdict,
// unparseable JSON, thrown error — falls back to the deterministic classifier, so
// smart routing can only ever refine the signal, never lose it.

import { query } from "./sdk.js";
import { classifyItem, type ItemClass, type Effort } from "./classify.js";
import type { Brief, DriverConfig } from "./types.js";

const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

function routeSystem(charter: string): string {
  return `You are Leopold's routing classifier. Given one plan item, decide how much reasoning effort the worker needs and whether the item is critical (deserving an extra independent review). Research the ACTUAL blast radius in this repo before answering — do not judge by wording alone.

How to research (2-3 quick probes, read-only: Bash read-only, Read, Grep, Glob):
- Which files/modules would this item touch? How many callers/references do they have (Grep)?
- Does it touch money, identity, data integrity, schema/migrations, deploy/infra, or secrets? Those are critical.
- Is it genuinely cosmetic (docs, rename, formatting) regardless of dramatic wording? Those are low.

Calibration:
- "low" = cosmetic / tiny blast radius. "medium" = ordinary change. "high" = wide blast radius or project flagged high-risk. "max" = sharp edges: schema/migrations, payments, crypto, auth internals, irreversible operations.
- critical=true buys a second+third independent reviewer — reserve it for money/identity/data-integrity/irreversibility, not for merely large changes.

The project charter (may raise the floor):
${charter.slice(0, 2000)}

Respond with ONLY a single JSON object, no prose, no code fence, shaped exactly:
{"effort":"low|medium|high|xhigh|max","critical":true|false,"reason":"one line: what you found","files":["relative/path/a.ts","relative/path/b.ts"]}
"files" = the specific files this item would touch, from your research (relative paths, best effort; [] if you truly cannot tell). It scopes the worker's context to the slice that matters.`;
}

export function parseRoute(text: string): ItemClass | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text.match(/\{[\s\S]*\}/)?.[0] ?? "";
  try {
    const o = JSON.parse(raw) as { effort?: unknown; critical?: unknown; reason?: unknown; files?: unknown };
    if (!EFFORTS.includes(o.effort as Effort)) return null;
    const files = Array.isArray(o.files)
      ? o.files.filter((f): f is string => typeof f === "string" && f.trim().length > 0).map((f) => f.trim()).slice(0, 40)
      : [];
    return {
      effort: o.effort as Effort,
      critical: o.critical === true,
      reason: `smart-route: ${String(o.reason ?? "").slice(0, 200)}`,
      files,
    };
  } catch {
    return null;
  }
}

/** Classify an item by researching the repo. Falls back to the deterministic
 *  keyword classifier on ANY failure — smart routing never loses the signal. */
export async function smartRoute(
  cfg: DriverConfig,
  brief: Brief,
  item: string,
  cwd: string,
): Promise<ItemClass> {
  const fallback = classifyItem(item, brief.charter);
  try {
    const q = query({
      prompt: `Classify this plan item now and return the JSON verdict:\n\n  ${item}`,
      options: {
        cwd,
        systemPrompt: routeSystem(brief.charter),
        allowedTools: ["Bash", "Read", "Grep", "Glob"],
        disallowedTools: ["Edit", "Write", "MultiEdit", "NotebookEdit"],
        settingSources: ["user", "project"],
        permissionMode: "default",
        maxTurns: 4,
        effort: "low",
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
    const routed = parseRoute(text);
    if (!routed) return fallback;
    // Safety floor: the router may raise the deterministic signal, never lower a
    // keyword-critical item below critical. Money/auth/migrations stay guarded even
    // if the router was too relaxed.
    if (fallback.critical && !routed.critical) {
      return { ...routed, critical: true, reason: `${routed.reason} (kept critical: keyword floor)` };
    }
    return routed;
  } catch {
    return fallback;
  }
}

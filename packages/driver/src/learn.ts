// Close the loop: on a clean finish, mine the run that just happened for recurring
// judgment calls and propose charter amendments.
//
// This is the SDK-side sibling of the /leopold-learn workflow. The workflow mines
// three disjoint sources (decisions, session transcripts, git history) with a
// background fan-out; the driver has two of those on hand the moment a run ends — the
// DECISIONS.md it just wrote and the repo's git history — and no access to the
// interactive session transcript. So it runs a lean version: two one-shot miners, a
// cluster pass, one kill-biased skeptic per candidate, then the DRIVER writes the
// proposal file itself (it has fs access; no agent needed for the write).
//
// It NEVER edits CHARTER.md — the charter is the user's identity. Output is a
// proposal at .leopold/CHARTER-amendments.md the human reviews and folds in.

import fs from "node:fs";
import path from "node:path";
import { query } from "./sdk.js";
import { git } from "./git.js";
import type { Brief, DriverConfig } from "./types.js";

export interface Candidate { rule: string; evidence: string; }
export interface Survivor { rule: string; evidence: string; why: string; }

/** True when DECISIONS.md holds no real entries (just the header) — nothing to mine. */
export function decisionsAreEmpty(text: string): boolean {
  const body = text.replace(/^#.*$/gm, "").replace(/autonomous decisions[^\n]*/i, "").trim();
  return body.length < 20;
}

export function parseCandidates(text: string): Candidate[] {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text.match(/\{[\s\S]*\}/)?.[0] ?? "";
  try {
    const o = JSON.parse(raw) as { candidates?: unknown };
    if (!Array.isArray(o.candidates)) return [];
    return o.candidates
      .filter((c): c is Candidate => !!c && typeof (c as Candidate).rule === "string" && !!(c as Candidate).rule.trim())
      .map((c) => ({ rule: c.rule.trim(), evidence: String(c.evidence ?? "").trim() }));
  } catch {
    return [];
  }
}

export function parseSkeptic(text: string): { keep: boolean; refined?: string; why: string } {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text.match(/\{[\s\S]*\}/)?.[0] ?? "";
  try {
    const o = JSON.parse(raw) as { keep?: unknown; refined?: unknown; why?: unknown };
    return { keep: o.keep === true, refined: typeof o.refined === "string" ? o.refined.trim() : undefined, why: String(o.why ?? "").slice(0, 300) };
  } catch {
    // Unparseable skeptic → do NOT keep (a wrong rule misroutes every future decision).
    return { keep: false, why: "unparseable skeptic verdict (kept out)" };
  }
}

/** Render the proposal file. Pure, so it is unit-tested. */
export function formatAmendments(survivors: Survivor[]): string {
  const head =
    "# Charter amendments (proposed by leopold learn-on-finish)\n\n" +
    "> Each rule below was mined from the run that just finished — its decision log and\n" +
    "> the repo's git history — and verified by a skeptic. None of these is in the charter\n" +
    "> yet. Review and fold the ones that sound like you into .leopold/CHARTER.md; delete\n" +
    "> the rest. This file is safe to delete.\n\n";
  const body = survivors
    .map((s) => `## ${s.rule}\n- **Evidence:** ${s.evidence || "(from the run's decisions / history)"}\n- **Why it survived review:** ${s.why || "(recurring pattern)"}\n`)
    .join("\n");
  return head + body;
}

async function oneShot(cfg: DriverConfig, system: string, user: string): Promise<string> {
  const q = query({
    prompt: user,
    options: {
      ...(cfg.conductorModel ? { model: cfg.conductorModel } : {}),
      systemPrompt: system,
      allowedTools: [],
      settingSources: [],
      maxTurns: 1,
      permissionMode: "default",
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

/** Gather the DECISIONS log for this run plus any archived runs' logs. */
function gatherDecisions(leoDir: string): string {
  const parts: string[] = [];
  const main = path.join(leoDir, "DECISIONS.md");
  if (fs.existsSync(main)) parts.push(fs.readFileSync(main, "utf8"));
  const runsDir = path.join(leoDir, "runs");
  if (fs.existsSync(runsDir)) {
    for (const d of fs.readdirSync(runsDir)) {
      const p = path.join(runsDir, d, "DECISIONS.md");
      if (fs.existsSync(p)) parts.push(fs.readFileSync(p, "utf8"));
    }
  }
  return parts.join("\n\n---\n\n");
}

const CHARTER_NOTE = (charter: string) =>
  `The CURRENT charter is below — do NOT propose anything it already covers; only rules the behavior shows are MISSING or repeatedly re-decided from generic principles:\n---\n${charter.slice(0, 3000)}\n---`;

const MINER_SYS =
  'You mine a Leopold run for recurring judgment patterns worth promoting into the charter (the doc an autonomous run uses to decide like the user). Return ONLY a JSON object: {"candidates":[{"rule":"the rule, phrased concretely and testably as the user would write it","evidence":"the specific decisions/commits showing the pattern, with counts"}]}. Prefer patterns seen 2+ times; skip one-offs. Up to 6 candidates.';

const CLUSTER_SYS =
  'Cluster candidate charter rules mined from different sources. Merge duplicates (keep the sharpest phrasing, concatenate evidence, and note cross-source repeats — the strongest signal). Drop vague or one-off ones. Return ONLY {"candidates":[{"rule":"...","evidence":"..."}]}, strongest first.';

const SKEPTIC_SYS =
  'You judge whether a mined rule belongs in a project charter. Default to keep=false; a wrong rule misroutes every future decision. Kill it if the charter already covers it, the evidence is a one-off, it is too vague to resolve a real fork, or it encodes a temporary circumstance. If it survives, refine it to the most concrete, testable phrasing. Return ONLY {"keep":true|false,"refined":"...","why":"..."}.';

export interface LearnResult { proposed: number; outPath: string | null; rules: string[]; }

/** Mine the just-finished run into proposed charter amendments. Best-effort:
 *  any failure returns a zero result rather than disrupting the finish. */
export async function learnFromRun(cfg: DriverConfig, brief: Brief): Promise<LearnResult> {
  const empty: LearnResult = { proposed: 0, outPath: null, rules: [] };
  try {
    const decisions = gatherDecisions(brief.leoDir);
    const root = brief.worktreeRoot ?? brief.root;
    const logRes = git(root, ["log", "--oneline", "-80"]);
    const gitLog = logRes.ok ? logRes.out : "";

    // Nothing to mine if the run logged no decisions and there is no history.
    if (decisionsAreEmpty(decisions) && gitLog.trim().length === 0) return empty;

    const note = CHARTER_NOTE(brief.charter);
    const [decCand, gitCand] = await Promise.all([
      decisionsAreEmpty(decisions)
        ? Promise.resolve<Candidate[]>([])
        : oneShot(cfg, MINER_SYS, `Mine this autonomous decision log.\n${note}\n\nDECISIONS:\n${decisions.slice(0, 8000)}`).then(parseCandidates),
      gitLog.trim()
        ? oneShot(cfg, MINER_SYS, `Mine this git history for norms the commits imply (revert/fixup chains, "stop doing X" messages, repeated churn).\n${note}\n\nGIT LOG:\n${gitLog.slice(0, 6000)}`).then(parseCandidates)
        : Promise.resolve<Candidate[]>([]),
    ]);

    const mined = [...decCand, ...gitCand];
    if (mined.length === 0) return empty;

    const clustered = parseCandidates(await oneShot(cfg, CLUSTER_SYS, `Cluster these candidates:\n${JSON.stringify(mined, null, 2)}`)).slice(0, 12);
    if (clustered.length === 0) return empty;

    const verdicts = await Promise.all(
      clustered.map((c) =>
        oneShot(cfg, SKEPTIC_SYS, `${CHARTER_NOTE(brief.charter)}\n\nCandidate rule: ${c.rule}\nEvidence: ${c.evidence}`).then(parseSkeptic).then((v) => ({ c, v })),
      ),
    );
    const survivors: Survivor[] = verdicts
      .filter(({ v }) => v.keep)
      .map(({ c, v }) => ({ rule: (v.refined || c.rule).trim(), evidence: c.evidence, why: v.why }));
    if (survivors.length === 0) return empty;

    const outPath = path.join(brief.leoDir, "CHARTER-amendments.md");
    fs.writeFileSync(outPath, formatAmendments(survivors));
    return { proposed: survivors.length, outPath, rules: survivors.map((s) => s.rule) };
  } catch {
    return empty;
  }
}

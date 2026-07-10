// The steer command channel: how the Canvas (or any tool) nudges a live
// `/leopold-run` between turns. The dashboard appends one JSON object per line to
// `.leopold/commands.jsonl`; the loop drains it at the SAME turn boundary it checks
// `.leopold/STOP`, applies each command, logs it, and clears the file.
//
// SECURITY INVARIANT (proven by the red-team suite): a command can only steer the
// plan — log a note, prepend guidance to the next item, or flip a PLAN.md checkbox.
// It can NEVER unlock git: this module never writes ALLOW_GIT / ALLOW_PUSH, never
// touches STOP, and never shells out. The command kind is whitelisted, so an unknown
// or hostile `cmd` (e.g. {"cmd":"allow_git"}) is dropped, not executed.

import fs from "node:fs";
import path from "node:path";
import { logEvent } from "./log.js";
import { parsePlanFile, setItemDone, setItemOpen } from "./plan.js";
import type { Brief } from "./types.js";

export type CommandKind = "approve" | "redirect" | "inject" | "kill-item" | "rerun-item";
const KINDS: readonly CommandKind[] = ["approve", "redirect", "inject", "kill-item", "rerun-item"];

export interface Command {
  cmd: CommandKind;
  /** Target a plan item by 1-based position (preferred) … */
  index?: number;
  /** … or by a text prefix of the item. */
  item?: string;
  /** Free-text steering note (redirect / inject). */
  text?: string;
}

/** Parse the commands file body. PURE and defensive: one JSON object per line,
 *  malformed lines skipped, only whitelisted `cmd` kinds kept, and only the known
 *  fields carried through — every other field (and every unknown command) is dropped. */
export function parseCommands(text: string): Command[] {
  const out: Command[] = [];
  for (const line of (text || "").split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let o: unknown;
    try { o = JSON.parse(s); } catch { continue; }
    if (!o || typeof o !== "object") continue;
    const rec = o as Record<string, unknown>;
    const cmd = rec.cmd;
    if (typeof cmd !== "string" || !KINDS.includes(cmd as CommandKind)) continue; // whitelist
    const c: Command = { cmd: cmd as CommandKind };
    if (typeof rec.index === "number" && Number.isFinite(rec.index) && rec.index >= 1) c.index = Math.floor(rec.index);
    if (typeof rec.item === "string") c.item = rec.item.slice(0, 300);
    if (typeof rec.text === "string") c.text = rec.text.slice(0, 2000);
    out.push(c);
  }
  return out;
}

function commandsPath(leoDir: string): string {
  return path.join(leoDir, "commands.jsonl");
}

/** Read + parse the pending commands (empty if the file is absent). */
export function readCommands(leoDir: string): Command[] {
  const p = commandsPath(leoDir);
  if (!fs.existsSync(p)) return [];
  try { return parseCommands(fs.readFileSync(p, "utf8")); } catch { return []; }
}

/** Consume the queue — truncate the file so each command is applied exactly once. */
export function clearCommands(leoDir: string): void {
  try { fs.rmSync(commandsPath(leoDir), { force: true }); } catch { /* ignore */ }
}

/** Append a manual steer decision to DECISIONS.md (audit trail, same file the
 *  conductor's own decisions land in). */
function logSteer(leoDir: string, title: string, detail: string): void {
  const block =
    `\n## Canvas steer — ${title}   (${new Date().toISOString()})\n` +
    `Fork:        steered from the canvas (command channel)\n` +
    `Class:       reversible\n` +
    `Decision:    ${detail}\n`;
  try { fs.appendFileSync(path.join(leoDir, "DECISIONS.md"), block); } catch { /* ignore */ }
}

/** Resolve a command's target to a 1-based plan index, or null. Prefers `index`;
 *  falls back to a text prefix match against the plan. */
function resolveIndex(planPath: string, c: Command): number | null {
  const items = parsePlanFile(planPath);
  if (c.index != null) return c.index >= 1 && c.index <= items.length ? c.index : null;
  if (c.item) {
    const key = c.item.trim().toLowerCase().slice(0, 60);
    const hit = items.find((it) => it.text.toLowerCase().startsWith(key) || key.startsWith(it.text.toLowerCase().slice(0, 40)));
    return hit ? hit.index : null;
  }
  return null;
}

/** Drain and apply all pending steer commands at a turn boundary. Logs each to
 *  events.jsonl + DECISIONS.md, mutates PLAN.md for kill/rerun, and returns any
 *  redirect/inject guidance to prepend to the NEXT item's worker prompt. Git stays
 *  locked — this only ever writes logs and PLAN.md checkboxes. */
export function drainCommands(brief: Brief): string | undefined {
  const cmds = readCommands(brief.leoDir);
  if (!cmds.length) return undefined;
  clearCommands(brief.leoDir); // consume exactly once
  const steer: string[] = [];
  for (const c of cmds) {
    logEvent(brief.leoDir, { event: "command", cmd: c.cmd, index: c.index ?? null, item: c.item ?? null });
    switch (c.cmd) {
      case "approve":
        logSteer(brief.leoDir, "approve", "acknowledged; the run continues.");
        break;
      case "redirect":
      case "inject":
        if (c.text) {
          steer.push(`[Steering from the canvas — ${c.cmd}]: ${c.text}`);
          logSteer(brief.leoDir, c.cmd, c.text.slice(0, 300));
        }
        break;
      case "kill-item": {
        const idx = resolveIndex(brief.planPath, c);
        if (idx != null) {
          setItemDone(brief.planPath, idx);
          logSteer(brief.leoDir, "kill-item", `item ${idx} closed via the canvas (skipped for this run).`);
        }
        break;
      }
      case "rerun-item": {
        const idx = resolveIndex(brief.planPath, c);
        if (idx != null) {
          setItemOpen(brief.planPath, idx);
          logSteer(brief.leoDir, "rerun-item", `item ${idx} re-opened via the canvas (the loop will redo it).`);
        }
        break;
      }
    }
  }
  return steer.length ? steer.join("\n") : undefined;
}

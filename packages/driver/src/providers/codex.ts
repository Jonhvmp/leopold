// Codex backend for the driver's single model seam (sdk.ts).
//
// Everything in the driver — worker turns, conductor decisions, review lenses,
// hypotheses, routing, tournament judges — consumes the same tiny message shape:
// `{type:"assistant", message:{content:[{type:"text",…}]}}` per turn and one
// `{type:"result", …}` when the session ends. This module produces exactly that
// shape from `codex exec --json`, so not a single call site has to know which
// harness is running.
//
// Why the CLI and not @openai/codex-sdk: the SDK cannot pass process-level flags,
// and the two Leopold needs — `--dangerously-bypass-hook-trust` (so the git-lock
// hook actually fires in a headless run) and `--sandbox` — are process-level. The
// CLI also keeps the driver dependency-free; `codex` is already on PATH if you use it.
//
// Multi-turn: `codex exec` starts a thread and prints its id; every later turn is
// `codex exec resume <thread_id>`. That is the Codex equivalent of the Agent SDK's
// streaming-input mode, and it preserves the same property Leopold cares about —
// the worker keeps its context inside an item, and gets a fresh one per item.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { assetRoot } from "../harness.js";

/** The subset of the Agent SDK message stream the driver actually reads. */
export interface SdkMessage {
  type: "assistant" | "result" | "system";
  message?: { content?: Array<{ type: string; text?: string }> };
  result?: string;
  total_cost_usd?: number;
  is_error?: boolean;
  subtype?: string;
}

interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

interface CodexEvent {
  type: string;
  thread_id?: string;
  usage?: CodexUsage;
  message?: string;
  error?: { message?: string };
  item?: { id?: string; type?: string; text?: string; message?: string };
}

/** USD per 1M tokens, matched by model-name prefix (longest match wins).
 *  Codex reports token usage, never a dollar figure, so --budget-usd needs this.
 *  Unknown models fall back to FALLBACK_PRICE rather than 0 — pricing a run at
 *  zero would silently disable the budget, which is the one failure we cannot have. */
const PRICES: Array<[prefix: string, inPerM: number, outPerM: number]> = [
  ["gpt-5.6", 1.25, 10],
  ["gpt-5.5", 1.25, 10],
  ["gpt-5.4", 1.25, 10],
  ["gpt-5.3", 1.25, 10],
  ["gpt-5.2", 1.25, 10],
  ["gpt-5.1", 1.25, 10],
  ["gpt-5", 1.25, 10],
  ["o4", 1.1, 4.4],
  ["o3", 2, 8],
];
const FALLBACK_PRICE: [number, number] = [1.25, 10];

export function priceFor(model: string): [inPerM: number, outPerM: number] {
  const m = model.toLowerCase();
  let best: [string, number, number] | undefined;
  for (const p of PRICES) {
    if (m.startsWith(p[0]) && (!best || p[0].length > best[0].length)) best = p;
  }
  return best ? [best[1], best[2]] : FALLBACK_PRICE;
}

/** Convert a Codex turn's token usage into USD. Cached input is billed at 10% —
 *  the standard prompt-cache read rate — so long items are not over-charged. */
export function usageToUsd(usage: CodexUsage | undefined, model: string): number {
  if (!usage) return 0;
  const [inPerM, outPerM] = priceFor(model);
  const cached = usage.cached_input_tokens ?? 0;
  const fresh = Math.max(0, (usage.input_tokens ?? 0) - cached);
  const out = usage.output_tokens ?? 0;
  return (fresh * inPerM + cached * inPerM * 0.1 + out * outPerM) / 1_000_000;
}

/** Codex reasoning efforts. Claude's `effort` values map 1:1 except "max". */
const EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh"]);
export function mapEffort(effort: unknown): string | undefined {
  if (typeof effort !== "string") return undefined;
  const e = effort.toLowerCase();
  if (EFFORTS.has(e)) return e;
  if (e === "max") return "xhigh"; // Claude's top tier -> Codex's top tier
  return undefined;
}

const EDIT_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit", "Update", "Patch"];

/** Read-only sessions (review lenses, hypotheses, routers, judges) are expressed in
 *  the Agent SDK by disallowing the edit tools. Codex has no per-tool allowlist, but
 *  its read-only sandbox is a strictly stronger guarantee, so that is the mapping. */
export function isReadOnly(options: Record<string, unknown>): boolean {
  const disallowed = options.disallowedTools;
  if (Array.isArray(disallowed) && EDIT_TOOLS.some((t) => disallowed.includes(t))) return true;
  const allowed = options.allowedTools;
  if (Array.isArray(allowed) && !allowed.some((t) => EDIT_TOOLS.includes(String(t)))) return true;
  return false;
}

/** Flatten the Agent SDK's systemPrompt shapes into a preamble Codex can read.
 *  A `{preset:"claude_code"}` preset has no Codex counterpart — Codex brings its own
 *  base prompt — so only the `append` half (Leopold's actual instructions) carries over. */
export function systemPreamble(systemPrompt: unknown): string {
  if (typeof systemPrompt === "string") return systemPrompt;
  if (systemPrompt && typeof systemPrompt === "object") {
    const sp = systemPrompt as { append?: unknown; text?: unknown };
    if (typeof sp.append === "string") return sp.append;
    if (typeof sp.text === "string") return sp.text;
  }
  return "";
}

/** Path to the shipped PreToolUse guard (the git lock), if the harness assets are
 *  present. Returns undefined when running from a build without vendored assets. */
export function guardScript(): string | undefined {
  const p = join(assetRoot(), "hooks", "guard-irreversible.sh");
  return existsSync(p) ? p : undefined;
}

export interface CodexArgvOpts {
  cwd?: string;
  model?: string;
  effort?: string;
  readOnly: boolean;
  /** Wire Leopold's git-lock hook into this session. */
  guard?: string;
  resumeId?: string;
}

/** Build the `codex exec` argv. Kept pure so the mapping is unit-testable without
 *  spawning anything. */
export function buildArgv(o: CodexArgvOpts): string[] {
  const args = ["exec"];
  if (o.resumeId) args.push("resume", o.resumeId);
  args.push("--json", "--skip-git-repo-check");
  args.push("--sandbox", o.readOnly ? "read-only" : "workspace-write");
  if (o.cwd) args.push("-C", o.cwd);
  if (o.model) args.push("-m", o.model);
  const effort = mapEffort(o.effort);
  if (effort) args.push("-c", `model_reasoning_effort="${effort}"`);
  if (o.guard) {
    // Codex's PreToolUse payload and deny reply are Claude Code's, so the very same
    // guard script enforces the lock on both harnesses. Config-file hooks are inert
    // until trusted; a headless run has nobody to click "trust", hence the bypass.
    args.push("-c", `hooks.PreToolUse=[{matcher="Bash",hooks=[{type="command",command=${JSON.stringify(o.guard)}}]}]`);
    args.push("--dangerously-bypass-hook-trust");
  }
  return args;
}

/** Pull user text out of whatever the caller passed as `prompt`: a plain string, or
 *  the driver's InputChannel (an async iterable of SDK user messages). */
async function* inputs(prompt: unknown): AsyncGenerator<string> {
  if (typeof prompt === "string") { yield prompt; return; }
  if (prompt && typeof (prompt as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
    for await (const m of prompt as AsyncIterable<{ message?: { content?: Array<{ text?: string }> } }>) {
      const text = (m.message?.content ?? []).map((c) => c.text ?? "").join("");
      if (text) yield text;
    }
  }
}

interface TurnResult { text: string; threadId?: string; usd: number; error?: string }

/** Run one `codex exec` (or `resume`) turn to completion, collecting the agent's
 *  text and this turn's cost. */
function runTurn(argv: string[], input: string, env: NodeJS.ProcessEnv, model: string): Promise<TurnResult> {
  return new Promise((resolve) => {
    const child = spawn("codex", [...argv, "-"], { env, stdio: ["pipe", "pipe", "pipe"] });
    const out: TurnResult = { text: "", usd: 0 };
    let buf = "";
    let stderr = "";

    const handle = (line: string) => {
      if (!line.trim()) return;
      let ev: CodexEvent;
      try { ev = JSON.parse(line) as CodexEvent; } catch { return; } // non-JSON noise
      if (ev.type === "thread.started" && ev.thread_id) out.threadId = ev.thread_id;
      else if (ev.type === "item.completed" && ev.item?.type === "agent_message" && ev.item.text) {
        out.text += (out.text ? "\n" : "") + ev.item.text;
      } else if (ev.type === "turn.completed") out.usd += usageToUsd(ev.usage, model);
      else if (ev.type === "turn.failed") out.error = ev.error?.message ?? "turn failed";
      else if (ev.type === "error") out.error = ev.message ?? "codex error";
    };

    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines) handle(l);
    });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", (e) => { out.error = `could not run codex: ${e.message}`; resolve(out); });
    child.on("close", (code) => {
      if (buf) handle(buf);
      if (code !== 0 && !out.error) out.error = stderr.trim().slice(-500) || `codex exited ${code}`;
      resolve(out);
    });

    child.stdin.write(input);
    child.stdin.end();
  });
}

export interface QueryArgs { prompt: unknown; options?: Record<string, unknown> }

/**
 * Drive Codex through the driver's message contract.
 *
 * Emits one `assistant` message per Codex turn and a single `result` when the input
 * ends — the same rhythm the Agent SDK uses, which is what lets worker.ts's
 * conductor loop run unmodified on either harness.
 */
export function codexQuery(args: QueryArgs): AsyncIterable<SdkMessage> {
  const options = (args.options ?? {}) as Record<string, unknown>;
  const model = typeof options.model === "string" ? options.model : "";
  const env = (options.env as NodeJS.ProcessEnv | undefined) ?? process.env;
  const preamble = systemPreamble(options.systemPrompt);
  const readOnly = isReadOnly(options);
  // canUseTool is the Agent SDK's in-process guard; Codex has no such callback, so
  // its presence is the signal to enforce the same policy through the hook instead.
  const guard = options.canUseTool && !readOnly ? guardScript() : undefined;

  return (async function* (): AsyncGenerator<SdkMessage> {
    let threadId: string | undefined;
    let usd = 0;
    let first = true;
    let failure: string | undefined;

    for await (const text of inputs(args.prompt)) {
      const input = first && preamble ? `${preamble}\n\n---\n\n${text}` : text;
      first = false;
      const argv = buildArgv({
        cwd: typeof options.cwd === "string" ? options.cwd : undefined,
        model: model || undefined,
        effort: options.effort as string | undefined,
        readOnly,
        guard,
        resumeId: threadId,
      });
      const turn = await runTurn(argv, input, env, model || "gpt-5");
      usd += turn.usd;
      if (turn.threadId) threadId = turn.threadId;
      if (turn.error) { failure = turn.error; break; }
      if (turn.text) {
        yield { type: "assistant", message: { content: [{ type: "text", text: turn.text }] } };
      }
    }

    yield {
      type: "result",
      ...(failure ? { subtype: "error", is_error: true, result: failure } : {}),
      total_cost_usd: usd,
    };
  })();
}

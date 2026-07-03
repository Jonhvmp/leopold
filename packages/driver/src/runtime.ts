// Experimental in-driver dynamic-workflow runtime.
//
// The native runtime executes a workflow script inside Claude Code; this is a lean,
// SDK-side executor for the same script shape, so `leopold-driver workflow --run` can
// drive a compiled brief headlessly (CI, cron) without an interactive session. It
// implements the workflow globals — agent / pipeline / parallel / phase / log / args /
// budget — with a real concurrency cap, and delegates the one thing it can't fake, the
// actual agent call, to an injected `runAgent`. That injection is what makes the
// ORCHESTRATION unit-testable (mock runAgent) while the SDK call stays a thin shim.
//
// Status: EXPERIMENTAL, consistent with the SDK driver's alpha posture. The
// orchestration engine is unit-tested; the query-backed runAgent is not exercised
// end-to-end here. The canonical leopold-run.workflow.js runs a wave's items serially
// (only its read-only verify fan-out is parallel), so a single working tree is safe.

const AsyncFunction = Object.getPrototypeOf(async function () { /* ctor */ }).constructor as
  new (...args: string[]) => (...a: unknown[]) => Promise<unknown>;

export interface AgentOpts {
  label?: string;
  phase?: string;
  schema?: unknown;
  model?: string;
  effort?: string;
  isolation?: "worktree";
}

export interface RuntimeCtx {
  args: unknown;
  /** The real agent call (query-backed in production, a mock in tests). */
  runAgent: (prompt: string, opts: AgentOpts) => Promise<unknown>;
  /** Max concurrent agent calls. Default min(16, cpus-2). */
  concurrency?: number;
  onPhase?: (title: string) => void;
  onLog?: (msg: string) => void;
  /** Token ceiling; when set and exceeded, further agent() calls throw. */
  budgetTokens?: number | null;
  /** Output tokens spent so far (the caller tracks real usage). */
  tokensSpent?: () => number;
  /** Hard cap on total agent() calls in a run (runaway-loop backstop). */
  maxAgents?: number;
}

/** A minimal counting semaphore: at most `n` holders run concurrently. */
function semaphore(n: number) {
  let active = 0;
  const waiters: Array<() => void> = [];
  const release = () => { active -= 1; const w = waiters.shift(); if (w) w(); };
  return async function acquire<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= n) await new Promise<void>((res) => waiters.push(res));
    active += 1;
    try { return await fn(); } finally { release(); }
  };
}

export interface RunResult { meta: Record<string, unknown>; result: unknown; agentCount: number; }

/** Execute a workflow script against real agents (via ctx.runAgent). */
export async function executeWorkflow(scriptText: string, ctx: RuntimeCtx): Promise<RunResult> {
  const limit = Math.max(1, ctx.concurrency ?? 8);
  const gate = semaphore(limit);
  const maxAgents = ctx.maxAgents ?? 1000;
  let agentCount = 0;

  const transformed = scriptText.replace(/export\s+const\s+meta\s*=/, "__ctx.meta =");

  const agent = async (prompt: string, opts: AgentOpts = {}) => {
    if (agentCount >= maxAgents) throw new Error(`workflow exceeded the ${maxAgents}-agent cap`);
    if (ctx.budgetTokens && ctx.tokensSpent && ctx.tokensSpent() >= ctx.budgetTokens) {
      throw new Error(`workflow hit its ${ctx.budgetTokens}-token budget`);
    }
    agentCount += 1;
    return gate(() => ctx.runAgent(prompt, opts));
  };

  const pipeline = async (items: unknown[], ...stages: Array<(prev: unknown, item: unknown, i: number) => unknown>) => {
    // Each item threads through every stage independently; no barrier between stages.
    return Promise.all(items.map(async (item, i) => {
      let v: unknown = item;
      try { for (const stage of stages) v = await stage(v, item, i); return v; }
      catch { return null; }
    }));
  };

  const parallel = async (thunks: Array<() => unknown>) =>
    Promise.all(thunks.map(async (t) => { try { return await t(); } catch { return null; } }));

  const phase = (title: string) => { ctx.onPhase?.(title); };
  const log = (msg: string) => { ctx.onLog?.(String(msg)); };
  const budget = {
    total: ctx.budgetTokens ?? null,
    spent: () => (ctx.tokensSpent ? ctx.tokensSpent() : 0),
    remaining: () => (ctx.budgetTokens && ctx.tokensSpent ? Math.max(0, ctx.budgetTokens - ctx.tokensSpent()) : Infinity),
  };
  const holder: { meta: Record<string, unknown> } = { meta: {} };

  const fn = new AsyncFunction("agent", "pipeline", "parallel", "phase", "log", "args", "budget", "__ctx", transformed);
  const result = await fn(agent, pipeline, parallel, phase, log, ctx.args, budget, holder);
  return { meta: holder.meta, result, agentCount };
}

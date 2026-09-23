// The HTTP behaviour every network provider shares: which statuses are retryable, how long to
// wait, and — the one that bit — draining a failed response before trying again.
//
// It lives here rather than in each provider because the drain is a correctness property, not a
// style choice: a copy of this loop that forgets it leaks a connection per retry, and the
// end-to-end tests do not catch that (see DECISIONS, turn 4). One home, one fix.

import type { FailureReason } from "../contract.js";
import type { DecisionEvent } from "../events.js";

export const BACKOFF_BASE_MS = 250;
export const MAX_ATTEMPTS = 3;

/** HTTP status -> the contract's reason. Anything unlisted is a transport problem. */
export const REASON_BY_STATUS = new Map<number, FailureReason>([
  [401, "auth"],
  [403, "auth"],
  [422, "validation"],
  [400, "validation"],
  [429, "rate_limit"],
  [500, "transport"],
  [502, "transport"],
  [503, "overloaded"],
  [529, "overloaded"],
]);

/** Congestion is worth waiting out. Rejection is not: retrying a 401 or a 422 burns the budget
 *  to arrive at the same answer. */
export const RETRYABLE = new Set([429, 503, 529]);

export interface HttpOutcome {
  ok: boolean;
  /** Present when ok: the parsed JSON body. */
  body?: unknown;
  /** Present when not ok. */
  reason?: FailureReason;
  detail?: string;
}

export interface RequestOptions {
  url: string;
  headers: Record<string, string>;
  body: string;
  provider: string;
  signal: AbortSignal;
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  emit: (event: DecisionEvent) => void;
}

/** retry-after is seconds per RFC 9110; a malformed value falls back to the schedule. */
function retryAfterMs(res: Response): number | null {
  const h = res.headers.get("retry-after");
  if (!h) return null;
  const seconds = Number(h);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

/** POST with backoff. Never throws: a transport error is an outcome, like any other. */
export async function postWithRetry(opts: RequestOptions): Promise<HttpOutcome> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await opts.fetchImpl(opts.url, {
        method: "POST",
        headers: opts.headers,
        body: opts.body,
        signal: opts.signal,
      });
    } catch (err) {
      return { ok: false, reason: "transport", detail: err instanceof Error ? err.message : String(err) };
    }

    if (res.ok) {
      try {
        return { ok: true, body: await res.json() };
      } catch {
        return { ok: false, reason: "malformed", detail: "response body is not JSON" };
      }
    }

    // DRAIN BEFORE DECIDING. An unread body is never released back to the connection pool, so
    // the next attempt waits on a connection that will never free. Also the only place the
    // upstream error type is available for the detail.
    const errorBody = await res.text().catch(() => "");
    let upstream: string | undefined;
    try {
      upstream = (JSON.parse(errorBody) as { error?: { type?: string } }).error?.type;
    } catch {
      upstream = undefined;
    }

    const reason = REASON_BY_STATUS.get(res.status) ?? "transport";
    if (!(RETRYABLE.has(res.status) && attempt < MAX_ATTEMPTS)) {
      return { ok: false, reason, detail: upstream ? `HTTP ${res.status} (${upstream})` : `HTTP ${res.status}` };
    }

    const delay = retryAfterMs(res) ?? BACKOFF_BASE_MS * 2 ** (attempt - 1);
    opts.emit({ event: "decision_retry", provider: opts.provider, attempt, delay_ms: delay, status: res.status, reason });
    await opts.sleep(delay);
  }
  /* c8 ignore next */
  return { ok: false, reason: "transport", detail: "retry budget exhausted" };
}

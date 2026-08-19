// Notify the human on completion or escalation. Best-effort: terminal bell plus
// an optional webhook (Slack/Discord/whatever accepts a JSON POST).
//
// EVERY RUN ENDS HERE, on both engines — the serial loop, the parallel scheduler and
// `leopold workflow --run` all report through this one function. So this is where the
// run says what it decided on the human's behalf: the summary is appended to the body
// once, here, instead of at a dozen call sites that would drift apart. A run that
// decided nothing appends the empty string and its report is byte-for-byte the report
// it was before personas existed.

import { logEvent } from "./log.js";
import { maskCredentials } from "./secrets.js";
import { decidedForYou } from "./summary.js";

export async function notify(
  leoDir: string,
  webhookUrl: string | undefined,
  title: string,
  body: string,
): Promise<void> {
  const full = maskCredentials(body + decidedForYou(leoDir));
  process.stdout.write(`\x07\n=== ${title} ===\n${full}\n\n`);
  logEvent(leoDir, { event: "notify", title, body: full });
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, body: full, source: "leopold" }),
    });
  } catch {
    /* best-effort; a failed notification must not break the run */
  }
}

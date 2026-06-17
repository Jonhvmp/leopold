// Notify the human on completion or escalation. Best-effort: terminal bell plus
// an optional webhook (Slack/Discord/whatever accepts a JSON POST).

import { logEvent } from "./log.js";

export async function notify(
  leoDir: string,
  webhookUrl: string | undefined,
  title: string,
  body: string,
): Promise<void> {
  process.stdout.write(`\x07\n=== ${title} ===\n${body}\n\n`);
  logEvent(leoDir, { event: "notify", title, body });
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, body, source: "leopold" }),
    });
  } catch {
    /* best-effort; a failed notification must not break the run */
  }
}

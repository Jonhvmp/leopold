// A driver-controlled async iterable of worker input messages.
//
// The Claude Agent SDK consumes the worker's prompt as an AsyncIterable of user
// messages (streaming input mode). We drive it by hand: the conductor pushes a
// reply only after it has read and judged the worker's previous turn, which is
// what makes the exchange a real back-and-forth instead of a blind loop.

interface SDKUserMessage {
  type: "user";
  session_id: string;
  parent_tool_use_id: string | null;
  message: { role: "user"; content: Array<{ type: "text"; text: string }> };
}

export class InputChannel implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private waiting: Array<(r: IteratorResult<SDKUserMessage>) => void> = [];
  private closed = false;

  private wrap(text: string): SDKUserMessage {
    return {
      type: "user",
      session_id: "",
      parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "text", text }] },
    };
  }

  /** Send one user message into the worker session. */
  push(text: string): void {
    if (this.closed) return;
    const msg = this.wrap(text);
    const w = this.waiting.shift();
    if (w) w({ value: msg, done: false });
    else this.queue.push(msg);
  }

  /** Signal end of input; the worker session winds down. */
  close(): void {
    this.closed = true;
    let w: ((r: IteratorResult<SDKUserMessage>) => void) | undefined;
    while ((w = this.waiting.shift())) w({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        const queued = this.queue.shift();
        if (queued) return Promise.resolve({ value: queued, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiting.push(resolve));
      },
    };
  }
}

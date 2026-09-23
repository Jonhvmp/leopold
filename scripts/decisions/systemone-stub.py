#!/usr/bin/env python3
"""A System One API stub: answers `POST /v1/systemone` the way a real provider would.

Python stdlib only. It exists so every provider in `packages/driver/src/decisions/providers/`
can be exercised end to end -- request mapping, response mapping, status handling, retry and
backoff -- with NO network call and NO API key. GUARDRAILS "Network posture" requires this:
no test may reach the internet, and no item may need a key to close.

Sibling, not duplicate: `scripts/probe/api-stub.py` is the hook probe's stub and is documented
as one that ALWAYS FAILS with a single status -- it exists to end a headless session on an API
error. This one must also SUCCEED, must return well-formed typed answers, and must be able to
fail then succeed within one test (429, 429, 200). Those are different jobs; growing the first
into the second would have broken what the hook probe relies on.

    python3 systemone-stub.py --script 429,429,200 --log requests.jsonl
    python3 systemone-stub.py --script 401 --log requests.jsonl --port 8123

--script is the status sequence, one per request, and the LAST entry repeats forever. With
--port 0 (the default) the kernel picks the port and the chosen one is printed to stdout as
`PORT <n>` before the server starts, so a caller never has to guess or race.

WHAT IT NEVER RECORDS: the Authorization header's value. Only its scheme ("Bearer") and
whether it was present are logged, which is what lets a test PROVE the key never leaks into
a log, an event or an error message.
"""
import argparse
import json
import socketserver
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Error bodies in the shape the TypeSafe API documents: a status plus a JSON object whose
# `error.type` names the class. A provider maps these onto the contract's FailureReason.
ERROR_BODIES = {
    401: {"error": {"type": "authentication_error", "message": "STUB invalid api key"}},
    422: {"error": {"type": "invalid_request_error", "message": "STUB validation failed: question 'x' has no instructions"}},
    429: {"error": {"type": "rate_limit_error", "message": "STUB rate limited"}},
    529: {"error": {"type": "overloaded_error", "message": "STUB overloaded"}},
    500: {"error": {"type": "api_error", "message": "STUB internal error"}},
}


def answer_for(qid, question):
    """A deterministic, well-formed answer for one question, in the wire shape.

    Deterministic on purpose: a test asserts exact numbers, so nothing here may vary between
    runs. The distributions are lopsided enough to clear a default act bar, which is what
    makes the happy path actually exercise the `act` band.
    """
    qtype = question.get("type")
    if qtype == "noul":
        return {"type": "noul", "noul": 0.95}
    if qtype == "choice":
        options = list((question.get("criteria") or {}).keys())
        if not options:
            return {"type": "choice", "choice": "", "confidence": 0.0, "probabilities": {}}
        head, rest = options[0], options[1:]
        share = round(0.08 / len(rest), 4) if rest else 0.0
        probs = {head: round(1.0 - share * len(rest), 4)}
        probs.update({o: share for o in rest})
        return {"type": "choice", "choice": head, "confidence": 0.94, "probabilities": probs}
    if qtype == "score":
        levels = question.get("criteria") or []
        n = len(levels)
        probs = {str(i): 0.0 for i in range(n)}
        if n:
            probs["1" if n > 1 else "0"] = 1.0
        return {
            "type": "score",
            "score": 1.0 if n > 1 else 0.0,
            "confidence": 1.0,
            "legend": {str(i): lv for i, lv in enumerate(levels)},
            "probabilities": probs,
        }
    return {"type": "noul", "noul": 0.5}


def chat_completion(req, args):
    """An OpenAI-style chat completion whose answer is drawn from the request's OWN enum.

    The provider constrains the model with a json_schema whose `answer` property is an enum of
    the catalog's options; the stub reads that enum back out and answers from it, so a test
    never has to keep a copy of the option list in two places. With logprobs on, the answer
    token carries a `top_logprobs` distribution over every enum value -- lopsided, deterministic,
    and the thing the provider turns into `probabilities`.
    """
    if args.error_envelope:
        # A gateway answers 200 -- IT is healthy -- and reports the upstream failure in the body.
        return {"error": {"type": "provider_error", "message": "STUB upstream model unavailable",
                          "provider": "some-upstream"}}

    schema = (((req.get("response_format") or {}).get("json_schema") or {}).get("schema") or {})
    enum = ((schema.get("properties") or {}).get("answer") or {}).get("enum") or []
    if not enum:
        enum = ["true", "false"]
    answer = "NOT_AN_OPTION" if args.off_schema else enum[0]

    message = {"role": "assistant", "content": json.dumps({"answer": answer})}
    choice = {"index": 0, "message": message, "finish_reason": "stop"}

    if not args.no_logprobs:
        # A deterministic, lopsided distribution: the head takes most of the mass and the rest
        # split what is left, so the happy path clears a default act bar.
        head, rest = enum[0], enum[1:]
        logprobs = [{"token": head, "logprob": -0.05}]
        for i, opt in enumerate(rest):
            logprobs.append({"token": opt, "logprob": -3.0 - i})
        choice["logprobs"] = {"content": [
            {"token": '{"', "logprob": -0.001, "top_logprobs": [{"token": '{"', "logprob": -0.001}]},
            {"token": "answer", "logprob": -0.001, "top_logprobs": [{"token": "answer", "logprob": -0.001}]},
            {"token": answer, "logprob": logprobs[0]["logprob"], "top_logprobs": logprobs},
        ]}

    return {"id": "stub-1", "model": args.model, "choices": [choice],
            "usage": {"prompt_tokens": 120, "completion_tokens": 6}}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=0, help="0 lets the kernel choose; the port is printed")
    ap.add_argument("--script", default="200", help="comma-separated statuses, in order; the last repeats")
    ap.add_argument("--model", default="jev-1.13.0", help="the model id the RESPONSE reports")
    ap.add_argument("--shape", choices=("systemone", "chat"), default="systemone",
                    help="systemone: typed answers. chat: an OpenAI-style completion, for LLM-backed providers")
    ap.add_argument("--no-logprobs", action="store_true", help="chat shape: omit logprobs, as a model that cannot report them")
    ap.add_argument("--off-schema", action="store_true", help="chat shape: answer a value that is NOT in the request's enum")
    ap.add_argument("--error-envelope", action="store_true",
                    help="chat shape: return HTTP 200 carrying a provider-level error object and no choices, "
                         "the way a gateway reports that the model behind it failed")
    ap.add_argument("--retry-after", type=float, default=None, help="seconds, sent as the retry-after header on 429/529")
    ap.add_argument("--log", required=True)
    args = ap.parse_args()

    script = [int(s) for s in args.script.split(",") if s.strip()]
    if not script:
        print("--script needs at least one status", file=sys.stderr)
        return 2
    state = {"n": 0}
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *a):  # silence the default stderr chatter
            pass

        def do_POST(self):  # noqa: N802
            length = int(self.headers.get("content-length") or 0)
            body = self.rfile.read(length) if length else b"{}"
            try:
                req = json.loads(body or b"{}")
            except json.JSONDecodeError:
                req = {}

            with lock:
                i = state["n"]
                state["n"] += 1
            status = script[i] if i < len(script) else script[-1]

            auth = self.headers.get("authorization") or ""
            with open(args.log, "a", encoding="utf-8") as fh:
                fh.write(json.dumps({
                    "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "n": i,
                    "path": self.path,
                    "status": status,
                    # The SCHEME only. Never the credential.
                    "auth_scheme": auth.split(" ", 1)[0] if auth else "",
                    "auth_present": bool(auth),
                    "model_requested": req.get("model"),
                    "question_ids": sorted((req.get("questions") or {}).keys()),
                    "state_type": type(req.get("state")).__name__,
                }) + "\n")

            if status == 200 and args.shape == "chat":
                payload = chat_completion(req, args)
            elif status == 200:
                questions = req.get("questions") or {}
                payload = {
                    "model": args.model,
                    "answers": {qid: answer_for(qid, q) for qid, q in questions.items()},
                    "usage": {"input_tokens": 392, "output_tokens": 65},
                }
            else:
                payload = ERROR_BODIES.get(status, {"error": {"type": "unknown", "message": f"STUB {status}"}})

            data = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            if status in (429, 529) and args.retry_after is not None:
                self.send_header("retry-after", str(args.retry_after))
            self.end_headers()
            self.wfile.write(data)

    class Server(ThreadingHTTPServer):
        """Threaded, and bound WITHOUT a reverse DNS lookup.

        THREADING IS LOAD-BEARING, not a default. A keep-alive client (Node's fetch, and any
        real one) holds its connection open between attempts; a single-threaded server sits
        blocked reading that idle connection and never accepts the next one, so every retry
        test hangs until its timeout. Verified by probe before it was changed.

        SKIPPING getfqdn IS ALSO LOAD-BEARING. HTTPServer.server_bind calls
        socket.getfqdn(host) purely to fill in `server_name`, which nothing here reads. That
        is a reverse DNS lookup for 127.0.0.1: instant on a developer machine and on the
        Linux runners, and tens of seconds on a macOS CI runner with no reverse resolver --
        all of it BEFORE the port is printed. Every stub in the suite then timed out waiting
        for a port that was coming, eventually. Bind, name it ourselves, get on with it.
        """

        daemon_threads = True

        def server_bind(self):  # noqa: D102
            socketserver.TCPServer.server_bind(self)
            self.server_name = "127.0.0.1"
            self.server_port = self.server_address[1]

    server = Server(("127.0.0.1", args.port), Handler)
    print(f"PORT {server.server_address[1]}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

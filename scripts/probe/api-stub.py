#!/usr/bin/env python3
"""Leopold hook-event probe: a model-API stub that always fails.

Python stdlib only. Listens on 127.0.0.1:<port> and answers EVERY request with one
HTTP status (429, 529, 500, 401, ...) and an error body in the shape the pointed
harness expects, so a headless session ends on an API error and the probe can see
which lifecycle hook that fires (Claude Code: StopFailure with error_type; Codex:
whatever the captured payloads say). Each request is appended to --log as one JSON
line: method, path, status, and the authorization header's *scheme* only.

    python3 api-stub.py --port 8765 --status 429 --shape anthropic --log requests.jsonl
"""
import argparse
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

BODIES = {
    "anthropic": {
        429: {"type": "error", "error": {"type": "rate_limit_error", "message": "PROBE rate limited"}},
        529: {"type": "error", "error": {"type": "overloaded_error", "message": "PROBE overloaded"}},
        500: {"type": "error", "error": {"type": "api_error", "message": "PROBE internal server error"}},
        401: {"type": "error", "error": {"type": "authentication_error", "message": "PROBE invalid credentials"}},
    },
    "openai": {
        429: {"error": {"type": "rate_limit_error", "code": "rate_limit_exceeded", "message": "PROBE rate limited"}},
        529: {"error": {"type": "server_error", "code": "overloaded", "message": "PROBE overloaded"}},
        500: {"error": {"type": "server_error", "code": "internal_error", "message": "PROBE internal server error"}},
        401: {"error": {"type": "invalid_request_error", "code": "invalid_api_key", "message": "PROBE invalid credentials"}},
    },
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--status", type=int, required=True)
    ap.add_argument("--shape", choices=sorted(BODIES), default="anthropic")
    ap.add_argument("--log", required=True)
    args = ap.parse_args()
    body = BODIES[args.shape].get(args.status) or {"error": {"type": "probe", "message": f"PROBE status {args.status}"}}
    payload = json.dumps(body).encode()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def _answer(self):  # noqa: N802
            length = int(self.headers.get("content-length") or 0)
            if length:
                self.rfile.read(length)
            auth = self.headers.get("authorization") or ""
            with open(args.log, "a", encoding="utf-8") as fh:
                fh.write(json.dumps({
                    "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "method": self.command, "path": self.path, "status": args.status,
                    "auth_scheme": auth.split(" ", 1)[0] if auth else "",
                    "x_api_key": bool(self.headers.get("x-api-key")),
                }) + "\n")
            self.send_response(args.status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(payload)))
            if args.status == 429:
                self.send_header("retry-after", "1")
            self.end_headers()
            self.wfile.write(payload)

        do_GET = do_POST = do_PUT = do_DELETE = _answer  # noqa: N815

        def log_message(self, *_):  # silence the default stderr log
            return

    srv = HTTPServer(("127.0.0.1", args.port), Handler)
    print(f"api-stub listening on 127.0.0.1:{args.port} status={args.status} shape={args.shape}", file=sys.stderr, flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())

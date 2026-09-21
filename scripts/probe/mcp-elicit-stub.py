#!/usr/bin/env python3
"""Leopold hook-event probe: a stdio MCP server whose one tool elicits user input.

Python stdlib only, newline-delimited JSON-RPC over stdin/stdout. It exposes
`ask_probe`; calling it sends an `elicitation/create` request back to the client
and returns whatever the client answered (or the error). That is the only way to
make a harness fire its Elicitation / ElicitationResult hooks from a headless run.
Every message in either direction is appended to --log as one JSON line.
"""
import argparse
import json
import sys
import time

ap = argparse.ArgumentParser()
ap.add_argument("--log", required=True)
args = ap.parse_args()


def log(direction, msg):
    with open(args.log, "a", encoding="utf-8") as fh:
        fh.write(json.dumps({"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "dir": direction, "msg": msg}) + "\n")


def send(msg):
    log("out", msg)
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def read():
    line = sys.stdin.readline()
    if not line:
        return None
    line = line.strip()
    if not line:
        return {}
    msg = json.loads(line)
    log("in", msg)
    return msg


TOOL = {
    "name": "ask_probe",
    "description": "Asks the user one question through MCP elicitation and returns the answer verbatim.",
    "inputSchema": {"type": "object", "properties": {"question": {"type": "string"}}, "required": ["question"]},
}

pending_elicit = {}
next_id = 1000

while True:
    msg = read()
    if msg is None:
        break
    if not msg:
        continue
    mid = msg.get("id")
    method = msg.get("method")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": mid, "result": {
            "protocolVersion": msg.get("params", {}).get("protocolVersion", "2025-06-18"),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "probe-elicit", "version": "0.0.0"}}})
    elif method == "notifications/initialized":
        pass
    elif method == "ping":
        send({"jsonrpc": "2.0", "id": mid, "result": {}})
    elif method == "tools/list":
        send({"jsonrpc": "2.0", "id": mid, "result": {"tools": [TOOL]}})
    elif method == "tools/call":
        question = (msg.get("params", {}).get("arguments") or {}).get("question", "PROBE question?")
        next_id += 1
        pending_elicit[next_id] = mid
        send({"jsonrpc": "2.0", "id": next_id, "method": "elicitation/create", "params": {
            "message": question,
            "requestedSchema": {"type": "object", "properties": {"answer": {"type": "string", "title": "Answer"}}, "required": ["answer"]}}})
    elif mid in pending_elicit and ("result" in msg or "error" in msg):
        call_id = pending_elicit.pop(mid)
        text = json.dumps(msg.get("result") if "result" in msg else {"error": msg.get("error")})
        send({"jsonrpc": "2.0", "id": call_id, "result": {"content": [{"type": "text", "text": "ELICITATION_RESULT " + text}], "isError": False}})
    elif mid is not None and method:
        send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"method not found: {method}"}})

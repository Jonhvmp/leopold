#!/usr/bin/env bash
# Behavior tests for the ovmem extension's harness port
# (extensions/ovmem/manage.sh, extensions/ovmem/install.sh, payload/ovmem.py).
#
# HERMETIC. HOME, CLAUDE_HOME, CODEX_HOME and LEOPOLD_OVMEM_DIR all point inside a temp
# dir. Nothing here installs OpenViking, talks to the network, starts a server, or
# writes into the developer's real ~/.codex, ~/.claude or ~/.openviking — the wiring is
# driven straight through the shared writer (the same call install.sh makes), and the
# engine is exercised as a plain hook: JSON on stdin, JSON or text on stdout.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANAGE="$ROOT/extensions/ovmem/manage.sh"
ENGINE="$ROOT/extensions/ovmem/payload/ovmem.py"

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  \033[32mok\033[0m   %s\n' "$*"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "$*"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want [$3], got [$2])"; fi; }
has()  { if printf '%s' "$2" | grep -q -- "$3"; then ok "$1"; else bad "$1"; fi; }
hasnt(){ if printf '%s' "$2" | grep -q -- "$3"; then bad "$1"; else ok "$1"; fi; }

# Names only, so a live agent session writing its own transcripts does not fail the
# suite. What an escaped write looks like is a NEW entry, and that is what this catches.
real_codex_fp()  { ls -A "$HOME/.codex"  2>/dev/null | sort | cksum; }
real_claude_fp() { ls -A "$HOME/.claude" 2>/dev/null | sort | cksum; }
real_ov_fp()     { ls -A "$HOME/.openviking" 2>/dev/null | sort | cksum; }
CODEX_BEFORE="$(real_codex_fp)"; CLAUDE_BEFORE="$(real_claude_fp)"; OV_BEFORE="$(real_ov_fp)"
REAL_HOME="$HOME"

TD="$(mktemp -d)"
trap 'rm -rf "$TD"' EXIT
mkdir -p "$TD/home" "$TD/codex" "$TD/claude" "$TD/ovmem/state"

CFG="$TD/codex/config.toml"
SET="$TD/claude/settings.json"
OVDIR="$TD/ovmem"

toml_ok()  { python3 -c 'import sys,tomllib;tomllib.load(open(sys.argv[1],"rb"))' "$1" 2>/dev/null; }
toml_get() { python3 - "$1" "$2" <<'PY'
import sys, tomllib
d = tomllib.load(open(sys.argv[1], "rb"))
for k in sys.argv[2].split("."):
    d = d[int(k)] if isinstance(d, list) else d[k]
print(d)
PY
}

# The wiring exactly as extensions/ovmem/install.sh performs it: same shared writer,
# same specs, same tag. Sourced rather than re-implemented so a change to the installer
# that this test does not follow shows up as a failure, not as a green lie.
wire() { # <harness> [claude-home] [codex-home] [ovmem-dir]
  local h="$1" ch="${2:-$TD/claude}" xh="${3:-$TD/codex}" od="${4:-$OVDIR}"
  env -i PATH="$PATH" HOME="$TD/home" CLAUDE_HOME="$ch" CODEX_HOME="$xh" \
      LEOPOLD_HARNESS="$h" OVDIR="$od" TERM=dumb bash -c '
    . "'"$ROOT"'/extensions/lib/harness.sh"
    sed -n "/^ovmem_specs()/,/^}/p" "'"$ROOT"'/extensions/ovmem/install.sh" \
      | sed "s#\$OVMEM_DIR#$OVDIR#g" > /tmp/.ovspec.$$ && . /tmp/.ovspec.$$ && rm -f /tmp/.ovspec.$$
    for h in $(leo_harness_targets); do
      specs=(); while IFS= read -r line; do specs+=("$line"); done < <(ovmem_specs "$h")
      case "$h" in
        claude) leo_wire_hooks_json "$(leo_settings_file)" ovmem "${specs[@]}" ;;
        codex)  leo_wire_hooks_toml "$(leo_config_file)"   ovmem "${specs[@]}" ;;
      esac
    done' 2>&1
}

run() { # <harness> <manage.sh arg...>
  local h="$1"; shift
  env -i PATH="$PATH" HOME="$TD/home" CLAUDE_HOME="$TD/claude" CODEX_HOME="$TD/codex" \
      LEOPOLD_HARNESS="$h" LEOPOLD_OVMEM_DIR="$OVDIR" TERM=dumb \
      bash "$MANAGE" "$@" 2>&1
}

# Pretend the engine is installed — manage.sh reports on files, never on a live server.
cp "$ROOT/extensions/ovmem/payload/ovmem.py" "$OVDIR/ovmem.py"
cp "$ROOT/extensions/ovmem/payload/ovmem-cleanup.py" "$OVDIR/ovmem-cleanup.py"
cp "$ROOT/extensions/ovmem/payload/dashboard.py" "$OVDIR/dashboard.py"

echo "ovmem extension — Codex-only install into a temp CODEX_HOME"

printf 'model = "gpt-5"\n' > "$CFG"
out="$(wire codex)"
check "wiring exits clean" "$?" "0"
check "config.toml still parses" "$(toml_ok "$CFG" && echo yes || echo no)" "yes"

for ev in SessionStart UserPromptSubmit PreCompact SessionEnd; do
  check "$ev declared in config.toml" "$(grep -c "^\[\[hooks.$ev\]\]$" "$CFG")" "1"
done
check "four ovmem hook commands"  "$(grep -c 'ovmem.py --event' "$CFG")" "4"
check "one managed ovmem block"   "$(grep -c '^# >>> leopold:ovmem (managed) >>>$' "$CFG")" "1"
check "the user's own config key survived" "$(toml_get "$CFG" model)" "gpt-5"
check "no Claude settings.json was created" "$( [ -e "$SET" ] && echo yes || echo no )" "no"
hasnt "nothing points at a Claude path" "$(cat "$CFG")" "/.claude"

# codex-cli 0.146.0 hard-caps a SessionEnd hook at 3s and rewrites anything larger
# (`clamping SessionEnd hook timeout to 3s`). Declaring the value it will honor keeps
# that warning off every session start.
check "SessionEnd declared at Codex's 3s cap" "$(toml_get "$CFG" 'hooks.SessionEnd.0.hooks.0.timeout')" "3"
check "PreCompact keeps its full 25s"         "$(toml_get "$CFG" 'hooks.PreCompact.0.hooks.0.timeout')" "25"

if command -v codex >/dev/null 2>&1; then
  clamp="$(env -i PATH="$PATH" HOME="$TD/home" CODEX_HOME="$TD/codex" \
           codex exec --dangerously-bypass-hook-trust --skip-git-repo-check \
           -s read-only -m __leopold_no_such_model__ x </dev/null 2>&1 | grep -c 'clamping')"
  check "the real codex binary clamps none of our timeouts" "$clamp" "0"
else
  echo "  (skipped the live-codex clamp assertion: no \`codex\` binary on PATH)"
fi

echo
echo "ovmem extension — doctor is green on Codex"

doc="$(run codex doctor)"
has   "doctor names the harness"          "$doc" "Codex CLI:"
check "doctor reports 4/4 hooks"          "$(printf '%s' "$doc" | grep -c 'hooks:   4/4')" "1"
has   "doctor states the hook-trust gate" "$doc" "inert until you approve it once"
has   "doctor states the SessionEnd cap"  "$doc" "caps SessionEnd at 3s"
hasnt "doctor never points at a Claude path" "$doc" "/.claude"
hasnt "doctor finds every vendored file" \
  "$(printf '%s\n' "$doc" | grep -E '^(engine|cleanup|dashboard):')" "missing"

st="$(run codex status)"
check "status is one line (the menu renders it inline)" "$(printf '%s\n' "$st" | wc -l)" "1"
has   "status reports the Codex hooks" "$st" "Codex CLI: hooks 4/4"

echo
echo "ovmem extension — leopold doctor tells wired from half-wired"

# Regression. `grep -c PAT FILE` prints "0" AND exits 1 when the file exists with no
# match, so a `|| echo 0` fallback handed `[` the two-line string "0\n0"; the test
# aborted with "integer expression expected", the && chain short-circuited, and doctor
# reported a COMPLETELY unwired ovmem as "installed + wired" — a false green in exactly
# the half-install case the check exists to catch. Both directions stay asserted here.
DOC="$TD/doc"; mkdir -p "$DOC/claude" "$DOC/codex" "$DOC/ovmem" "$DOC/dhome"
cp "$ROOT/extensions/ovmem/payload/ovmem.py" "$DOC/ovmem/ovmem.py"
printf 'model = "gpt-5"\n' > "$DOC/codex/config.toml"   # exists, zero ovmem hooks
echo '{}' > "$DOC/claude/settings.json"                 # ditto — the bug's exact shape

# LEOPOLD_SRC points at nothing, so the update check exits before its network call.
doctor() {
  env -i PATH="$PATH" HOME="$DOC/dhome" CLAUDE_HOME="$DOC/claude" CODEX_HOME="$DOC/codex" \
      LEOPOLD_OVMEM_DIR="$DOC/ovmem" LEOPOLD_SRC="$DOC/nosrc" TERM=dumb \
      bash "$ROOT/scripts/leopold-doctor.sh" 2>&1 | grep -i ovmem
}

doc="$(doctor)"
has   "doctor calls a zero-hook config unwired"     "$doc" "ovmem not wired on Claude Code + Codex CLI"
hasnt "and never reports it as installed + wired"   "$doc" "installed + wired"

# Half-wired: Codex gets its four, Claude Code still has none. Naming the harness that
# is missing is the whole point of the check.
wire codex "$DOC/claude" "$DOC/codex" "$DOC/ovmem" >/dev/null
doc="$(doctor)"
has   "doctor names only the harness still missing" "$doc" "not wired on Claude Code"
hasnt "and does not blame the wired one"            "$doc" "Codex CLI"

# Fully wired on both. The OpenViking server may or may not be running here, so assert
# on the wiring verdict only — "wired" yes, "not wired" no — never on the server half.
wire all "$DOC/claude" "$DOC/codex" "$DOC/ovmem" >/dev/null
doc="$(doctor)"
has   "doctor stops reporting it unwired once both harnesses have all four" "$doc" "wired"
hasnt "no harness is left named as missing"                                 "$doc" "not wired"

echo
echo "ovmem extension — install is idempotent (wire it three times)"

cp "$CFG" "$TD/after-first.toml"
wire codex >/dev/null
wire codex >/dev/null
check "config.toml unchanged by the 2nd and 3rd run" \
  "$(diff -q "$TD/after-first.toml" "$CFG" >/dev/null && echo same || echo changed)" "same"
check "still exactly four ovmem hooks" "$(grep -c 'ovmem.py --event' "$CFG")" "4"
check "still one managed ovmem block"  "$(grep -c '^# >>> leopold:ovmem (managed) >>>$' "$CFG")" "1"
for ev in SessionStart UserPromptSubmit PreCompact SessionEnd; do
  check "still exactly one $ev entry" "$(grep -c "^\[\[hooks.$ev\]\]$" "$CFG")" "1"
done

echo
echo "ovmem extension — the Claude Code side is untouched by all of that"

wire claude >/dev/null
check "settings.json parses" "$(jq -e . "$SET" >/dev/null 2>&1 && echo yes || echo no)" "yes"
check "four ovmem hooks in settings.json" \
  "$(jq '[.hooks[]?[]?.hooks[]? | select(.command | test("ovmem.py --event"))] | length' "$SET")" "4"
check "Claude keeps the full 25s SessionEnd" \
  "$(jq -r '.hooks.SessionEnd[0].hooks[0].timeout' "$SET")" "25"
wire claude >/dev/null; wire claude >/dev/null
check "Claude wiring is idempotent too" \
  "$(jq '[.hooks[]?[]?.hooks[]? | select(.command | test("ovmem.py --event"))] | length' "$SET")" "4"
check "Codex hooks not duplicated by the Claude run" "$(grep -c 'ovmem.py --event' "$CFG")" "4"

echo
echo "ovmem extension — the engine handles a real Codex payload"

# The exact SessionStart / UserPromptSubmit / SessionEnd payloads codex-cli 0.146.0
# emitted in a live session (captured with a logging hook), minus the machine-specific
# paths. No OpenViking server is running, so every API call fails — which is the point:
# the golden rule is that a hook NEVER breaks the session.
SESS="$TD/codex/sessions/2026/08/03"; mkdir -p "$SESS"
ROLL="$SESS/rollout-2026-08-03T19-23-32-019fc9b9-9d46-7033-b77e-fe2055167398.jsonl"
cat > "$ROLL" <<'JSONL'
{"timestamp":"2026-08-03T19:23:32.000Z","type":"session_meta","payload":{"id":"019fc9b9","cwd":"/tmp/proj"}}
{"timestamp":"2026-08-03T19:23:33.000Z","type":"turn_context","payload":{"model":"gpt-5.6-sol"}}
{"timestamp":"2026-08-03T19:23:34.000Z","type":"event_msg","payload":{"type":"user_message","message":"I prefer concise answers and pnpm over npm.","images":[]}}
{"timestamp":"2026-08-03T19:23:35.000Z","type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"<permissions instructions> boilerplate that must NOT be committed"}]}}
{"timestamp":"2026-08-03T19:23:36.000Z","type":"event_msg","payload":{"type":"agent_message","message":"Noted: concise answers, pnpm.","phase":"commentary"}}
{"timestamp":"2026-08-03T19:23:37.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":4453}}}}
JSONL

engine() { # <event> <payload-json>
  printf '%s' "$2" | env -i PATH="$PATH" HOME="$TD/home" CLAUDE_HOME="$TD/claude" \
    CODEX_HOME="$TD/codex" LEOPOLD_OVMEM_DIR="$OVDIR" OVMEM_TIMEOUT=1 \
    OVMEM_DEBUG="${OVMEM_DEBUG:-0}" \
    LEOPOLD_SDK_WORKER="${LEOPOLD_SDK_WORKER:-}" \
    LEOPOLD_OVMEM_WORKER_FLUSH="${LEOPOLD_OVMEM_WORKER_FLUSH:-}" \
    python3 "$ENGINE" --event "$1" 2>&1
}

CODEX_SS="{\"session_id\":\"019fc9b9\",\"transcript_path\":\"$ROLL\",\"cwd\":\"$TD/proj\",\"hook_event_name\":\"SessionStart\",\"model\":\"gpt-5.6-sol\",\"permission_mode\":\"bypassPermissions\",\"source\":\"startup\"}"
out="$(engine session-start "$CODEX_SS")"; rc=$?
check "SessionStart on Codex exits 0 with no server" "$rc" "0"
check "SessionStart prints nothing it cannot back"   "$out" ""

# Now with a recall to inject. The API is stubbed by pointing the engine at a tiny
# local HTTP server that answers /search/find — still zero network, still stdlib.
python3 - "$TD/stub.port" <<'PY' &
import json, sys, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
HITS = {"result": {"memories": [
    {"uri": "viking://user/me/memories/prefs.md", "score": 0.91,
     "overview": "Prefers concise answers and pnpm over npm."}]}}
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers()
        self.wfile.write(json.dumps({"healthy": True}).encode())
    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers()
        self.wfile.write(json.dumps(HITS if self.path.endswith("/search/find") else {"status": "ok"}).encode())
srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
open(sys.argv[1], "w").write(str(srv.server_address[1]))
srv.serve_forever()
PY
STUB_PID=$!
for _ in $(seq 1 50); do [ -s "$TD/stub.port" ] && break; sleep 0.1; done
PORT="$(cat "$TD/stub.port" 2>/dev/null)"
mkdir -p "$TD/home/.openviking"
cat > "$TD/home/.openviking/ov.conf" <<EOF
{"server":{"host":"127.0.0.1","port":$PORT,"root_api_key":"test-key"}}
EOF

out="$(engine session-start "$CODEX_SS")"
check "SessionStart on Codex still exits 0" "$?" "0"
has   "it injects a memory block"          "$out" "long-term memory"
check "the block is a JSON envelope Codex accepts" \
  "$(printf '%s' "$out" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["hookSpecificOutput"]["hookEventName"])')" \
  "SessionStart"
has "the recalled memory is inside additionalContext" "$out" "pnpm"

CODEX_UP="{\"session_id\":\"019fc9b9\",\"turn_id\":\"019fc9b9-9e69\",\"transcript_path\":\"$ROLL\",\"cwd\":\"$TD/proj\",\"hook_event_name\":\"UserPromptSubmit\",\"prompt\":\"which package manager should I use here?\"}"
out="$(engine user-prompt "$CODEX_UP")"
check "UserPromptSubmit envelope names its own event" \
  "$(printf '%s' "$out" | python3 -c 'import json,sys; print(json.load(sys.stdin)["hookSpecificOutput"]["hookEventName"])')" \
  "UserPromptSubmit"

# Claude Code must still get PLAIN TEXT — a JSON body there would break concatenation
# with any other hook on the same event.
mkdir -p "$TD/claude/projects/p"
CLAUDE_T="$TD/claude/projects/p/aaaa.jsonl"
cat > "$CLAUDE_T" <<'JSONL'
{"type":"user","message":{"role":"user","content":"I prefer concise answers."}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Noted."}]}}
JSONL
CLAUDE_UP="{\"session_id\":\"c-1\",\"transcript_path\":\"$CLAUDE_T\",\"cwd\":\"$TD/proj\",\"hook_event_name\":\"UserPromptSubmit\",\"prompt\":\"which package manager should I use here?\"}"
out="$(engine user-prompt "$CLAUDE_UP")"
hasnt "Claude Code still gets plain text, not JSON" "$out" "hookSpecificOutput"
has   "and the block is still injected"             "$out" "long-term memory"

echo
echo "ovmem extension — the flush reads a Codex rollout"

flush="$(env -i PATH="$PATH" HOME="$TD/home" CLAUDE_HOME="$TD/claude" CODEX_HOME="$TD/codex" \
        LEOPOLD_OVMEM_DIR="$OVDIR" python3 - "$ENGINE" "$ROLL" <<'PY'
import importlib.util, sys, json
spec = importlib.util.spec_from_file_location("ovmem", sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
msgs, total = m.parse_transcript_delta(sys.argv[2], 0)
print(json.dumps({"n": len(msgs), "roles": [x["role"] for x in msgs],
                  "text": " | ".join(x["content"] for x in msgs), "total": total}))
PY
)"
check "two conversational turns came out of the rollout" "$(printf '%s' "$flush" | jq -r .n)" "2"
check "roles are user then assistant" "$(printf '%s' "$flush" | jq -rc .roles)" '["user","assistant"]'
has   "the user turn is there"        "$flush" "pnpm over npm"
has   "the assistant turn is there"   "$flush" "Noted: concise answers"
hasnt "the harness's own boilerplate is NOT committed" "$flush" "permissions instructions"
check "the offset counts every line, so the next flush skips them" \
  "$(printf '%s' "$flush" | jq -r .total)" "6"

# SessionEnd on Codex must hand off rather than run inline: codex kills the hook at 3s.
CODEX_SE="{\"session_id\":\"019fc9b9\",\"transcript_path\":\"$ROLL\",\"cwd\":\"$TD/proj\",\"hook_event_name\":\"SessionEnd\",\"reason\":\"other\"}"
start="$(date +%s)"
out="$(OVMEM_DEBUG=1 engine session-end "$CODEX_SE")"
check "SessionEnd on Codex exits 0"        "$?" "0"
check "and returns inside Codex's 3s cap"  "$( [ $(( $(date +%s) - start )) -lt 3 ] && echo yes || echo no )" "yes"
sleep 1
has "the detached child did the commit" "$(cat "$OVDIR/ovmem.log" 2>/dev/null)" "committed 2 msgs"
check "the detached child cleaned up its payload file" \
  "$(ls "$OVDIR/state"/flush-*.json 2>/dev/null | wc -l)" "0"

# Claude Code keeps running the flush in-process — no behavior change there.
rm -f "$OVDIR/ovmem.log" "$OVDIR/state"/*.json
CLAUDE_SE="{\"session_id\":\"c-1\",\"transcript_path\":\"$CLAUDE_T\",\"cwd\":\"$TD/proj\",\"hook_event_name\":\"SessionEnd\",\"reason\":\"other\"}"
OVMEM_DEBUG=1 engine session-end "$CLAUDE_SE" >/dev/null
log="$(cat "$OVDIR/ovmem.log" 2>/dev/null)"
has   "Claude Code committed in-process"     "$log" "session-end: committed 2 msgs"
hasnt "Claude Code did not detach anything"  "$log" "detached child"

echo
echo "ovmem extension — SDK workers do not flush per item"

# The driver marks EVERY SDK session it spawns — workers, reviewers, judges,
# hypotheses, routes — with LEOPOLD_SDK_WORKER=1 at its one query seam (sdk.ts), and
# hooks inherit that environment (verified live: docs/reference/sdk-worker-hooks.md).
# Policy: per-item flushes are suppressed — a 3-item run must create ZERO worker OV
# sessions; the conductor's own session (no marker) still flushes exactly as before.
rm -f "$OVDIR/ovmem.log" "$OVDIR/state"/*.json
for w in w-1 w-2 w-3; do
  WORKER_SE="{\"session_id\":\"$w\",\"transcript_path\":\"$CLAUDE_T\",\"cwd\":\"$TD/proj\",\"hook_event_name\":\"SessionEnd\",\"reason\":\"other\"}"
  out="$(OVMEM_DEBUG=1 LEOPOLD_SDK_WORKER=1 engine session-end "$WORKER_SE")"
  check "worker $w SessionEnd exits 0" "$?" "0"
done
sleep 1
log="$(cat "$OVDIR/ovmem.log" 2>/dev/null)"
check "a 3-item run flushed zero worker sessions" "$(printf '%s' "$log" | grep -c 'committed')" "0"
check "each of the 3 suppressions is logged, never silent" \
  "$(printf '%s' "$log" | grep -c 'sdk-worker flush suppressed')" "3"
has  "the log names the reversal env var" "$log" "LEOPOLD_OVMEM_WORKER_FLUSH=1"

# Same policy on the Codex path: the worker marker wins before the detach handoff.
WORKER_CODEX_SE="{\"session_id\":\"w-codex\",\"transcript_path\":\"$ROLL\",\"cwd\":\"$TD/proj\",\"hook_event_name\":\"SessionEnd\",\"reason\":\"other\"}"
rm -f "$OVDIR/ovmem.log"
OVMEM_DEBUG=1 LEOPOLD_SDK_WORKER=1 engine session-end "$WORKER_CODEX_SE" >/dev/null
sleep 1
log="$(cat "$OVDIR/ovmem.log" 2>/dev/null)"
has   "a Codex-shaped worker is suppressed too"  "$log" "sdk-worker flush suppressed"
hasnt "and nothing was handed to a detached child" "$log" "detached child"

# PreCompact inside a worker is the same write path — suppressed as well.
rm -f "$OVDIR/ovmem.log"
WORKER_PC="{\"session_id\":\"w-1\",\"transcript_path\":\"$CLAUDE_T\",\"cwd\":\"$TD/proj\",\"hook_event_name\":\"PreCompact\"}"
OVMEM_DEBUG=1 LEOPOLD_SDK_WORKER=1 engine pre-compact "$WORKER_PC" >/dev/null
log="$(cat "$OVDIR/ovmem.log" 2>/dev/null)"
has   "worker pre-compact is suppressed"      "$log" "pre-compact: sdk-worker flush suppressed"
hasnt "and nothing was committed"             "$log" "committed"

# The reversal is one env var: LEOPOLD_OVMEM_WORKER_FLUSH=1 restores per-item flushes.
rm -f "$OVDIR/ovmem.log" "$OVDIR/state"/*.json
WORKER_SE="{\"session_id\":\"w-flush\",\"transcript_path\":\"$CLAUDE_T\",\"cwd\":\"$TD/proj\",\"hook_event_name\":\"SessionEnd\",\"reason\":\"other\"}"
OVMEM_DEBUG=1 LEOPOLD_SDK_WORKER=1 LEOPOLD_OVMEM_WORKER_FLUSH=1 engine session-end "$WORKER_SE" >/dev/null
log="$(cat "$OVDIR/ovmem.log" 2>/dev/null)"
has "LEOPOLD_OVMEM_WORKER_FLUSH=1 restores the flush" "$log" "session-end: committed 2 msgs"

kill "$STUB_PID" 2>/dev/null; wait "$STUB_PID" 2>/dev/null

echo
echo "ovmem extension — run-aware flushes tag the OV session"

# A recording stub: same stdlib shape as above, but it also appends every POST —
# path + the RAW request body, byte for byte — to a jsonl file, so the assertions
# below are about what actually went over the wire. Still zero real network.
: > "$TD/stub.reqs"; rm -f "$TD/stub.port"
python3 - "$TD/stub.port" "$TD/stub.reqs" <<'PY' &
import json, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
REQS = sys.argv[2]
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers()
        self.wfile.write(json.dumps({"healthy": True}).encode())
    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode()
        with open(REQS, "a") as f:
            f.write(json.dumps({"path": self.path, "raw": raw}) + "\n")
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers()
        self.wfile.write(json.dumps({"status": "ok"}).encode())
srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
open(sys.argv[1], "w").write(str(srv.server_address[1]))
srv.serve_forever()
PY
STUB_PID=$!
for _ in $(seq 1 50); do [ -s "$TD/stub.port" ] && break; sleep 0.1; done
PORT="$(cat "$TD/stub.port" 2>/dev/null)"
cat > "$TD/home/.openviking/ov.conf" <<EOF
{"server":{"host":"127.0.0.1","port":$PORT,"root_api_key":"test-key"}}
EOF
last_session_body() { jq -r 'select(.path | endswith("/sessions")) | .raw' "$TD/stub.reqs" | tail -1; }

# A flush during window 3 of an active run: the exact state shape the 0.18.0 Stop
# hook maintains, inside the project the hook payload's cwd names — never $PWD.
mkdir -p "$TD/myproj/.leopold"
cat > "$TD/myproj/.leopold/state.json" <<'EOF'
{"active": true, "windows": 3, "max_windows": 4, "started_at": "2026-08-18T10:00:00.000Z", "iteration": 12}
EOF
rm -f "$OVDIR/ovmem.log" "$OVDIR/state"/*.json
RUN_SE="{\"session_id\":\"r-1\",\"transcript_path\":\"$CLAUDE_T\",\"cwd\":\"$TD/myproj\",\"hook_event_name\":\"SessionEnd\",\"reason\":\"other\"}"
out="$(OVMEM_DEBUG=1 engine session-end "$RUN_SE")"
check "run-aware SessionEnd exits 0" "$?" "0"
sess="$(last_session_body)"
has "the session title names the project"     "$sess" "myproj"
has "the session title carries the run stamp" "$sess" "run 20260818"
has "the session title says window 3 of 4"    "$sess" "window 3 of 4"
check "metadata carries the structured run identity" \
  "$(printf '%s' "$sess" | jq -r '.metadata.leopold | "\(.project)/\(.window)/\(.engine)"')" \
  "myproj/3/claude"
check "metadata carries the full run start stamp" \
  "$(printf '%s' "$sess" | jq -r '.metadata.leopold.run_started_at')" "2026-08-18T10:00:00.000Z"
has "the tag is logged, never silent" "$(cat "$OVDIR/ovmem.log" 2>/dev/null)" "run-aware flush"

# A rolled window is still the run: 0.18.0 marks the state inactive at the roll
# boundary (stopped_reason=context_budget) and the SessionEnd flush fires exactly in
# that gap, before the relaunch.
cat > "$TD/myproj/.leopold/state.json" <<'EOF'
{"active": false, "stopped_reason": "context_budget", "windows": 3, "max_windows": 4, "started_at": "2026-08-18T10:00:00.000Z"}
EOF
rm -f "$OVDIR/state"/*.json
RUN_SE2="{\"session_id\":\"r-2\",\"transcript_path\":\"$CLAUDE_T\",\"cwd\":\"$TD/myproj\",\"hook_event_name\":\"SessionEnd\",\"reason\":\"other\"}"
engine session-end "$RUN_SE2" >/dev/null
has "a rolled window still tags the flush" "$(last_session_body)" "window 3 of 4"

# ...but a rolled-and-ABANDONED run must not tag forever. The roll gap is minutes
# wide; a state still saying context_budget weeks later is a run nobody resumed, and
# tagging an ordinary interactive session with its window number is misattributed
# memory. Same 10-minute staleness line the watcher's relaunch draws. mtime is the
# fallback clock, so age the file itself too.
cat > "$TD/myproj/.leopold/state.json" <<'EOF'
{"active": false, "stopped_reason": "context_budget", "windows": 3, "max_windows": 4, "started_at": "2026-08-01T10:00:00.000Z", "last_turn": "2026-08-01T10:05:00Z"}
EOF
touch -d "2 hours ago" "$TD/myproj/.leopold/state.json" 2>/dev/null || touch -t 202608180800 "$TD/myproj/.leopold/state.json"
rm -f "$OVDIR/state"/*.json
STALE_SE="{\"session_id\":\"r-stale\",\"transcript_path\":\"$CLAUDE_T\",\"cwd\":\"$TD/myproj\",\"hook_event_name\":\"SessionEnd\",\"reason\":\"other\"}"
engine session-end "$STALE_SE" >/dev/null
hasnt "a week-old roll does NOT tag an ordinary session" "$(last_session_body)" "window 3 of 4"

# A LIVE run is never staleness-checked: its own turns keep it current, and a long
# quiet stretch inside a window must not strip the tag.
cat > "$TD/myproj/.leopold/state.json" <<'EOF'
{"active": true, "windows": 2, "max_windows": 4, "started_at": "2026-08-18T10:00:00.000Z", "last_turn": "2026-08-18T10:05:00Z"}
EOF
touch -d "2 hours ago" "$TD/myproj/.leopold/state.json" 2>/dev/null || true
rm -f "$OVDIR/state"/*.json
LIVE_SE="{\"session_id\":\"r-live\",\"transcript_path\":\"$CLAUDE_T\",\"cwd\":\"$TD/myproj\",\"hook_event_name\":\"SessionEnd\",\"reason\":\"other\"}"
engine session-end "$LIVE_SE" >/dev/null
has "an ACTIVE run tags regardless of quiet time" "$(last_session_body)" "window 2 of 4"

# The same run identity rides the Codex path — through the detached SessionEnd child.
rm -f "$OVDIR/state"/*.json
cat > "$TD/myproj/.leopold/state.json" <<'EOF'
{"active": true, "windows": 3, "max_windows": 4, "started_at": "2026-08-18T10:00:00.000Z"}
EOF
RUN_CX="{\"session_id\":\"r-cx\",\"transcript_path\":\"$ROLL\",\"cwd\":\"$TD/myproj\",\"hook_event_name\":\"SessionEnd\",\"reason\":\"other\"}"
engine session-end "$RUN_CX" >/dev/null
sleep 1
check "the Codex flush is tagged with its own engine" \
  "$(last_session_body | jq -r '.metadata.leopold.engine // empty')" "codex"

# A finished run is NOT the run any more: tag nothing.
cat > "$TD/myproj/.leopold/state.json" <<'EOF'
{"active": false, "stopped_reason": "plan_complete", "windows": 3, "started_at": "2026-08-18T10:00:00.000Z"}
EOF
rm -f "$OVDIR/state"/*.json
DONE_SE="{\"session_id\":\"r-3\",\"transcript_path\":\"$CLAUDE_T\",\"cwd\":\"$TD/myproj\",\"hook_event_name\":\"SessionEnd\",\"reason\":\"other\"}"
engine session-end "$DONE_SE" >/dev/null
check "a finished run's flush carries no tag" "$(last_session_body)" '{"session_id": "r-3"}'

# No .leopold/state.json at all: the request body is BYTE-identical to what every
# previous version sent — the backward-compatibility contract, asserted on the wire.
rm -f "$OVDIR/state"/*.json
NOSTATE_SE="{\"session_id\":\"r-4\",\"transcript_path\":\"$CLAUDE_T\",\"cwd\":\"$TD/proj\",\"hook_event_name\":\"SessionEnd\",\"reason\":\"other\"}"
engine session-end "$NOSTATE_SE" >/dev/null
check "no state file -> the /sessions body is byte-identical to today" \
  "$(last_session_body)" '{"session_id": "r-4"}'

echo
echo "ovmem extension — credential-shaped strings never reach the memory base"

# A transcript that happened to print credentials: what goes over the wire must be
# masked, and ordinary content — including a full git SHA — must arrive untouched.
CRED_T="$TD/claude/projects/p/cred.jsonl"
cat > "$CRED_T" <<'JSONL'
{"type":"user","message":{"role":"user","content":"my key is sk-proj-AAAAABBBBBCCCCCDDDDD1234 and commit 4c1a2b3d4e5f60718293a4b5c6d7e8f901234567 fixed it"}}
{"type":"assistant","message":{"role":"assistant","content":"Saw Authorization: Bearer abcdef1234567890ABCDEF and a JWT eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9P"}}
{"type":"user","message":{"role":"user","content":"config had api_key = 'ghp_AbCdEfGhIjKlMnOpQrStUvWx123456' and password: hunter2secret99"}}
JSONL
rm -f "$OVDIR/state"/*.json "$TD/stub.reqs"; : > "$TD/stub.reqs"
CRED_SE="{\"session_id\":\"r-cred\",\"transcript_path\":\"$CRED_T\",\"cwd\":\"$TD/proj\",\"hook_event_name\":\"SessionEnd\",\"reason\":\"other\"}"
engine session-end "$CRED_SE" >/dev/null
check "credential flush exits 0" "$?" "0"
batch="$(jq -r 'select(.path | contains("/messages/batch")) | .raw' "$TD/stub.reqs" | tail -1)"
hasnt "the OpenAI-style key never goes over the wire"   "$batch" "sk-proj-AAAAABBBBB"
hasnt "the bearer token never goes over the wire"       "$batch" "abcdef1234567890ABCDEF"
hasnt "the JWT never goes over the wire"                "$batch" "eyJhbGciOiJIUzI1NiJ9"
hasnt "the GitHub token never goes over the wire"       "$batch" "ghp_AbCdEfGh"
hasnt "the password value never goes over the wire"     "$batch" "hunter2secret99"
has   "masked content is marked, not dropped"           "$batch" "\[redacted\]"
has   "the surrounding sentence survives"               "$batch" "and commit"
has   "a full git SHA passes untouched"                 "$batch" "4c1a2b3d4e5f60718293a4b5c6d7e8f901234567"
has   "clean prose passes untouched"                    "$batch" "fixed it"

# OV server down mid-run: one log line per failed call, exit clean, session intact.
kill "$STUB_PID" 2>/dev/null; wait "$STUB_PID" 2>/dev/null
cat > "$TD/myproj/.leopold/state.json" <<'EOF'
{"active": true, "windows": 3, "max_windows": 4, "started_at": "2026-08-18T10:00:00.000Z"}
EOF
rm -f "$OVDIR/ovmem.log" "$OVDIR/state"/*.json
DOWN_SE="{\"session_id\":\"r-5\",\"transcript_path\":\"$CLAUDE_T\",\"cwd\":\"$TD/myproj\",\"hook_event_name\":\"SessionEnd\",\"reason\":\"other\"}"
out="$(OVMEM_DEBUG=1 engine session-end "$DOWN_SE")"
check "server down: the hook still exits 0"     "$?" "0"
check "server down: nothing leaks onto stdout"  "$out" ""
check "server down: the failed tag logs exactly once" \
  "$(grep -c 'api POST /sessions failed' "$OVDIR/ovmem.log" 2>/dev/null)" "1"

echo
echo "ovmem extension — remove unwires both harnesses"

run all remove >/dev/null
check "config.toml still parses after remove" "$(toml_ok "$CFG" && echo yes || echo no)" "yes"
check "no ovmem hooks left in config.toml"    "$(grep -c 'ovmem.py --event' "$CFG")" "0"
check "no managed ovmem block left"           "$(grep -c 'leopold:ovmem (managed)' "$CFG")" "0"
check "the user's own config key still there" "$(toml_get "$CFG" model)" "gpt-5"
check "no ovmem hooks left in settings.json"  "$(grep -c 'ovmem.py --event' "$SET")" "0"
check "settings.json still parses"            "$(jq -e . "$SET" >/dev/null 2>&1 && echo yes || echo no)" "yes"
check "the engine dir is gone"                "$( [ -e "$OVDIR" ] && echo yes || echo no )" "no"

echo
echo "ovmem extension — credentials never persist in config or wrapper"

# The installer's credential-store, conf and wrapper writers, extracted the same way
# ovmem_specs is: a change there that these tests do not follow fails loudly.
CRED_FNS="$TD/cred-fns.sh"
sed -n '/^cred_store_name()/,/^}/p;/^cred_put()/,/^}/p;/^cred_get()/,/^}/p;/^write_ov_conf()/,/^}/p;/^write_start_wrapper()/,/^}/p' \
  "$ROOT/extensions/ovmem/install.sh" > "$CRED_FNS"
check "the five credential functions extract whole" \
  "$(grep -c '^\(cred_store_name\|cred_put\|cred_get\|write_ov_conf\|write_start_wrapper\)()' "$CRED_FNS")" "5"

CRED_OUT="$(bash -c '
  set -uo pipefail
  TD="'"$TD"'"; mkdir -p "$TD/cred-home"
  SECRETS_ENV="$TD/cred-home/secrets.env"
  . "'"$CRED_FNS"'"
  cred_store_name() { echo file; }   # deterministic backend for the suite
  printf "%s" "sk-test-FAKECRED0001" | cred_put OPENAI_API_KEY
  echo "envperm=$(stat -c %a "$SECRETS_ENV" 2>/dev/null || stat -f %Lp "$SECRETS_ENV")"
  echo "get=$(cred_get OPENAI_API_KEY)"
  printf "%s" "sk-test-ROTATED0002" | cred_put OPENAI_API_KEY
  echo "rotated=$(cred_get OPENAI_API_KEY)"
  echo "lines=$(grep -c "^export OPENAI_API_KEY=" "$SECRETS_ENV")"

  OV_CONF="$TD/cred-home/ov.conf"; WORKSPACE="$TD/cred-home/data"
  ROOTKEY="rk-local-0003"; CHAT_MODEL="gpt-5-mini"; EMBED_MODEL="text-embedding-3-small"
  EMBED_DIM=1536; PROVIDER=openai
  write_ov_conf
  echo "confperm=$(stat -c %a "$OV_CONF" 2>/dev/null || stat -f %Lp "$OV_CONF")"
  echo "vlmkey=$(jq -r .vlm.api_key "$OV_CONF")"
  echo "embkey=$(jq -r .embedding.dense.api_key "$OV_CONF")"
  echo "rootkey=$(jq -r .server.root_api_key "$OV_CONF")"
  grep -q "sk-test" "$OV_CONF" && echo "conf-leak=yes" || echo "conf-leak=no"

  BIN="$TD/cred-home/bin"; AWS_REGION_V="us-east-1"; PROVIDER=bedrock
  write_start_wrapper
  echo "wrapperperm=$(stat -c %a "$BIN/openviking-start" 2>/dev/null || stat -f %Lp "$BIN/openviking-start")"
  bash -n "$BIN/openviking-start" && echo "wrapper-syntax=ok"
  grep -qE "AWS_BEARER_TOKEN_BEDROCK=." "$BIN/openviking-start" && echo "wrapper-token=yes" || echo "wrapper-token=no"
  grep -q "sk-test" "$BIN/openviking-start" && echo "wrapper-leak=yes" || echo "wrapper-leak=no"
  echo "region=$(grep -c "^export AWS_REGION=us-east-1$" "$BIN/openviking-start")"
  resolved="$(bash -c "curl(){ return 1; }; nohup(){ :; }; export -f curl nohup
    . \"$BIN/openviking-start\" >/dev/null 2>&1; printf %s \"\${OPENAI_API_KEY:-}\"")"
  echo "resolved=$resolved"
' 2>&1)"
has  "secrets env file is 0600"                        "$CRED_OUT" "envperm=600"
has  "the stored credential round-trips"               "$CRED_OUT" "get=sk-test-FAKECRED0001"
has  "storing again rotates, never appends"            "$CRED_OUT" "rotated=sk-test-ROTATED0002"
has  "one export line after rotation"                  "$CRED_OUT" "lines=1"
has  "ov.conf is 0600"                                 "$CRED_OUT" "confperm=600"
has  "vlm api_key is the env placeholder"              "$CRED_OUT" 'vlmkey=${OPENAI_API_KEY}'
has  "embedding api_key is the env placeholder"        "$CRED_OUT" 'embkey=${OPENAI_API_KEY}'
has  "the local root key stays literal for the hooks"  "$CRED_OUT" "rootkey=rk-local-0003"
has  "no credential material in ov.conf"               "$CRED_OUT" "conf-leak=no"
has  "wrapper is 0700"                                 "$CRED_OUT" "wrapperperm=700"
has  "wrapper parses"                                  "$CRED_OUT" "wrapper-syntax=ok"
has  "no bedrock token baked into the wrapper"         "$CRED_OUT" "wrapper-token=no"
has  "no credential material in the wrapper"           "$CRED_OUT" "wrapper-leak=no"
has  "the region (not a secret) still rides the wrapper" "$CRED_OUT" "region=1"
has  "wrapper resolves the credential at start time"   "$CRED_OUT" "resolved=sk-test-ROTATED0002"

echo
echo "ovmem extension — nothing escaped the temp dirs"
HOME="$REAL_HOME"
check "the real ~/.codex gained no new entries"      "$(real_codex_fp)"  "$CODEX_BEFORE"
check "the real ~/.claude gained no new entries"     "$(real_claude_fp)" "$CLAUDE_BEFORE"
check "the real ~/.openviking gained no new entries" "$(real_ov_fp)"     "$OV_BEFORE"

echo
if [ "$FAIL" -eq 0 ]; then
  printf '\033[32m%s passed, 0 failed\033[0m\n' "$PASS"
else
  printf '\033[31m%s passed, %s FAILED\033[0m\n' "$PASS" "$FAIL"
  exit 1
fi

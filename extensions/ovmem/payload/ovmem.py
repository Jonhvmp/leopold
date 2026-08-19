#!/usr/bin/env python3
"""
ovmem - autonomous RAG memory, on every harness Leopold runs on, backed by OpenViking.

Wires 4 native hooks to the OpenViking REST API (127.0.0.1:1933). The same four
events exist on Claude Code and on Codex CLI and the installer declares them in
both places (settings.json / config.toml) through the shared harness helper:

  SessionStart     -> rehydrate: session context + relevant long-term memory (find)
  UserPromptSubmit -> recall: inject memory relevant to the prompt
  PreCompact       -> flush: send the transcript delta to the OV session and commit
  SessionEnd       -> flush: same on session end, then maybe run the weekly cleanup

Two things genuinely differ between the harnesses, and both are handled here:

  1. The transcript. Claude Code writes one JSON object per message
     ({"type":"user"|"assistant","message":{...}}); Codex writes a rollout
     (session_meta / event_msg / response_item / turn_context lines) and carries the
     conversation as event_msg payloads of type user_message / agent_message.
     parse_transcript_delta reads both — see _msgs_claude / _msgs_codex.
  2. The injection envelope. Claude Code adds a hook's plain stdout to the context;
     Codex validates hook stdout against a strict JSON schema, so plain text makes
     the hook FAIL and nothing reaches the model. Verified on codex-cli 0.146.0:
     the text form logged "hook: SessionStart Failed" and the model answered "I
     don't know"; the {"hookSpecificOutput":{...,"additionalContext":...}} form
     logged "Completed" and the model read the block. See emit_context.

During an autonomous Leopold run the flush is run-aware: when <cwd>/.leopold/
state.json proves an active (or just-rolled) run, the OV session is created with a
title and metadata naming the project, the run's start stamp, the context window
number and the engine (claude|codex) — see leopold_run_tag. No state file means the
request body is byte-identical to what this hook has always sent.

Golden rule: NEVER break the session. On any error -> exit 0 with no stdout.
OpenViking does the reflection/distillation server-side on commit (the configured
VLM), so the hook never spends an LLM call of its own.

Usage:
  ovmem.py --event session-start|user-prompt|pre-compact|session-end   (reads hook JSON on stdin)

Env controls:
  OVMEM_DISABLE=1        turn everything off (no-op)
  OVMEM_DEBUG=1          log to <ovmem dir>/ovmem.log
  OVMEM_RECALL_LIMIT=5   max memories injected on recall (default 5)
  OVMEM_RECALL_SCORE=0.28 minimum score to inject (default 0.28)
  OVMEM_CHAR_BUDGET=2200 char cap on the injected block (default 2200)
  OVMEM_TIMEOUT=4        timeout (s) for calls on the critical path (default 4)
  LEOPOLD_OVMEM_DIR      data dir override (engine + state); see _resolve_ovmem_dir
  LEOPOLD_SDK_WORKER=1   set by the Leopold driver on every SDK session it spawns
                         (workers, reviewers, judges, hypotheses, routes); the
                         write path (pre-compact / session-end flush) is suppressed
                         there so a 30-item run does not create 30 OV sessions
  LEOPOLD_OVMEM_WORKER_FLUSH=1  the reversal: keep per-item worker flushes anyway
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
import urllib.parse
import urllib.error

HOME = os.path.expanduser("~")


def _resolve_ovmem_dir():
    """ONE data dir for the machine, whichever harness fired the hook.

    The memory is about the USER, not about the agent they happened to open: a
    decision recorded in a Codex session has to come back in a Claude Code one, and
    the per-session commit offsets under state/ must not be split in two or the
    same transcript gets committed twice.

    This mirrors leo_ovmem_dir() in extensions/lib/harness.sh EXACTLY. Keep the two
    in step — the installer resolves the dir with the bash one and the hook it wires
    resolves it again here at run time.
    """
    env = os.environ.get("LEOPOLD_OVMEM_DIR")
    if env:
        return env
    leo = os.environ.get("LEOPOLD_HOME")
    if leo:
        return os.path.join(leo, "ovmem")
    # Claude first at every step: an existing ~/.claude install is never migrated.
    claude = os.environ.get("CLAUDE_HOME") or os.path.join(HOME, ".claude")
    codex = os.environ.get("CODEX_HOME") or os.path.join(HOME, ".codex")
    for base in (claude, codex):
        if os.path.isdir(os.path.join(base, "ovmem")):
            return os.path.join(base, "ovmem")
    for base in (claude, codex):
        if os.path.isdir(base):
            return os.path.join(base, "ovmem")
    return os.path.join(claude, "ovmem")


OVMEM_DIR = _resolve_ovmem_dir()
STATE_DIR = os.path.join(OVMEM_DIR, "state")
LOG_PATH = os.path.join(OVMEM_DIR, "ovmem.log")
CONF_PATH = os.path.join(HOME, ".openviking", "ov.conf")

ACCOUNT = os.environ.get("OVMEM_ACCOUNT", "default")
USER = os.environ.get("OVMEM_USER", os.environ.get("USER", "default"))
# The OpenViking agent header. Deliberately ONE value on every harness: it namespaces
# the memory store, it is not a label for whoever is asking. Varying it per harness
# would split one user's memory in two and orphan everything an existing install has
# already written under "claude-code". Override with OVMEM_AGENT.
AGENT = os.environ.get("OVMEM_AGENT", "claude-code")


def log(msg):
    if os.environ.get("OVMEM_DEBUG") != "1":
        return
    try:
        os.makedirs(OVMEM_DIR, exist_ok=True)
        with open(LOG_PATH, "a") as f:
            f.write("[%s] %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg))
    except Exception:
        pass


def load_conf():
    host, port, key = "127.0.0.1", 1933, "ov-local-dev-key"
    try:
        with open(CONF_PATH) as f:
            c = json.load(f)
        srv = c.get("server", {})
        host = srv.get("host", host)
        port = srv.get("port", port)
        key = srv.get("root_api_key", key)
    except Exception as e:
        log("conf fallback: %s" % e)
    return host, int(port), key


HOST, PORT, API_KEY = load_conf()
BASE = "http://%s:%d/api/v1" % (HOST, PORT)


def api(method, path, body=None, params=None, timeout=None):
    """REST call. Returns the parsed JSON dict, or None on any failure."""
    if timeout is None:
        timeout = float(os.environ.get("OVMEM_TIMEOUT", "4"))
    url = BASE + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("x-api-key", API_KEY)
    req.add_header("X-OpenViking-Account", ACCOUNT)
    req.add_header("X-OpenViking-User", USER)
    req.add_header("X-OpenViking-Agent", AGENT)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except Exception as e:
        log("api %s %s failed: %s" % (method, path, e))
        return None


# ---------- state (transcript offset already committed) ----------

def state_path(session_id):
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in (session_id or "none"))
    return os.path.join(STATE_DIR, safe + ".json")


def read_state(session_id):
    try:
        with open(state_path(session_id)) as f:
            return json.load(f)
    except Exception:
        return {"lines": 0}


def write_state(session_id, st):
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        with open(state_path(session_id), "w") as f:
            json.dump(st, f)
    except Exception as e:
        log("write_state failed: %s" % e)


# ---------- transcript -> messages ----------

def extract_text(content):
    if content is None:
        return ""
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        out = []
        for block in content:
            if not isinstance(block, dict):
                continue
            t = block.get("type")
            if t == "text" and block.get("text"):
                out.append(block["text"])
            elif t == "tool_result":
                txt = extract_text(block.get("content"))
                if txt:
                    out.append("[tool_result] " + txt[:500])
        return "\n".join(out).strip()
    return ""


# ---------- credential masking ----------
# Credential-shaped strings never enter the memory base: whatever a session happened
# to print must not become a permanently recallable memory. Masking runs at ingest,
# on the one seam every reader's messages flow through. Patterns are prefix- or
# context-anchored so ordinary content (git SHAs, code, URLs) passes untouched.
_MASK = "[redacted]"
_CRED_PATTERNS = [
    re.compile(r"\bsk-[A-Za-z0-9_-]{16,}"),                # OpenAI-style (incl. sk-proj-/sk-ant-)
    re.compile(r"\bAKIA[A-Z0-9]{16}\b"),                   # AWS access key id
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}"),           # GitHub tokens
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}"),         # Slack
    re.compile(r"\bAIza[A-Za-z0-9_-]{30,}"),               # Google API key
    re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}"),  # JWT
    re.compile(r"(?i)\b(bearer\s+)[A-Za-z0-9._~+/=-]{16,}"),
    re.compile(r"(?i)\b((?:api[_-]?key|secret|token|passwd|password|credential|authorization)"
               r"[\"']?\s*[:=]\s*[\"']?)[^\s\"']{8,}"),
]


def mask_credentials(text):
    for pat in _CRED_PATTERNS:
        text = pat.sub(lambda m: (m.group(1) + _MASK) if m.groups() else _MASK, text)
    return text


def _msg_claude(obj):
    """One Claude Code transcript line -> {role, content}, or None.

    Shape: {"type":"user"|"assistant","message":{"role":...,"content":...}}.
    """
    if obj.get("type") not in ("user", "assistant"):
        return None
    message = obj.get("message") or {}
    role = message.get("role") or obj.get("type")
    if role not in ("user", "assistant"):
        return None
    text = extract_text(message.get("content"))
    return {"role": role, "content": text[:8000]} if text else None


def _msg_codex(obj):
    """One Codex CLI rollout line -> {role, content}, or None.

    Verified against codex-cli 0.146.0 rollouts. A rollout mixes four line types
    (session_meta / turn_context / event_msg / response_item); the conversation
    itself arrives as event_msg payloads:

      {"type":"event_msg","payload":{"type":"user_message","message":"..."}}
      {"type":"event_msg","payload":{"type":"agent_message","message":"..."}}

    We read THOSE and not the response_item messages on purpose. response_item
    replays the whole model input every turn — the developer preamble, the sandbox
    instructions and every earlier user turn again — so committing it would feed
    OpenViking the same text N times and distil the harness's own boilerplate into
    the user's long-term memory.
    """
    if obj.get("type") != "event_msg":
        return None
    payload = obj.get("payload") or {}
    ptype = payload.get("type")
    if ptype == "user_message":
        role = "user"
    elif ptype == "agent_message":
        role = "assistant"
    else:
        return None
    # `message` is a plain string here, but extract_text also accepts the block-list
    # form so a future rollout revision degrades to "no text", never to a crash.
    text = extract_text(payload.get("message"))
    return {"role": role, "content": text[:8000]} if text else None


def parse_transcript_delta(transcript_path, start_line):
    """Read the transcript jsonl from start_line on. Returns (messages, total_lines).

    Harness-agnostic: each line is offered to both readers and whichever one
    recognizes it wins. That is deliberately cheaper and safer than sniffing the
    harness up front — the two shapes are disjoint (Claude keys on a top-level
    "type" of user/assistant, Codex on "event_msg"), so a line can never be read
    twice, and a transcript this build has never seen simply yields nothing
    instead of raising inside a hook.
    """
    msgs = []
    if not transcript_path or not os.path.exists(transcript_path):
        return msgs, start_line
    try:
        with open(transcript_path) as f:
            lines = f.readlines()
    except Exception as e:
        log("transcript read failed: %s" % e)
        return msgs, start_line
    total = len(lines)
    # if the file shrank (rewritten on compaction), start over from the top
    begin = start_line if start_line <= total else 0
    for raw in lines[begin:]:
        raw = raw.strip()
        if not raw:
            continue
        try:
            obj = json.loads(raw)
        except Exception:
            continue
        if not isinstance(obj, dict):
            continue
        m = _msg_claude(obj) or _msg_codex(obj)
        if m:
            m["content"] = mask_credentials(m["content"])
            msgs.append(m)
    return msgs, total


# ---------- recall formatting ----------

def collect_hits(result):
    if not result:
        return []
    r = result.get("result") or {}
    hits = []
    for key in ("memories", "resources", "skills"):
        for x in (r.get(key) or []):
            hits.append(x)
    return hits


def format_recall(hits, header):
    """Returns (block_text, picked_uris)."""
    limit = int(os.environ.get("OVMEM_RECALL_LIMIT", "5"))
    min_score = float(os.environ.get("OVMEM_RECALL_SCORE", "0.28"))
    budget = int(os.environ.get("OVMEM_CHAR_BUDGET", "2200"))
    picked = []
    picked_uris = []
    seen = set()
    for h in sorted(hits, key=lambda x: x.get("score", 0), reverse=True):
        uri = h.get("uri", "")
        if uri in seen:
            continue
        if h.get("score", 0) < min_score:
            continue
        text = (h.get("overview") or h.get("abstract") or "").strip()
        # skip descriptor/derived files (.overview.md, .abstract.md, .profile.md, ...):
        # they describe the schema, not actual memory content
        nm = uri.rstrip("/").split("/")[-1]
        if nm.startswith("."):
            continue
        if not text:
            continue
        seen.add(uri)
        picked.append("- (%.2f) %s\n  %s" % (h.get("score", 0), uri, text[:400]))
        picked_uris.append(uri)
        if len(picked) >= limit:
            break
    if not picked:
        return "", []
    block = header + "\n" + "\n".join(picked)
    return block[:budget], picked_uris


def harness_of(data):
    """Which agent fired this hook: 'codex' or 'claude'.

    The payload keys are nearly identical on both (session_id / transcript_path /
    cwd / hook_event_name / source), so the transcript itself is the tell:

      Codex CLI    <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl, whose first
                   line is a `session_meta` record
      Claude Code  ~/.claude/projects/<slug>/<uuid>.jsonl

    Both signals are checked because each can be absent on its own: turn_id only
    rides UserPromptSubmit, and the rollout file does not exist yet when the very
    first SessionStart fires. Verified against codex-cli 0.146.0 hook payloads.
    """
    if data.get("turn_id"):
        return "codex"
    tp = data.get("transcript_path") or ""
    if os.path.basename(tp).startswith("rollout-"):
        return "codex"
    try:
        with open(tp) as f:
            if '"session_meta"' in f.readline():
                return "codex"
    except Exception:
        pass
    return "claude"


# Which hook event name each harness expects back in a hookSpecificOutput envelope.
_HOOK_EVENT_NAME = {"session-start": "SessionStart", "user-prompt": "UserPromptSubmit"}


def emit_context(text, harness="claude", event="user-prompt"):
    """Inject text into the model's context (SessionStart / UserPromptSubmit).

    Claude Code adds a hook's plain stdout to the context for those two events, and
    plain text is what Leopold has always emitted there: another hook may run on the
    same event (e.g. skill-activator) and the stdouts get concatenated — text
    survives concatenation, JSON would not. That path is unchanged.

    Codex CLI validates hook stdout against a strict JSON schema instead. Verified
    on codex-cli 0.146.0 with a real session: the plain-text form logged
    "hook: SessionStart Failed" and the model answered "I don't know", while the
    envelope below logged "Completed" and the model read the injected block back.
    Same content, two envelopes — emitting text here would be a silent no-op.
    """
    if not text:
        return
    block = "\n[ovmem - long-term memory (OpenViking)]\n" + text + "\n"
    if harness == "codex":
        json.dump({"hookSpecificOutput": {
            "hookEventName": _HOOK_EVENT_NAME.get(event, "UserPromptSubmit"),
            "additionalContext": block}}, sys.stdout)
        sys.stdout.write("\n")
    else:
        sys.stdout.write(block)


# ---------- handlers ----------

def ensure_server():
    """Make sure the OpenViking server is up (auto-bootstrap). Best-effort, non-blocking.

    Quick health check; if it's down, fire openviking-start detached and move on.
    Whoever starts first pays the boot; the following prompts already find it up.
    """
    try:
        with urllib.request.urlopen("http://%s:%d/health" % (HOST, PORT), timeout=1) as r:
            if json.loads(r.read().decode()).get("healthy"):
                return
    except Exception:
        pass
    starter = os.path.join(HOME, ".local", "bin", "openviking-start")
    if not os.path.exists(starter):
        return
    try:
        subprocess.Popen(["bash", starter],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         stdin=subprocess.DEVNULL, start_new_session=True)
        log("ensure_server: launched openviking-start")
    except Exception as e:
        log("ensure_server failed: %s" % e)


def ensure_session(session_id, tag=None):
    """Create/refresh the OV session. `tag` (from leopold_run_tag) adds run
    identity — title + metadata — on top of the bare body; with no tag the body is
    byte-identical to what every previous version sent."""
    body = {"session_id": session_id}
    if tag:
        body.update(tag)
    api("POST", "/sessions", body=body)


def record_access(uris):
    """Record local access (frequency + recency) to feed the cleanup hotness score.

    Independent of OpenViking's active_count - which does not increment reliably via
    the REST `used` endpoint in this version. We keep our own signal: every memory the
    recall injects becomes 'hot'; whatever never shows up cools down and gets archived
    by ovmem-cleanup. Local, no network.
    """
    uris = [u for u in (uris or []) if u]
    if not uris:
        return
    path = os.path.join(STATE_DIR, "access.json")
    try:
        data = {}
        if os.path.exists(path):
            with open(path) as f:
                data = json.load(f)
        now = int(time.time())
        for u in uris:
            e = data.get(u) or {"n": 0, "t": 0}
            e["n"] = int(e.get("n", 0)) + 1
            e["t"] = now
            data[u] = e
        os.makedirs(STATE_DIR, exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(data, f)
        os.replace(tmp, path)
        log("access: recorded %d uri(s)" % len(uris))
    except Exception as e:
        log("record_access failed: %s" % e)


def maybe_run_cleanup():
    """Fire the hotness cleanup at most once a week (detached, non-blocking)."""
    marker = os.path.join(STATE_DIR, "last_cleanup")
    try:
        if os.path.exists(marker) and (time.time() - os.path.getmtime(marker)) < 7 * 86400:
            return
    except Exception:
        pass
    script = os.path.join(OVMEM_DIR, "ovmem-cleanup.py")
    if not os.path.exists(script):
        return
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        open(marker, "w").close()  # touch the timestamp BEFORE, to avoid re-entrancy
        subprocess.Popen([sys.executable, script, "--apply"],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         stdin=subprocess.DEVNULL, start_new_session=True)
        log("cleanup: launched (weekly prune)")
    except Exception as e:
        log("cleanup trigger failed: %s" % e)


def handle_session_start(data):
    ensure_server()
    session_id = data.get("session_id")
    source = data.get("source", "startup")
    cwd = data.get("cwd") or os.getcwd()
    project = os.path.basename(cwd.rstrip("/")) or "project"
    parts = []

    # 1) managed context of this same session (resume/compact)
    if source in ("resume", "compact") and session_id:
        ctx = api("GET", "/sessions/%s/context" % urllib.parse.quote(session_id),
                  params={"token_budget": 1200}, timeout=5)
        ov = ((ctx or {}).get("result") or {}).get("latest_archive_overview") or ""
        if ov:
            parts.append("Previous session summary (OpenViking):\n" + ov[:900])

    # 2) long-term memory + episodes relevant to the project
    q = "context, decisions, preferences and tasks for the project %s" % project
    res = api("POST", "/search/find",
              body={"query": q, "target_uri": ["viking://user/", "viking://session/"], "limit": 6}, timeout=6)
    recall, used = format_recall(collect_hits(res), "Relevant long-term memory (OpenViking):")
    if recall:
        parts.append(recall)

    if parts:
        emit_context("\n\n".join(parts) +
                     "\n\n(Treat these memories as ground truth for context. Do not reopen decisions already settled.)",
                     harness_of(data), "session-start")
    record_access(used)
    log("session-start source=%s parts=%d" % (source, len(parts)))


def handle_user_prompt(data):
    prompt = (data.get("prompt") or "").strip()
    if not prompt or prompt.startswith("/") or len(prompt) < 8:
        return
    res = api("POST", "/search/find",
              body={"query": prompt, "target_uri": ["viking://user/", "viking://session/"], "limit": 6}, timeout=4)
    recall, used = format_recall(collect_hits(res), "Relevant memory for this request (OpenViking):")
    if recall:
        emit_context(recall, harness_of(data), "user-prompt")
        record_access(used)
    log("user-prompt recall=%s" % bool(recall))


def leopold_run_tag(data):
    """Run identity for this flush, read from <cwd>/.leopold/state.json — or None.

    TAG, NEVER GUESS: a flush is run-aware only when the state file PROVES a run.
    Two states qualify:

      active: true                        a live window of an autonomous run
      stopped_reason: "context_budget"    a rolled window — 0.18.0 marks the state
                                          inactive at the roll boundary, and the
                                          SessionEnd flush fires exactly in that gap
                                          before the relaunch

    Anything else — no file, unreadable JSON, a run that finished or died — returns
    None and the flush body stays byte-identical to an untagged one. The tag is
    extra fields on the POST /sessions body (title + metadata); an old OpenViking
    server ignores unknown fields, so this is additive by construction. Never
    raises: memory is enrichment, not a dependency.
    """
    cwd = data.get("cwd") or os.getcwd()
    try:
        with open(os.path.join(cwd, ".leopold", "state.json")) as f:
            st = json.load(f)
    except Exception:
        return None
    if not isinstance(st, dict):
        return None
    if st.get("active") is not True and st.get("stopped_reason") != "context_budget":
        return None
    # A rolled-but-abandoned run must not tag forever. The roll gap is minutes wide
    # (SessionEnd fires, the watcher relaunches); a state.json still saying
    # context_budget WEEKS later is a run nobody resumed, and tagging an ordinary
    # interactive session with its window number is misattributed memory — the exact
    # thing the tag exists to prevent. Same 10-minute staleness line the watcher's
    # relaunch draws (CONTINUITY_FRESH_SECS) and the run skill draws for takeover:
    # stale state is not an event, and it is not a tag either. A live run
    # (active: true) is never staleness-checked — its own turns keep it current.
    if st.get("active") is not True:
        last = str(st.get("last_turn") or "")
        try:
            import calendar
            age = time.time() - calendar.timegm(time.strptime(last, "%Y-%m-%dT%H:%M:%SZ"))
        except Exception:
            try:
                age = time.time() - os.path.getmtime(os.path.join(cwd, ".leopold", "state.json"))
            except OSError:
                return None
        if age > 600:
            return None
    project = os.path.basename(cwd.rstrip("/")) or "project"
    started = str(st.get("started_at") or "")
    stamp = started[:10].replace("-", "") or "unknown"
    window = st.get("windows")
    if not isinstance(window, int) or window < 1:
        window = 1
    maxw = st.get("max_windows")
    win = "window %d" % window
    if isinstance(maxw, int) and maxw >= window:
        win += " of %d" % maxw
    engine = harness_of(data)
    return {
        "title": "leopold · %s · run %s · %s · %s" % (project, stamp, win, engine),
        "metadata": {"leopold": {
            "project": project,
            "run_started_at": started,
            "window": window,
            "engine": engine,
        }},
    }


def detach_flush(data, why):
    """Run the flush in a detached child and return immediately. Returns True when
    the child was launched.

    Codex CLI hard-caps a SessionEnd hook at 3 seconds — verified on codex-cli
    0.146.0, which prints `clamping SessionEnd hook timeout to 3s` for anything
    higher. Batching a long transcript plus the commit does not reliably fit in
    three seconds, and a killed hook means the whole session is never distilled
    into memory: the one thing ovmem exists to do. So on that one event we hand the
    work to a child that outlives the kill, exactly like the weekly cleanup already
    does. Claude Code's 25s SessionEnd is honored in-process, unchanged.
    """
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        path = os.path.join(STATE_DIR, "flush-%d.json" % os.getpid())
        with open(path, "w") as f:
            json.dump(data, f)
        subprocess.Popen([sys.executable, os.path.abspath(__file__),
                          "--event", "flush-detached", "--payload", path, "--why", why],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         stdin=subprocess.DEVNULL, start_new_session=True)
        log("%s: handed the flush to a detached child (%s)" % (why, path))
        return True
    except Exception as e:
        log("detach_flush failed: %s" % e)
        return False


def worker_flush_suppressed():
    """True when this hook runs inside a Leopold-driver-spawned SDK session and
    per-item flushes are suppressed (the default there).

    The driver spawns ephemeral SDK sessions — one worker per plan item, plus review
    lenses, tournament judges, hypotheses and route probes — each its own session
    with its own session_id, all marked at the driver's one query seam (sdk.ts) —
    verified live (docs/reference/sdk-worker-hooks.md): all four hooks fire per
    session and inherit the driver's environment. Flushing each one would dump an
    untagged OV session per spawn into the memory base; the conductor's session
    carries the run, so driver spawns stay silent. Reversal: set
    LEOPOLD_OVMEM_WORKER_FLUSH=1 on the driver to restore per-item flushes.
    """
    return (os.environ.get("LEOPOLD_SDK_WORKER") == "1"
            and os.environ.get("LEOPOLD_OVMEM_WORKER_FLUSH") != "1")


def flush_and_commit(data, why):
    session_id = data.get("session_id")
    if not session_id:
        return
    transcript = data.get("transcript_path")
    st = read_state(session_id)
    msgs, total = parse_transcript_delta(transcript, st.get("lines", 0))
    if not msgs:
        log("%s: no delta (total=%d offset=%d)" % (why, total, st.get("lines", 0)))
        return
    tag = leopold_run_tag(data)
    if tag:
        log("%s: run-aware flush — %s" % (why, tag["title"]))
    ensure_session(session_id, tag)
    # OpenViking accepts batches; send in chunks of 50
    for i in range(0, len(msgs), 50):
        chunk = msgs[i:i + 50]
        api("POST", "/sessions/%s/messages/batch" % urllib.parse.quote(session_id),
            body={"messages": chunk}, timeout=15)
    # async commit (distills into long-term memory)
    api("POST", "/sessions/%s/commit" % urllib.parse.quote(session_id),
        body={"keep_recent_count": 0}, timeout=20)
    write_state(session_id, {"lines": total})
    log("%s: committed %d msgs (total=%d)" % (why, len(msgs), total))


def arg(name):
    for i, a in enumerate(sys.argv):
        if a == name and i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return None


def main():
    global EVENT
    EVENT = arg("--event")
    if os.environ.get("OVMEM_DISABLE") == "1" or not EVENT:
        return

    # The detached SessionEnd worker: payload on disk, not on stdin, because its
    # parent is already gone by the time it runs.
    if EVENT == "flush-detached":
        path = arg("--payload")
        try:
            with open(path) as f:
                data = json.load(f)
        except Exception as e:
            log("flush-detached: unreadable payload %s: %s" % (path, e))
            return
        try:
            flush_and_commit(data, arg("--why") or "session-end")
        except Exception as e:
            log("flush-detached error: %s" % e)
        finally:
            try:
                os.remove(path)
            except Exception:
                pass
        return

    try:
        raw = sys.stdin.read()
        data = json.loads(raw) if raw.strip() else {}
    except Exception as e:
        log("stdin parse failed: %s" % e)
        data = {}
    try:
        if EVENT == "session-start":
            handle_session_start(data)
        elif EVENT == "user-prompt":
            handle_user_prompt(data)
        elif EVENT == "pre-compact":
            if worker_flush_suppressed():
                log("pre-compact: sdk-worker flush suppressed "
                    "(LEOPOLD_OVMEM_WORKER_FLUSH=1 restores per-item flushes)")
            else:
                flush_and_commit(data, "pre-compact")
        elif EVENT == "session-end":
            if worker_flush_suppressed():
                log("session-end: sdk-worker flush suppressed "
                    "(LEOPOLD_OVMEM_WORKER_FLUSH=1 restores per-item flushes)")
                return
            # Codex kills this hook at 3s; hand it off rather than get cut in half.
            if harness_of(data) != "codex" or not detach_flush(data, "session-end"):
                flush_and_commit(data, "session-end")
            maybe_run_cleanup()
    except Exception as e:
        log("handler %s error: %s" % (EVENT, e))


if __name__ == "__main__":
    main()

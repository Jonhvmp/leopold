#!/usr/bin/env python3
"""
ovmem - autonomous RAG memory for Claude Code, backed by OpenViking.

Wires 4 native Claude Code hooks to the OpenViking REST API (127.0.0.1:1933):

  SessionStart     -> rehydrate: session context + relevant long-term memory (find)
  UserPromptSubmit -> recall: inject memory relevant to the prompt
  PreCompact       -> flush: send the transcript delta to the OV session and commit
  SessionEnd       -> flush: same on session end, then maybe run the weekly cleanup

Golden rule: NEVER break the session. On any error -> exit 0 with no stdout.
OpenViking does the reflection/distillation server-side on commit (the configured
VLM), so the hook never spends an LLM call of its own.

Usage:
  ovmem.py --event session-start|user-prompt|pre-compact|session-end   (reads hook JSON on stdin)

Env controls:
  OVMEM_DISABLE=1        turn everything off (no-op)
  OVMEM_DEBUG=1          log to ~/.claude/ovmem/ovmem.log
  OVMEM_RECALL_LIMIT=5   max memories injected on recall (default 5)
  OVMEM_RECALL_SCORE=0.28 minimum score to inject (default 0.28)
  OVMEM_CHAR_BUDGET=2200 char cap on the injected block (default 2200)
  OVMEM_TIMEOUT=4        timeout (s) for calls on the critical path (default 4)
"""
import json
import os
import subprocess
import sys
import time
import urllib.request
import urllib.parse
import urllib.error

HOME = os.path.expanduser("~")
OVMEM_DIR = os.path.join(HOME, ".claude", "ovmem")
STATE_DIR = os.path.join(OVMEM_DIR, "state")
LOG_PATH = os.path.join(OVMEM_DIR, "ovmem.log")
CONF_PATH = os.path.join(HOME, ".openviking", "ov.conf")

ACCOUNT = os.environ.get("OVMEM_ACCOUNT", "default")
USER = os.environ.get("OVMEM_USER", os.environ.get("USER", "default"))
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


def parse_transcript_delta(transcript_path, start_line):
    """Read the transcript jsonl from start_line on. Returns (messages, total_lines)."""
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
        if obj.get("type") not in ("user", "assistant"):
            continue
        message = obj.get("message") or {}
        role = message.get("role") or obj.get("type")
        if role not in ("user", "assistant"):
            continue
        text = extract_text(message.get("content"))
        if not text:
            continue
        msgs.append({"role": role, "content": text[:8000]})
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


def emit_context(text):
    """Inject text into the model's context (SessionStart / UserPromptSubmit).

    Plain text on stdout is added to the context for those two events. We use
    plain text (not a JSON hookSpecificOutput) because another hook may run on
    the same event (e.g. skill-activator) and the stdouts get concatenated -
    plain text survives concatenation; JSON would break.
    """
    if not text:
        return
    sys.stdout.write("\n[ovmem - long-term memory (OpenViking)]\n" + text + "\n")


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


def ensure_session(session_id):
    api("POST", "/sessions", body={"session_id": session_id})


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
                     "\n\n(Treat these memories as ground truth for context. Do not reopen decisions already settled.)")
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
        emit_context(recall)
        record_access(used)
    log("user-prompt recall=%s" % bool(recall))


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
    ensure_session(session_id)
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


def main():
    global EVENT
    EVENT = None
    for i, a in enumerate(sys.argv):
        if a == "--event" and i + 1 < len(sys.argv):
            EVENT = sys.argv[i + 1]
    if os.environ.get("OVMEM_DISABLE") == "1" or not EVENT:
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
            flush_and_commit(data, "pre-compact")
        elif EVENT == "session-end":
            flush_and_commit(data, "session-end")
            maybe_run_cleanup()
    except Exception as e:
        log("handler %s error: %s" % (EVENT, e))


if __name__ == "__main__":
    main()

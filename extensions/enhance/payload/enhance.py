#!/usr/bin/env python3
"""
leopold-enhance - global prompt enhancer for Claude Code.

A UserPromptSubmit hook. When the user's prompt is weak (short, vague, unanchored),
it calls `claude -p --model haiku` headless (the user's own connected account) to
produce a structured interpretation - Objective / Context / Constraints / Done when /
Assumptions - and injects it as plain-text context next to the raw prompt. The raw
prompt is never replaced; the injected block ends with "THE RAW PROMPT WINS".

Charter-aware: if the project has .leopold/CHARTER.md (or MISSION.md), an excerpt
feeds the rewriter, so the interpretation reads the prompt the way THIS user would.
Self-learning: every injection is logged to a ledger that /leopold-enhance learn
mines for corrections, proposing amendments to ~/.claude/enhance/PROMPT-PROFILE.md.

Golden rule (same as ovmem): NEVER break the session. On any error -> exit 0, no stdout.

Usage:
  enhance.py --event user-prompt          (the hook; reads hook JSON on stdin)
  enhance.py --event preview "TEXT"       (dry-run: gate verdict + would-be injection; no ledger)
  enhance.py --event probe                (test --safe-mode availability, update state.json)
  enhance.py --event toggle [on|off]      (flip/set enabled in state.json)
  enhance.py --event status               (one-line status for manage.sh / the menu)

Env controls:
  LEOPOLD_ENHANCE_ACTIVE=1      recursion guard - set by our own subprocess, makes the hook a no-op
  LEOPOLD_ENHANCE_DISABLE=1     kill switch (no-op while staying wired)
  LEOPOLD_ENHANCE_DEBUG=1       log to ~/.claude/enhance/enhance.log
  LEOPOLD_ENHANCE_CLAUDE_BIN    claude binary override (tests use a stub)
  LEOPOLD_ENHANCE_MIN_SCORE     weak-prompt score needed to enhance (default 4)
  LEOPOLD_ENHANCE_MAX_WORDS     prompts longer than this are skipped (default 60)
  LEOPOLD_ENHANCE_COOLDOWN_S    min seconds between enhancements per session (default 120)
  LEOPOLD_ENHANCE_TIMEOUT_S     subprocess budget for the claude call (default 25)
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time

CLAUDE_HOME = os.environ.get("CLAUDE_HOME") or os.path.join(os.path.expanduser("~"), ".claude")
ENHANCE_DIR = os.path.join(CLAUDE_HOME, "enhance")
STATE_PATH = os.path.join(ENHANCE_DIR, "state.json")
PROFILE_PATH = os.path.join(ENHANCE_DIR, "PROMPT-PROFILE.md")
LEDGER_PATH = os.path.join(ENHANCE_DIR, "enhancements.jsonl")
SESSIONS_DIR = os.path.join(ENHANCE_DIR, "sessions")
LOG_PATH = os.path.join(ENHANCE_DIR, "enhance.log")

LEDGER_MAX_BYTES = 2 * 1024 * 1024  # rotate at 2 MB, keep one generation

MARKER = "[leopold-enhance"
FOOTER = ("Rule: this is a machine interpretation to help you plan. "
          "If it conflicts with the user's raw prompt, THE RAW PROMPT WINS.")

# Short acknowledgments (EN + PT) that must never be enhanced. Length alone does not
# skip - "fix login bug" is 3 words and is exactly the target.
ACKS = {
    "y", "n", "yes", "no", "ok", "okay", "sim", "nao", "não", "continue", "continua",
    "segue", "vai", "go", "stop", "para", "pare", "thanks", "obrigado", "valeu",
    "why", "how", "como", "huh", "what", "que", "isso", "this", "that", "certo",
    "right", "beleza", "blz", "top", "boa", "good", "nice", "done", "pronto",
    "option", "opcao", "opção", "a", "b", "c", "d",
}
ACKS.update(str(i) for i in range(10))

VAGUE_OPENERS = {
    "fix", "arruma", "arrumar", "conserta", "consertar", "melhora", "melhorar",
    "improve", "make", "add", "adiciona", "adicionar", "cria", "criar", "create",
    "faz", "faca", "faça", "fazer", "refactor", "refatora", "refatorar", "update",
    "atualiza", "atualizar", "muda", "mudar", "change", "otimiza", "otimizar",
    "optimize", "limpa", "limpar", "clean", "ajuda", "help", "do", "resolve",
    "resolver", "corrige", "corrigir",
}

CODE_EXT_RE = re.compile(
    r"\.(py|ts|tsx|js|jsx|mjs|sh|bash|md|json|jsonl|go|rs|css|scss|html|yml|yaml"
    r"|toml|sql|java|rb|php|c|h|cpp|hpp|vue|svelte|lock|env|cfg|ini|txt)\b")
IDENT_RE = re.compile(r"\b(?:[a-z]+[A-Z][A-Za-z]*|[A-Z][a-z]+[A-Z][A-Za-z]*|[A-Za-z]+_[A-Za-z_]+)\b")
BULLET_RE = re.compile(r"(?m)^\s*(?:[-*•]|\d+[.)])\s")


def log(msg):
    if os.environ.get("LEOPOLD_ENHANCE_DEBUG") != "1":
        return
    try:
        os.makedirs(ENHANCE_DIR, exist_ok=True)
        with open(LOG_PATH, "a") as f:
            f.write("[%s] %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg))
    except Exception:
        pass


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _int_env(name, default):
    try:
        return int(os.environ[name])
    except Exception:
        return default


# ---------- state ----------

DEFAULT_THRESHOLDS = {"min_score": 4, "max_words": 60, "cooldown_s": 120, "max_inject_chars": 1200}


def default_state(enabled=False):
    return {
        "enabled": enabled,
        "model": "haiku",
        # --safe-mode keeps the user's OAuth login but skips hooks/plugins/MCP/
        # CLAUDE.md in the subprocess: ~half the latency AND structural recursion
        # safety. Old CLIs without the flag self-heal to normal mode (note_result).
        "safe_mode": True,
        "probed_at": None,
        "thresholds": dict(DEFAULT_THRESHOLDS),
        "subprocess_timeout_s": 25,
        "consecutive_failures": 0,
    }


def load_state():
    try:
        with open(STATE_PATH) as f:
            st = json.load(f)
        if not isinstance(st, dict):
            return None
        th = st.get("thresholds")
        st["thresholds"] = dict(DEFAULT_THRESHOLDS, **(th if isinstance(th, dict) else {}))
        return st
    except Exception as e:
        log("state load failed: %s" % e)
        return None


def save_state(st):
    try:
        os.makedirs(ENHANCE_DIR, exist_ok=True)
        tmp = STATE_PATH + ".tmp"
        with open(tmp, "w") as f:
            json.dump(st, f, indent=2)
        os.replace(tmp, STATE_PATH)
    except Exception as e:
        log("state save failed: %s" % e)


def threshold(st, key, env):
    return _int_env(env, int(st["thresholds"].get(key, DEFAULT_THRESHOLDS[key])))


# ---------- gate ----------

def gate(prompt, st):
    """Score how weak the prompt is. Returns (score, signals).

    False positives are the UX killer: enhancing a good prompt wastes seconds and
    adds noise. So the score demands multiple independent weakness signals, and one
    strong anchor (a path, a symbol) is enough to veto.
    """
    words = prompt.split()
    n = len(words)
    signals = {"short": 0, "structure": 0, "anchor": 0, "vague": 0, "question": 0}

    # acks are already skipped, so a 1-3 word prompt here ("fix login") is a target
    if n <= 25:
        signals["short"] = 2
    elif n <= threshold(st, "max_words", "LEOPOLD_ENHANCE_MAX_WORDS"):
        signals["short"] = 1

    if "\n" not in prompt and not BULLET_RE.search(prompt):
        signals["structure"] = 1

    # an anchor (path, extension, `symbol`, identifier) gives the model a concrete
    # starting point - it VETOES, outweighing a vague opener on the same prompt
    anchored = (
        any("/" in w and len(w) > 2 for w in words)
        or CODE_EXT_RE.search(prompt)
        or "`" in prompt
        or any(len(m) >= 6 for m in IDENT_RE.findall(prompt))
    )
    signals["anchor"] = -2 if anchored else 1

    first = words[0].lower().strip(",.:;!") if words else ""
    if first in VAGUE_OPENERS and n < 15:
        signals["vague"] = 1

    if prompt.rstrip().endswith("?") and n >= 8:
        signals["question"] = -2

    return sum(signals.values()), signals


def is_ack(prompt):
    words = prompt.split()
    if len(words) > 3:
        return False
    if not re.search(r"[A-Za-zÀ-ÿ]", prompt):
        return True  # "2", "1)", "!!" - no letters at all
    return all(w.lower().strip(",.:;!?)") in ACKS for w in words)


def leopold_run_active(cwd):
    try:
        with open(os.path.join(cwd, ".leopold", "state.json")) as f:
            return json.load(f).get("active") is True
    except Exception:
        return False


# ---------- cooldown ----------

def _stamp_path(session_id):
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in (session_id or "none"))
    return os.path.join(SESSIONS_DIR, safe + ".json")


def in_cooldown(session_id, st):
    try:
        with open(_stamp_path(session_id)) as f:
            last = json.load(f).get("t", 0)
        return (time.time() - last) < threshold(st, "cooldown_s", "LEOPOLD_ENHANCE_COOLDOWN_S")
    except Exception:
        return False


def stamp_cooldown(session_id):
    try:
        os.makedirs(SESSIONS_DIR, exist_ok=True)
        with open(_stamp_path(session_id), "w") as f:
            json.dump({"t": time.time()}, f)
        # prune stale stamps so the dir never grows unbounded
        cutoff = time.time() - 2 * 86400
        for name in os.listdir(SESSIONS_DIR):
            p = os.path.join(SESSIONS_DIR, name)
            if os.path.getmtime(p) < cutoff:
                os.unlink(p)
    except Exception as e:
        log("stamp failed: %s" % e)


# ---------- rewriter context ----------

def read_capped(path, cap):
    try:
        with open(path) as f:
            return f.read(cap).strip()
    except Exception:
        return ""


def extract_text(content):
    if content is None:
        return ""
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        out = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text" and block.get("text"):
                out.append(block["text"])
        return "\n".join(out).strip()
    return ""


def transcript_tail(transcript_path, max_msgs=4, cap=1500):
    """Last few user/assistant messages - headless Haiku can't see the conversation,
    and without this a follow-up like 'now do the same for logout' would be
    interpreted in a vacuum (the top hallucination risk of the whole feature)."""
    if not transcript_path or not os.path.exists(transcript_path):
        return ""
    try:
        with open(transcript_path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - 256 * 1024))
            raw_lines = f.read().decode("utf-8", "replace").splitlines()
    except Exception as e:
        log("transcript read failed: %s" % e)
        return ""
    msgs = []
    for raw in raw_lines[-80:]:
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
        text = extract_text(message.get("content"))
        if text:
            msgs.append("%s: %s" % (message.get("role") or obj["type"], text[:400]))
    if not msgs:
        return ""
    return "\n".join(msgs[-max_msgs:])[:cap]


def build_payload(prompt, cwd, transcript_path):
    """One stdin payload for the rewriter (stdin, not argv - no quoting/length issues)."""
    parts = [
        "You are a prompt interpreter for a coding assistant. A user typed a quick, "
        "underspecified prompt. Produce a structured interpretation that helps the "
        "assistant plan - do NOT answer or execute the prompt itself.",
        "Output ONLY these five labeled lines, nothing else, total under 120 words. "
        "Keep the labels in English; write the content in the SAME LANGUAGE as the "
        "RAW PROMPT (mirror it exactly - if it is Portuguese, answer in Portuguese):",
        "Objective: <the concrete goal>\n"
        "Context: <what in the conversation/project this refers to>\n"
        "Constraints: <implied limits: scope, style, what NOT to touch>\n"
        "Done when: <a verifiable completion criterion>\n"
        "Assumptions: <what you had to assume; flag anything ambiguous>",
    ]
    charter = read_capped(os.path.join(cwd, ".leopold", "CHARTER.md"), 4000) if cwd else ""
    if not charter and cwd:
        charter = read_capped(os.path.join(cwd, ".leopold", "MISSION.md"), 4000)
    if charter:
        parts.append("The user's decision charter for this project (interpret the "
                     "prompt the way this person would):\n" + charter)
    profile = read_capped(PROFILE_PATH, 2000)
    # the seeded profile is only a header; ignore it until it has real rules
    if profile and "- " in profile:
        parts.append("The user's learned prompt-style rules:\n" + profile)
    tail = transcript_tail(transcript_path)
    if tail:
        parts.append("The last exchanges of the conversation (for references like "
                     "'the same', 'that file'):\n" + tail)
    parts.append("RAW PROMPT:\n" + prompt)
    return "\n\n---\n\n".join(parts), bool(charter), bool(profile and "- " in profile), bool(tail)


# ---------- the claude call ----------

def find_claude():
    for cand in (
        os.environ.get("LEOPOLD_ENHANCE_CLAUDE_BIN"),
        shutil.which("claude"),
        os.path.join(os.path.expanduser("~"), ".local", "bin", "claude"),
        os.path.join(os.path.expanduser("~"), ".claude", "local", "claude"),
    ):
        if cand and os.path.exists(cand) and os.access(cand, os.X_OK):
            return cand
    return None


def call_claude(payload, st, safe_mode):
    """Returns (body, error). Fail-open: every failure comes back as (None, reason)."""
    claude_bin = find_claude()
    if not claude_bin:
        return None, "claude_not_found"
    cmd = [claude_bin, "-p", "--model", st.get("model", "haiku"),
           "--output-format", "text", "--tools", "", "--no-session-persistence"]
    if safe_mode:
        cmd.insert(2, "--safe-mode")
    env = dict(os.environ, LEOPOLD_ENHANCE_ACTIVE="1", OVMEM_DISABLE="1")
    budget = _int_env("LEOPOLD_ENHANCE_TIMEOUT_S", int(st.get("subprocess_timeout_s", 25)))
    try:
        os.makedirs(ENHANCE_DIR, exist_ok=True)
        r = subprocess.run(cmd, input=payload, capture_output=True, text=True,
                           timeout=budget, cwd=ENHANCE_DIR, env=env)
    except subprocess.TimeoutExpired:
        return None, "timeout"
    except Exception as e:
        log("subprocess failed: %s" % e)
        return None, "spawn_failed"
    if r.returncode != 0:
        log("claude exit %d: %s" % (r.returncode, (r.stderr or "")[:300]))
        return None, "exit_%d" % r.returncode
    body = (r.stdout or "").strip()
    if not body:
        return None, "empty_output"
    if "```" in body:
        return None, "malformed_output"  # Haiku ignored the format instruction
    cap = threshold(st, "max_inject_chars", "LEOPOLD_ENHANCE_MAX_INJECT")
    return body[:cap], None


def note_result(st, ok, was_safe, err):
    """Track consecutive failures. Self-heal safe->normal ONLY on exit/spawn errors
    (an old CLI rejecting --safe-mode exits non-zero). Never on timeouts: those are
    API slowness, and normal mode is SLOWER - downgrading would make them worse."""
    if ok:
        if st.get("consecutive_failures"):
            st["consecutive_failures"] = 0
            save_state(st)
        return
    st["consecutive_failures"] = int(st.get("consecutive_failures", 0)) + 1
    flag_problem = bool(err) and (err.startswith("exit_") or err == "spawn_failed")
    if was_safe and flag_problem and st["consecutive_failures"] >= 2:
        st["safe_mode"] = False
        st["consecutive_failures"] = 0
        log("safe mode errored twice - downgraded to normal mode")
    save_state(st)


# ---------- ledger ----------

def ledger_append(entry):
    try:
        os.makedirs(ENHANCE_DIR, exist_ok=True)
        if os.path.exists(LEDGER_PATH) and os.path.getsize(LEDGER_PATH) > LEDGER_MAX_BYTES:
            os.replace(LEDGER_PATH, LEDGER_PATH.replace(".jsonl", ".1.jsonl"))
        with open(LEDGER_PATH, "a") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception as e:
        log("ledger append failed: %s" % e)


def ledger_count():
    total = 0
    for p in (LEDGER_PATH, LEDGER_PATH.replace(".jsonl", ".1.jsonl")):
        try:
            with open(p) as f:
                total += sum(1 for _ in f)
        except Exception:
            pass
    return total


# ---------- events ----------

def emit(body):
    sys.stdout.write("\n%s — structured interpretation of the prompt above]\n%s\n%s\n"
                     % (MARKER, body, FOOTER))


# /skill briefs: a slash prompt whose argument is a real task ("/leopold-brief
# add microinteractions to onboarding, tasteful, nothing aggressive") used to be
# skipped whole as "command" - hiding exactly the weak prompts this hook exists
# for. Now the ARGUMENT is gated (and, when weak, enhanced) while the command
# prefix is stripped from the rewriter's view: "/leopold-brief" is not an anchor.
# Control-plane calls stay skipped: the enhancer's own verbs, and any slash
# prompt whose argument is too short to be a brief ("/model opus", "/clear").
SKILL_ARG_MIN_WORDS = 8
OWN_SKILL = "leopold-enhance"
OWN_VERBS = {"status", "on", "off", "preview", "learn"}


def slash_args(prompt):
    """'/skill args' -> the args when they read like a task brief, else None."""
    m = re.match(r"^/([\w:.-]+)[ \t]*(.*)$", prompt, re.S)
    if not m:
        return None
    cmd, args = m.group(1).lower(), m.group(2).strip()
    words = args.split()
    if cmd == OWN_SKILL and words and words[0].lower() in OWN_VERBS:
        return None  # its own control plane (status/on/off/preview/learn)
    if len(words) < SKILL_ARG_MIN_WORDS:
        return None  # built-ins and short control args
    return args


def skip_reason(prompt, data, st):
    """All the hard skips, in order. Returns (reason, effective_text): reason is a
    string to skip or None to proceed; effective_text is what the gate and the
    rewriter should see (the argument of a /skill brief, else the prompt itself)."""
    if not prompt:
        return "empty", prompt
    if prompt.startswith(("!", "#")):
        return "command", prompt
    text = prompt
    if prompt.startswith("/"):
        text = slash_args(prompt)
        if text is None:
            return "command", prompt
    if MARKER in prompt:
        return "marker", text  # anti-loop, defense in depth
    if leopold_run_active(data.get("cwd") or os.getcwd()):
        return "leopold_run", text  # autonomous run - its prompts are machine-generated
    if "```" in text or text.count("\n") > 8:
        return "pasted_content", text  # logs/code carry their own context
    if is_ack(text):
        return "ack", text
    if len(text.split()) > threshold(st, "max_words", "LEOPOLD_ENHANCE_MAX_WORDS"):
        return "long", text
    if in_cooldown(data.get("session_id"), st):
        return "cooldown", text
    return None, text


def handle_user_prompt(data):
    st = load_state()
    if not st or st.get("enabled") is not True:
        return
    prompt = (data.get("prompt") or "").strip()
    reason, text = skip_reason(prompt, data, st)
    if reason:
        log("skip (%s): %s" % (reason, prompt[:80]))
        return
    score, signals = gate(text, st)
    if score < threshold(st, "min_score", "LEOPOLD_ENHANCE_MIN_SCORE"):
        log("gate pass-through (score %d): %s" % (score, prompt[:80]))
        return

    cwd = data.get("cwd") or os.getcwd()
    payload, charter_used, profile_used, tail_used = build_payload(
        text, cwd, data.get("transcript_path"))
    safe_mode = st.get("safe_mode") is not False
    t0 = time.time()
    body, err = call_claude(payload, st, safe_mode)
    note_result(st, body is not None, safe_mode, err)

    entry = {
        "ts": now_iso(),
        "session_id": data.get("session_id"),
        "prompt_id": data.get("prompt_id"),
        "cwd": cwd,
        "prompt_excerpt": prompt[:500],
        "words": len(text.split()),
        "skill_brief": text != prompt,  # gated on a /skill argument, not the raw prompt
        "score": score,
        "signals": signals,
        "mode": "safe" if safe_mode else "normal",
        "model": st.get("model", "haiku"),
        "latency_ms": int((time.time() - t0) * 1000),
        "charter_used": charter_used,
        "profile_used": profile_used,
        "tail_used": tail_used,
        "injected": body is not None,
        "injected_chars": len(body) if body else 0,
        "error": err,
    }
    ledger_append(entry)
    if body:
        emit(body)
        stamp_cooldown(data.get("session_id"))
    log("enhanced=%s score=%d err=%s latency=%dms" % (bool(body), score, err, entry["latency_ms"]))


def handle_preview(text):
    """Dry-run for /leopold-enhance preview: verdict + would-be injection. No ledger,
    no cooldown, and it works even while disabled (it's the tuning tool)."""
    st = load_state() or default_state()
    prompt = (text or "").strip()
    data = {"cwd": os.getcwd(), "session_id": "preview"}
    reason, target = skip_reason(prompt, data, st) if prompt else ("empty", "")
    if reason and reason != "cooldown":
        print("verdict: SKIP (%s)" % reason)
        return
    if target != prompt:
        print("skill brief: gating the argument (command prefix stripped)")
    score, signals = gate(target, st)
    need = threshold(st, "min_score", "LEOPOLD_ENHANCE_MIN_SCORE")
    print("signals: %s" % json.dumps(signals))
    print("score: %d (needs >= %d)" % (score, need))
    if score < need:
        print("verdict: PASS-THROUGH (prompt looks strong enough)")
        return
    print("verdict: ENHANCE — calling %s..." % st.get("model", "haiku"))
    payload, _, _, _ = build_payload(target, os.getcwd(), None)
    body, err = call_claude(payload, st, st.get("safe_mode") is not False)
    if err:
        print("rewriter failed: %s (the hook would fail open — prompt passes untouched)" % err)
        return
    print("--- injected block ---")
    emit(body)


def handle_probe():
    """Can `claude -p --safe-mode` answer? safe mode keeps the user's login but skips
    hooks/plugins/MCP/CLAUDE.md in the subprocess - about half the latency and
    structural recursion safety. Old CLIs without the flag fall back to normal mode
    (recursion is still guarded by the env var there)."""
    st = load_state() or default_state()
    claude_bin = find_claude()
    if not claude_bin:
        st["safe_mode"] = False
        st["probed_at"] = now_iso()
        save_state(st)
        print("probe: claude binary not found — enhancer will fail open until it is on PATH")
        return
    env = dict(os.environ, LEOPOLD_ENHANCE_ACTIVE="1", OVMEM_DISABLE="1")
    ok = False
    try:
        r = subprocess.run(
            [claude_bin, "-p", "--safe-mode", "--model", st.get("model", "haiku"),
             "--output-format", "text", "--tools", "", "--no-session-persistence"],
            input="ping", capture_output=True, text=True, timeout=15,
            cwd=ENHANCE_DIR if os.path.isdir(ENHANCE_DIR) else None, env=env)
        ok = r.returncode == 0 and bool((r.stdout or "").strip())
    except Exception as e:
        log("probe failed: %s" % e)
    st["safe_mode"] = ok
    st["probed_at"] = now_iso()
    save_state(st)
    print("probe: mode=%s (safe mode = your login, no hooks/plugins in the subprocess)"
          % ("safe" if ok else "normal"))


def handle_toggle(arg):
    st = load_state() or default_state()
    if arg == "on":
        st["enabled"] = True
    elif arg == "off":
        st["enabled"] = False
    else:
        st["enabled"] = st.get("enabled") is not True
    save_state(st)
    print("enhance: %s" % ("on" if st["enabled"] else "off"))
    if st["enabled"] and not st.get("probed_at"):
        handle_probe()


def handle_status():
    st = load_state()
    if not st:
        print("not configured")
        return
    if st.get("enabled") is not True:
        print("off")
        return
    extra = []
    if st.get("safe_mode") is not False:
        extra.append("safe-mode")
    fails = int(st.get("consecutive_failures", 0))
    if fails:
        extra.append("%d recent failures" % fails)
    n = ledger_count()
    if n:
        extra.append("%d enhancement%s" % (n, "" if n == 1 else "s"))
    print("on (%s)" % ", ".join([st.get("model", "haiku")] + extra))


def main():
    # Recursion guard FIRST, before any file I/O: in normal (non-safe) mode our
    # own `claude -p` subprocess fires this very hook again.
    if os.environ.get("LEOPOLD_ENHANCE_ACTIVE") == "1":
        return
    if os.environ.get("LEOPOLD_ENHANCE_DISABLE") == "1":
        return
    event, arg = None, None
    argv = sys.argv[1:]
    for i, a in enumerate(argv):
        if a == "--event" and i + 1 < len(argv):
            event = argv[i + 1]
            arg = argv[i + 2] if i + 2 < len(argv) else None
    if not event:
        return
    try:
        if event == "user-prompt":
            try:
                raw = sys.stdin.read()
                data = json.loads(raw) if raw.strip() else {}
            except Exception as e:
                log("stdin parse failed: %s" % e)
                return
            handle_user_prompt(data)
        elif event == "preview":
            handle_preview(arg if arg is not None else sys.stdin.read())
        elif event == "probe":
            handle_probe()
        elif event == "toggle":
            handle_toggle(arg)
        elif event == "status":
            handle_status()
    except Exception as e:
        log("handler %s error: %s" % (event, e))


if __name__ == "__main__":
    main()
    sys.exit(0)

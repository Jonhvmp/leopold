#!/usr/bin/env python3
"""Leopold watch — a local, zero-dependency live dashboard for an autonomous run.

It reads the run's own files in `.leopold/` (state.json, PLAN.md, DECISIONS.md,
events.jsonl) AND the Claude Code session transcript (for real token/cost data), and
serves a dashboard on 127.0.0.1 with live (SSE) updates. Read-only except one action:
a Stop button that touches `.leopold/STOP` — the same kill switch `/leopold-stop` uses.

Cost is parsed from the transcript JSONL of whichever harness ran the session: a Claude
Code transcript (each assistant message carries `usage` + `model`) or a Codex CLI
rollout (`event_msg` lines with payload.type `token_count`). The dashboard finds it via
the run state's `transcript_path`, by the cwd's project slug under ~/.claude/projects/,
or by the newest ~/.codex/sessions rollout whose cwd is this project. Cost is an
ESTIMATE from a built-in price map; a transcript in neither format reports the cost as
unavailable rather than showing zeros.

No dependencies (Python 3.8+ stdlib). Nothing leaves the machine; it binds to loopback
and uses no web fonts. Usage:

    python3 leopold-watch.py [--project DIR] [--port 4179] [--host 127.0.0.1]
"""
import argparse
import datetime
import glob
import importlib.util
import json
import os
import re
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LEO = ""          # set in main(): the project's .leopold dir
PROJECT = ""      # set in main(): the project root (abspath), used to find the transcript


# --------------------------------------------------------------------------- readers
def _read(name):
    try:
        with open(os.path.join(LEO, name), "r", encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return ""


def read_state():
    raw = _read("state.json")
    if not raw.strip():
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {"_invalid": True}


# ---- the PLAN.md graph grammar, mirrored from packages/driver/src/plan.ts ----------
# The dashboard cannot import the TypeScript parser, so it re-reads the same markers.
# ONE parser inside this file: _item_markers() is the only thing that splits an item
# line, and _parse_after/_strip_after are thin views onto it, so the Canvas can never
# disagree with itself about what an item declared.
#
#   - [ ] @gate security Review the auth diff   kind + label, inline on the item line
#         @node human ops                       ...or the kind on a line of its own
#         @needs schema_ready                   a signal this node requires
#         @emit migrated=true                   a signal this node may put on the channel
#         @on migrated=false -> 7               a conditional edge (route)
#
# ABSENCE MEANS TODAY'S BEHAVIOR: an item that declares none of it parses to kind
# "work" with no routes, emits or needs — exactly what it parsed to before this existed.
_DEP_MARKER = re.compile(r"^\((?:after|deps)\s*:\s*([0-9,\s]+)\)\s*", re.I)
_KIND_MARKER = re.compile(r"^@(node|work|gate|human|tool|verify|feedback)\b[ \t]*:?[ \t]*", re.I)
_KIND_NAME = re.compile(r"^([A-Za-z]+)[ \t]*:?[ \t]*")
_LABEL_EXPLICIT = re.compile(r"^([A-Za-z][A-Za-z0-9_./-]*):(?:[ \t]+|$)[ \t]*")
_LABEL_BARE = re.compile(r"^([a-z][a-z0-9_./-]*)(?:[ \t]+|$)[ \t]*")
_KINDS = ("work", "gate", "human", "tool", "verify", "feedback")
_ROUTE_LINE = re.compile(r"^[ \t]*@on\b[ \t:]*(.*)$", re.I)
_EMIT_LINE = re.compile(r"^[ \t]*@emit\b[ \t:]*(.*)$", re.I)
_NEEDS_LINE = re.compile(r"^[ \t]*@needs\b[ \t:]*(.*)$", re.I)
_ARROW = re.compile(r"^(.*)(?:->|=>|→)[ \t]*(.*)$", re.S)


def _match_kind(raw, inline):
    """Parse a leading node-kind marker. Returns (kind, label, rest) or None.
    `inline` is True on the item's own line, where a bare lowercase label only counts
    when text follows it (so `@human Ask the team` keeps "Ask the team" as its text)."""
    m = _KIND_MARKER.match(raw or "")
    if not m:
        return None
    rest = raw[m.end():]
    kind = m.group(1).lower()
    if kind == "node":
        k = _KIND_NAME.match(rest)
        name = (k.group(1).lower() if k else "")
        if not k or name not in _KINDS:
            return None          # `@node` without a known kind is prose, not a marker
        kind = name
        rest = rest[k.end():]
    label = ""
    exp = _LABEL_EXPLICIT.match(rest)
    if exp:
        label, rest = exp.group(1), rest[exp.end():]
    elif kind != "tool":
        # Never on a `@tool` node: its text IS the command, so the first word of
        # `@tool make test` is part of the command, not a label.
        bare = _LABEL_BARE.match(rest)
        if bare:
            after = rest[bare.end():]
            if not inline or after.strip():
                label, rest = bare.group(1), after
    return kind, label, rest.strip()


def _item_markers(text):
    """Split an item's line into {deps, kind, kindLabel, label}. `(after: 1, 3)` and the
    node-kind marker may appear in either order; both are optional."""
    rest = text or ""
    deps, kind, kind_label, saw_dep = [], "work", "", False
    while True:
        d = None if saw_dep else _DEP_MARKER.match(rest)
        if d:
            saw_dep = True
            deps += [int(x) for x in re.findall(r"\d+", d.group(1))]
            rest = rest[d.end():]
            continue
        k = _match_kind(rest.lstrip(), True)
        if k:
            kind, lbl, rest = k[0], k[1], k[2]
            if lbl:
                kind_label = lbl
            continue
        break
    seen, uniq = set(), []
    for d in deps:
        if d >= 1 and d not in seen:
            seen.add(d)
            uniq.append(d)
    return {"deps": uniq, "kind": kind, "kindLabel": kind_label, "label": rest.strip()}


def _parse_route(raw):
    """`@on <condition> -> <target>` → {when, target}. Target 0 when none was written —
    recorded, not dropped, exactly like the driver's parser."""
    written = (raw or "").strip()
    if not written:
        return None
    split = _ARROW.match(written)
    when = (split.group(1) if split else written).strip()
    tgt = re.match(r"^#?(\d+)$", split.group(2).strip()) if split else None
    return {"when": when, "target": int(tgt.group(1)) if tgt else 0}


def read_plan(name="PLAN.md"):
    items, done, opened, cur = [], 0, 0, None
    for line in _read(name).splitlines():
        s = line.strip()
        low = s.lower()
        if s.startswith("- [ ]") or low.startswith("- [x]"):
            is_done = low.startswith("- [x]")
            if is_done:
                done += 1
            else:
                opened += 1
            raw = s[5:].strip()
            mk = _item_markers(raw)
            cur = {"done": is_done, "text": raw, "kind": mk["kind"],
                   "kindLabel": mk["kindLabel"], "routes": [], "emits": [], "needs": []}
            items.append(cur)
            continue
        # A marker line attaches to the item above it; everything else is ignored,
        # exactly as before this grammar existed.
        if cur is None or not s.startswith("@"):
            continue
        r = _ROUTE_LINE.match(s)
        if r:
            route = _parse_route(r.group(1))
            if route:
                cur["routes"].append(route)
            continue
        e = _EMIT_LINE.match(s)
        if e:
            sig = e.group(1).strip()
            if sig:
                cur["emits"].append(sig if "=" in sig else sig + "=true")
            continue
        nd = _NEEDS_LINE.match(s)
        if nd:
            for tok in re.split(r"[,\s]+", nd.group(1).strip()):
                key = tok.split("=")[0].strip()
                if key and key not in cur["needs"]:
                    cur["needs"].append(key)
            continue
        k = _match_kind(s, False)
        if k:
            cur["kind"] = k[0]
            if k[1]:
                cur["kindLabel"] = k[1]
    return {"open": opened, "done": done, "total": opened + done, "items": items}


def read_decisions(limit=8):
    text = _read("DECISIONS.md")
    blocks, cur = [], []
    for line in text.splitlines():
        if line.strip() == "---":
            if any(x.strip() for x in cur):
                blocks.append("\n".join(cur).strip())
            cur = []
        else:
            cur.append(line)
    if any(x.strip() for x in cur):
        blocks.append("\n".join(cur).strip())
    out = [b.replace("**", "") for b in blocks
           if ("Fork:" in b or "Decision:" in b)]
    return out[-limit:][::-1]


def read_events(limit=60):
    path = os.path.join(LEO, "events.jsonl")
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
    except OSError:
        return []
    out = []
    for line in lines[-limit:]:
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out[::-1]  # newest first


# --------------------------------------------------------------------------- cost / session
# Estimated prices, USD per million tokens. cache-write defaults to 1.25x input, cache-read
# to 0.1x input (Anthropic's standard cache pricing). Matched by model family substring.
# Override per model/family via a JSON file in $LEOPOLD_PRICES or .leopold/prices.json, e.g.
#   {"opus": {"in": 15, "out": 75, "cache_write": 18.75, "cache_read": 1.5},
#    "claude-my-model-1": {"in": 2, "out": 8}}
# (cache_write/cache_read optional; merged over these defaults; restart watch to apply.)
# OpenAI (Codex CLI) models are matched the same way; they bill cached input at 0.1x
# input and do NOT bill a cache write, so those entries pin cache_write to 0. The last
# `gpt` entry is the deliberate non-zero fallback for a model this table has not seen
# yet (a new gpt-5.x): a run priced at 0 would silently disable the budget.
# Order matters — the first family whose name is a substring of the model wins, so the
# specific names come before the generic ones.
PRICES = {
    "opus":   {"in": 15.0, "out": 75.0},
    "sonnet": {"in": 3.0,  "out": 15.0},
    "haiku":  {"in": 1.0,  "out": 5.0},
    "gpt-5-nano":  {"in": 0.05, "out": 0.40, "cache_write": 0.0},
    "gpt-5-mini":  {"in": 0.25, "out": 2.0,  "cache_write": 0.0},
    "gpt-5.1":     {"in": 1.25, "out": 10.0, "cache_write": 0.0},
    "gpt-5":       {"in": 1.25, "out": 10.0, "cache_write": 0.0},
    "gpt-4.1-mini": {"in": 0.40, "out": 1.60, "cache_write": 0.0},
    "gpt-4.1":     {"in": 2.0,  "out": 8.0,  "cache_write": 0.0},
    "gpt-4o":      {"in": 2.5,  "out": 10.0, "cache_write": 0.0},
    "o3":          {"in": 2.0,  "out": 8.0,  "cache_write": 0.0},
    "codex-mini":  {"in": 1.5,  "out": 6.0,  "cache_write": 0.0},
    "gpt":         {"in": 1.25, "out": 10.0, "cache_write": 0.0},
}
_DEFAULT_PRICE = {"in": 3.0, "out": 15.0}
_PRICES_LOADED = None


def _with_cache(p):
    q = {"in": float(p["in"]), "out": float(p["out"])}
    q["cache_write"] = float(p.get("cache_write", q["in"] * 1.25))
    q["cache_read"] = float(p.get("cache_read", q["in"] * 0.1))
    return q


def _load_prices():
    global _PRICES_LOADED
    if _PRICES_LOADED is not None:
        return _PRICES_LOADED
    prices = {k: _with_cache(v) for k, v in PRICES.items()}
    for src in (os.environ.get("LEOPOLD_PRICES"), os.path.join(LEO, "prices.json")):
        if not src or not os.path.isfile(src):
            continue
        try:
            with open(src, "r", encoding="utf-8") as f:
                override = json.load(f)
        except (OSError, ValueError):
            continue
        if isinstance(override, dict):
            for k, v in override.items():
                if isinstance(v, dict) and "in" in v and "out" in v:
                    try:
                        prices[str(k).lower()] = _with_cache(v)
                    except (TypeError, ValueError):
                        pass
    _PRICES_LOADED = prices
    return prices


def _price(model):
    prices = _load_prices()
    m = (model or "").lower()
    if m in prices:               # exact-model override wins
        return prices[m]
    for fam, p in prices.items():  # then family substring (opus / sonnet / haiku / custom)
        if fam in m:
            return p
    return _with_cache(_DEFAULT_PRICE)


def _projects_dir():
    base = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
    return os.path.join(base, "projects")


def _codex_sessions_dir():
    base = os.environ.get("CODEX_HOME") or os.path.expanduser("~/.codex")
    return os.path.join(base, "sessions")


def _find_codex_transcript(scan=40):
    """Newest Codex rollout whose session_meta.cwd is this project.
    Codex stores sessions under <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl and
    records the cwd on the first line, so the project is matched from the file itself
    rather than from a path slug."""
    project = os.path.abspath(PROJECT or os.getcwd())
    try:
        files = glob.glob(os.path.join(_codex_sessions_dir(), "*", "*", "*", "rollout-*.jsonl"))
    except Exception:
        return None
    files = sorted(files, key=lambda p: os.path.getmtime(p) if os.path.exists(p) else 0,
                   reverse=True)[:scan]
    for p in files:
        meta = _first_json_line(p)
        if not meta or meta.get("type") != "session_meta":
            continue
        cwd = (meta.get("payload") or {}).get("cwd") or ""
        if cwd and os.path.abspath(cwd) == project:
            return p
    return None


def find_transcript():
    # 1) explicit path recorded by the Stop hook (the run's actual session — this is
    #    what a Codex run gives us, and Codex's Stop payload carries it too).
    tp = read_state().get("transcript_path")
    if tp and os.path.isfile(tp):
        return tp
    # 2) auto-discover: Claude Code stores sessions under <config>/projects/<slug>/,
    #    where <slug> is the project path with non-alphanumerics replaced by '-'.
    slug = re.sub(r"[^a-zA-Z0-9]", "-", PROJECT or os.getcwd())
    d = os.path.join(_projects_dir(), slug)
    try:
        files = [os.path.join(d, f) for f in os.listdir(d) if f.endswith(".jsonl")]
    except OSError:
        files = []
    if files:
        return max(files, key=os.path.getmtime)
    # 3) no Claude session for this project — look for a Codex rollout instead.
    return _find_codex_transcript()


_WF_CACHE = {}  # path -> (mtime, parsed-compact-run)


def _compact_workflow(raw):
    """Reduce a wf_<id>.json into the phase-tree the dashboard renders."""
    progress = raw.get("workflowProgress") or []
    # Phase order comes from the workflow_phase markers (and meta.phases as a fallback).
    order, seen = [], set()
    for it in progress:
        if it.get("type") == "workflow_phase":
            t = it.get("title") or "(phase)"
            if t not in seen:
                seen.add(t); order.append(t)
    for ph in (raw.get("phases") or []):
        t = ph.get("title")
        if t and t not in seen:
            seen.add(t); order.append(t)
    buckets = {t: [] for t in order}
    for it in progress:
        if it.get("type") != "workflow_agent":
            continue
        title = it.get("phaseTitle") or "(unphased)"
        if title not in buckets:
            buckets[title] = []; order.append(title)
        st = it.get("state")
        state = "done" if st == "done" else (st if st else ("running" if it.get("startedAt") else "queued"))
        buckets[title].append({
            "label": it.get("label") or ("agent " + str(it.get("index", "?"))),
            "state": state,
            "tokens": it.get("tokens") or 0,
            "toolCalls": it.get("toolCalls") or 0,
            "model": (it.get("model") or "").replace("claude-", ""),
            "lastTool": it.get("lastToolSummary") or it.get("lastToolName") or "",
            "durationMs": it.get("durationMs") or 0,
            "attempt": it.get("attempt") or 1,
            "promptPreview": it.get("promptPreview") or "",
            "resultPreview": it.get("resultPreview") or "",
        })
    phases = []
    for t in order:
        ags = buckets.get(t, [])
        phases.append({
            "title": t, "agents": ags,
            "tokens": sum(a["tokens"] for a in ags),
            "running": sum(1 for a in ags if a["state"] in ("running", "queued")),
            "done": sum(1 for a in ags if a["state"] == "done"),
        })
    return {
        "runId": raw.get("runId", ""),
        "name": raw.get("workflowName") or raw.get("runId", "workflow"),
        "status": raw.get("status", ""),
        "summary": (raw.get("summary") or "")[:200],
        "agentCount": raw.get("agentCount", 0),
        "totalTokens": raw.get("totalTokens", 0),
        "totalToolCalls": raw.get("totalToolCalls", 0),
        "durationMs": raw.get("durationMs", 0),
        "ts": raw.get("timestamp", ""),
        "startTime": raw.get("startTime", 0),
        "phases": phases,
    }


def read_workflows(limit=8):
    """Dynamic-workflow runs for this project, newest first, with their phase tree.
    The native runtime writes <projects>/<slug>/<session>/workflows/wf_*.json."""
    slug = re.sub(r"[^a-zA-Z0-9]", "-", PROJECT or os.getcwd())
    root = os.path.join(_projects_dir(), slug)
    try:
        paths = glob.glob(os.path.join(root, "*", "workflows", "wf_*.json"))
    except Exception:
        return []
    runs = []
    for p in paths:
        try:
            mtime = os.path.getmtime(p)
        except OSError:
            continue
        cached = _WF_CACHE.get(p)
        if cached and cached[0] == mtime:
            runs.append(cached[1]); continue
        try:
            with open(p, "r", encoding="utf-8", errors="replace") as f:
                raw = json.load(f)
            run = _compact_workflow(raw)
        except Exception:
            continue
        _WF_CACHE[p] = (mtime, run)
        runs.append(run)
    # Active runs first, then newest by timestamp.
    runs.sort(key=lambda r: (r.get("status") == "running", r.get("ts", "")), reverse=True)
    return runs[:limit]


def _iso_delta(a, b):
    if not a or not b:
        return 0
    try:
        from datetime import datetime
        def p(s):
            return datetime.fromisoformat(s.replace("Z", "+00:00"))
        return max(0, int((p(b) - p(a)).total_seconds()))
    except Exception:
        return 0


_COST_CACHE = {}  # path -> (mtime, size, result)  — avoid re-parsing on every SSE tick


def _first_json_line(tp):
    """First line of a transcript, parsed. None if unreadable/not JSON."""
    try:
        with open(tp, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    o = json.loads(line)
                except (json.JSONDecodeError, ValueError):
                    return None
                return o if isinstance(o, dict) else None
    except OSError:
        return None
    return None


_CLAUDE_LINE_TYPES = {"assistant", "user", "system", "summary", "file-history-snapshot"}


def detect_harness(tp):
    """Which agent wrote this transcript: 'codex', 'claude' or 'unknown'.

    A Codex rollout opens with a `session_meta` line; a Claude Code transcript opens
    with one of its own record types (and carries sessionId/uuid). Anything else is
    reported as unknown so the dashboard can SAY the cost is unavailable on this
    harness instead of rendering zeros that read as a free run.
    """
    o = _first_json_line(tp)
    if not isinstance(o, dict):
        return "unknown"
    if o.get("type") == "session_meta":
        return "codex"
    if o.get("type") in _CLAUDE_LINE_TYPES or "sessionId" in o or "uuid" in o:
        return "claude"
    return "unknown"


def _parse_cost_codex(tp):
    """Cost/tokens/context for a Codex CLI rollout JSONL.

    Token usage arrives as `event_msg` lines with payload.type == 'token_count':
    info.total_token_usage is CUMULATIVE for the session and info.last_token_usage is
    the live context. Usage is attributed to the model in effect (from the preceding
    `turn_context` line) by diffing consecutive cumulative snapshots, so a session that
    switched models still prices each stretch correctly. OpenAI counts cached tokens
    INSIDE input_tokens, so the uncached remainder is what bills at the input rate.
    """
    tot = {"input": 0, "output": 0, "cache_write": 0, "cache_read": 0}
    usd = 0.0
    msgs = 0
    models = {}
    model = ""
    session = ""
    t_first = t_last = None
    ctx_tokens = ctx_window = 0
    prev = {"input_tokens": 0, "cached_input_tokens": 0,
            "cache_write_input_tokens": 0, "output_tokens": 0}
    try:
        f = open(tp, "r", encoding="utf-8", errors="replace")
    except OSError:
        return {"available": False, "harness": "codex", "reason": "transcript unreadable"}
    with f:
        for line in f:
            if '"session_meta"' not in line and '"turn_context"' not in line \
               and '"token_count"' not in line and '"agent_message"' not in line:
                continue
            try:
                o = json.loads(line)
            except (json.JSONDecodeError, ValueError):
                continue
            if not isinstance(o, dict):
                continue
            kind = o.get("type")
            payload = o.get("payload") or {}
            if kind == "session_meta":
                session = payload.get("session_id") or payload.get("id") or session
                continue
            if kind == "turn_context":
                model = payload.get("model") or model
                continue
            if kind != "event_msg":
                continue
            ptype = payload.get("type")
            if ptype == "agent_message":
                msgs += 1
                continue
            if ptype != "token_count":
                continue
            info = payload.get("info") or {}
            cur = info.get("total_token_usage") or {}
            if not cur:
                continue
            ts = o.get("timestamp")
            if ts:
                t_first = ts if t_first is None else min(t_first, ts)
                t_last = ts if t_last is None else max(t_last, ts)
            last = info.get("last_token_usage") or {}
            ctx_tokens = int(last.get("total_tokens", 0) or 0) or ctx_tokens
            ctx_window = int(info.get("model_context_window", 0) or 0) or ctx_window

            def _n(d, k):
                try:
                    return int(d.get(k, 0) or 0)
                except (TypeError, ValueError):
                    return 0
            # Cumulative snapshots -> per-turn delta. A resumed/forked session can move
            # backwards; treat that as a new baseline instead of a negative charge.
            d = {k: _n(cur, k) - prev[k] for k in prev}
            if any(v < 0 for v in d.values()):
                d = {k: max(0, _n(cur, k)) for k in prev}
            prev = {k: _n(cur, k) for k in prev}
            inp_all = d["input_tokens"]
            cr = min(d["cached_input_tokens"], inp_all)
            cw = d["cache_write_input_tokens"]
            inp = max(0, inp_all - cr)
            out = d["output_tokens"]
            if not (inp or out or cr or cw):
                continue
            pr = _price(model or "gpt")
            c = (inp * pr["in"] + out * pr["out"] + cw * pr["cache_write"] + cr * pr["cache_read"]) / 1e6
            tot["input"] += inp; tot["output"] += out
            tot["cache_write"] += cw; tot["cache_read"] += cr
            usd += c
            mm = models.setdefault(model or "gpt-5", {"usd": 0.0, "msgs": 0})
            mm["usd"] += c; mm["msgs"] += 1
    if not any(tot.values()):
        # A live rollout that has not reported usage yet — say so instead of quoting $0.
        return {"available": False, "harness": "codex",
                "reason": "waiting for session data… (cost shows once the Codex run has a turn)"}
    tot["total"] = sum(tot.values())
    cacheable = tot["input"] + tot["cache_write"] + tot["cache_read"]
    hit = round(tot["cache_read"] / cacheable * 100) if cacheable else 0
    model_list = sorted(
        ({"model": k, "usd": round(v["usd"], 4), "msgs": v["msgs"]} for k, v in models.items()),
        key=lambda x: -x["usd"],
    )
    return {
        "available": True,
        "harness": "codex",
        "usd": round(usd, 4),
        "tokens": tot,
        "cache_hit_pct": hit,
        "messages": msgs,
        "sub_msgs": 0,
        "main_usd": round(usd, 4),
        "sub_usd": 0.0,
        "models": model_list[:4],
        "duration_s": _iso_delta(t_first, t_last),
        "session": session,
        "context_tokens": ctx_tokens,
        "context_window": ctx_window,
        "context_pct": round(ctx_tokens / ctx_window * 100) if ctx_window else 0,
    }


def _parse_cost(tp):
    tot = {"input": 0, "output": 0, "cache_write": 0, "cache_read": 0}
    usd = main_usd = sub_usd = 0.0
    msgs = sub_msgs = 0
    models = {}
    t_first = t_last = None
    session = ""
    try:
        f = open(tp, "r", encoding="utf-8", errors="replace")
    except OSError:
        return {"available": False}
    with f:
        for line in f:
            if '"usage"' not in line:   # cheap pre-filter: only assistant turns carry cost
                continue
            try:
                o = json.loads(line)
            except (json.JSONDecodeError, ValueError):
                continue
            if o.get("type") != "assistant":
                continue
            m = o.get("message") or {}
            u = m.get("usage") or {}
            if not u:
                continue
            ts = o.get("timestamp")
            if ts:
                t_first = ts if t_first is None else min(t_first, ts)
                t_last = ts if t_last is None else max(t_last, ts)
            if not session:
                session = o.get("sessionId", "") or ""
            model = m.get("model", "") or "?"
            inp = int(u.get("input_tokens", 0) or 0)
            out = int(u.get("output_tokens", 0) or 0)
            cw = int(u.get("cache_creation_input_tokens", 0) or 0)
            cr = int(u.get("cache_read_input_tokens", 0) or 0)
            pr = _price(model)
            c = (inp * pr["in"] + out * pr["out"] + cw * pr["cache_write"] + cr * pr["cache_read"]) / 1e6
            tot["input"] += inp; tot["output"] += out
            tot["cache_write"] += cw; tot["cache_read"] += cr
            usd += c; msgs += 1
            if o.get("isSidechain"):
                sub_usd += c; sub_msgs += 1
            else:
                main_usd += c
            mm = models.setdefault(model, {"usd": 0.0, "msgs": 0})
            mm["usd"] += c; mm["msgs"] += 1
    tot["total"] = sum(tot.values())
    cacheable = tot["input"] + tot["cache_write"] + tot["cache_read"]
    hit = round(tot["cache_read"] / cacheable * 100) if cacheable else 0
    model_list = sorted(
        ({"model": k, "usd": round(v["usd"], 4), "msgs": v["msgs"]} for k, v in models.items()),
        key=lambda x: -x["usd"],
    )
    return {
        "available": True,
        "harness": "claude",
        "usd": round(usd, 4),
        "tokens": tot,
        "cache_hit_pct": hit,
        "messages": msgs,
        "sub_msgs": sub_msgs,
        "main_usd": round(main_usd, 4),
        "sub_usd": round(sub_usd, 4),
        "models": model_list[:4],
        "duration_s": _iso_delta(t_first, t_last),
        "session": session,
    }


def parse_transcript(tp):
    """Cost/tokens/context for whichever harness wrote this transcript."""
    harness = detect_harness(tp)
    if harness == "codex":
        return _parse_cost_codex(tp)
    if harness == "claude":
        return _parse_cost(tp)
    return {
        "available": False,
        "harness": "unknown",
        "reason": "cost unavailable on this harness — the transcript is neither a "
                  "Claude Code session nor a Codex rollout",
    }


def read_cost():
    tp = find_transcript()
    if not tp:
        return {"available": False}
    try:
        st = os.stat(tp)
    except OSError:
        return {"available": False}
    cached = _COST_CACHE.get(tp)
    if cached and cached[0] == st.st_mtime and cached[1] == st.st_size:
        return cached[2]
    result = parse_transcript(tp)
    _COST_CACHE[tp] = (st.st_mtime, st.st_size, result)
    return result


# --------------------------------------------------------------------------- graph (DAG)
# The Canvas view: turn a run into a directed graph {nodes, edges, groups}. Nodes are
# phases / agents / verify (from a dynamic workflow) and items / subagents / verify /
# hypothesis (from the /leopold-run conductor). Edges are INFERRED here — phase order,
# PLAN (after: N) markers, and label conventions (verify-ish label -> the phase it
# checks, fork -> parent). Leopold's own workflow scripts can later emit exact edge
# hints (PLAN item 2); this inference stays the fallback for generic workflows.
# build_graph() is pure (no I/O) so the edge logic is unit-testable; graph() wires it
# to the readers and is what /api/graph serves.

_VERIFY_RE = re.compile(r"^(verify|review|judge|skeptic|refute|critic|check)", re.I)


def _label_role_key(label):
    """Structured-label edge hint: Leopold's own workflow scripts label agents
    `role:key[:extra]` (e.g. `impl:i3`, `verify:i3:security`). Split off the role and
    the shared key so the graph can draw an EXACT verify->impl edge instead of a coarse
    prior-phase one. Returns (role_lower, key or None)."""
    parts = (label or "").split(":")
    if len(parts) >= 2 and parts[1].strip():
        return parts[0].strip().lower(), parts[1].strip()
    return (label or "").strip().lower(), None


def _parse_after(text):
    """1-based dependency positions from an item's '(after: 2, 3)' / '(deps: 2)' marker.
    One view onto _item_markers, so a dep the driver honors is a dep the Canvas draws."""
    return _item_markers(text)["deps"]


def _strip_after(text):
    """The item's display label: dependency and node-kind markers stripped, so the
    Canvas shows the work, not the syntax that wired it."""
    return _item_markers(text)["label"]


def _match_item(txt, plan_items):
    """Best-effort map an event's item text back to a PLAN item id."""
    txt = (txt or "").strip()
    if not txt:
        return None
    for i, it in enumerate(plan_items, start=1):
        label = _strip_after(it["text"])[:60]
        if label and (label.startswith(txt[:60]) or txt.startswith(label[:40])):
            return "item-%d" % i
    return None


def build_graph(plan_items, events, workflows):
    """Pure DAG builder. Returns {nodes, edges, groups}. No file I/O — testable.

    nodes: {id, kind, label, state, group, tokens, toolCalls, model, source, detail}
    edges: {from, to, kind}   kind in {seq, contains, verifies, after, fork, route}

    WHAT THE PLAN AUTHORED, NOT AN APPROXIMATION. A PLAN item that declares a node kind
    carries `nodeKind` (plus `nodeLabel`/`needs`/`emits` when declared), and each `@on`
    edge is a `route` edge carrying the condition exactly as written, in `when`. Those
    keys appear ONLY when the item declared them, so a plan with none of the new grammar
    produces byte-identical nodes and edges to the ones this built before it existed.
    """
    nodes, edges, ids, groups = [], [], set(), []

    def node(nid, kind, label, state="", grp="", extra=None, **ex):
        if nid in ids:
            return nid
        ids.add(nid)
        n = {
            "id": nid, "kind": kind, "label": label, "state": state or "", "group": grp,
            "tokens": int(ex.get("tokens", 0) or 0),
            "toolCalls": int(ex.get("toolCalls", 0) or 0),
            "model": (ex.get("model") or "").replace("claude-", ""),
            "source": ex.get("source", "conductor"), "detail": ex.get("detail", ""),
        }
        n.update(extra or {})
        nodes.append(n)
        return nid

    def edge(a, b, kind, when=None):
        e = {"from": a, "to": b, "kind": kind}
        if when is not None:
            e["when"] = when
        edges.append(e)

    def group(name):
        if name and name not in groups:
            groups.append(name)

    # ---- dynamic-workflow sub-graphs (the richer, primary case) ----
    for wf in workflows or []:
        rid = wf.get("runId") or wf.get("name") or "wf"
        src = "workflow:%s" % rid
        phase_ids = []
        impl_by_key = {}       # shared key -> the work node it labels (impl:<key>)
        verify_pending = []    # (verify_node_id, key, prior_phase_id)
        for j, ph in enumerate(wf.get("phases") or []):
            title = ph.get("title") or "(phase)"
            gname = "%s · %s" % (wf.get("name", "workflow"), title)
            group(gname)
            pid = "%s-p%d" % (rid, j)
            node(pid, "phase", title, "running" if ph.get("running") else "done", gname,
                 source=src, tokens=ph.get("tokens", 0))
            if phase_ids:
                edge(phase_ids[-1], pid, "seq")
            prev_phase = phase_ids[-1] if phase_ids else None
            for k, a in enumerate(ph.get("agents") or []):
                lbl = a.get("label") or ("agent %d" % k)
                is_verify = bool(_VERIFY_RE.match(lbl))
                role, key = _label_role_key(lbl)
                aid = "%s-p%d-a%d" % (rid, j, k)
                node(aid, "verify" if is_verify else "agent", lbl, a.get("state", ""), gname,
                     source=src, tokens=a.get("tokens", 0), toolCalls=a.get("toolCalls", 0),
                     model=a.get("model", ""), detail=a.get("lastTool", ""))
                edge(pid, aid, "contains")
                if is_verify:
                    verify_pending.append((aid, key, prev_phase))
                elif key:
                    impl_by_key[key] = aid   # a work node names its shared key
            phase_ids.append(pid)
        # Draw each verify's edge: EXACT (from the work node with the same key) where
        # Leopold's labels name it, else the coarse prior-phase fallback for generic
        # workflows that don't follow the `role:key` convention.
        for vid, key, prev in verify_pending:
            if key and key in impl_by_key:
                edge(impl_by_key[key], vid, "verifies")
            elif prev:
                edge(prev, vid, "verifies")

    # ---- conductor sub-graph: PLAN items, (after: N) deps and @on routes ----
    plan_items = plan_items or []
    group("plan")
    n = len(plan_items)
    # A `@human` node is the one kind that waits on a PERSON. Both engines log
    # `awaiting_human` with the item's index when they reach one; that event — not a
    # guess about which item is next — is what puts the node in the `awaiting` state.
    awaiting = set()
    for e in events or []:
        if e.get("event") == "awaiting_human":
            try:
                awaiting.add(int(e.get("item")))
            except (TypeError, ValueError):
                pass
    for i, it in enumerate(plan_items, start=1):
        mk = _item_markers(it.get("text"))
        kind = (it.get("kind") or mk["kind"] or "work").lower()
        label = it.get("kindLabel") or mk["kindLabel"]
        extra = {}
        if kind != "work":
            extra["nodeKind"] = kind
        if label:
            extra["nodeLabel"] = label
        if it.get("needs"):
            extra["needs"] = list(it["needs"])
        if it.get("emits"):
            extra["emits"] = list(it["emits"])
        state = "done" if it.get("done") else ("awaiting" if i in awaiting else "open")
        node("item-%d" % i, "item", mk["label"][:90], state, "plan",
             extra=extra or None, source="conductor")
    for i, it in enumerate(plan_items, start=1):
        for dep in _parse_after(it.get("text")):
            if 1 <= dep <= n and dep != i:
                edge("item-%d" % dep, "item-%d" % i, "after")
        # Conditional edges: drawn from the node that declares them at the node they
        # may hand control to, carrying the condition exactly as authored.
        for r in it.get("routes") or []:
            tgt = int(r.get("target") or 0)
            if 1 <= tgt <= n:
                edge("item-%d" % i, "item-%d" % tgt, "route", when=r.get("when", ""))

    # ---- conductor events: subagents / reviews / hypotheses on the active item ----
    cur = None
    for e in events or []:
        ev = e.get("event")
        if ev == "item_start":
            cur = _match_item(e.get("item"), plan_items)
        elif ev == "subagent_spawn" and cur:
            fork = bool(e.get("fork"))
            sid = "sub-%s" % (e.get("ts") or e.get("total"))
            node(sid, "fork" if fork else "subagent",
                 ("fork" if fork else "subagent") + " #%s" % (e.get("total") or ""),
                 "done", "plan", source="conductor")
            edge(cur, sid, "fork" if fork else "contains")
        elif ev == "review" and cur:
            rid = "rev-%s-r%s" % (cur, e.get("round", 1))
            node(rid, "verify", "review r%s" % e.get("round", 1),
                 "done" if e.get("ok") else "error", "plan", source="conductor",
                 detail=("clean" if e.get("ok") else "%s blocking" % e.get("blocking", "?")))
            edge(cur, rid, "verifies")
        elif ev == "hypothesis" and cur:
            hid = "hyp-%s-%s" % (cur, e.get("ts"))
            node(hid, "hypothesis", "hypothesis (%s)" % (e.get("angle") or "?"),
                 "done" if e.get("theory") else "open", "plan", source="conductor",
                 detail=(e.get("theory") or "no survivor")[:80])
            edge(cur, hid, "verifies")

    # drop dangling edges (an endpoint that never became a node)
    edges = [e for e in edges if e["from"] in ids and e["to"] in ids]
    return {"nodes": nodes, "edges": edges, "groups": groups}


def graph():
    """Read the current run and build its DAG for /api/graph."""
    plan = read_plan().get("items", [])
    evs = read_events(limit=500)[::-1]  # read_events is newest-first; back to chronological
    return build_graph(plan, evs, read_workflows())


# --------------------------------------------------------------------------- node detail
# /api/node/<id> — the inspector payload for one node. Reconstructs the same ids
# build_graph() mints, then returns the rich record: for a workflow agent, the raw
# prompt/result preview + model + tokens + a rough per-node cost; for a PLAN item, its
# label + any matching DECISIONS.md rationale; for a conductor event node, its detail.

def _node_est_usd(model, tokens):
    """Rough per-node USD estimate. Workflow items report only total tokens (no
    input/output split), so blend the model's in/out price — clearly an estimate."""
    tokens = int(tokens or 0)
    if not tokens:
        return 0.0
    p = _price(model)
    blended = (p["in"] + p["out"]) / 2.0
    return round(tokens / 1e6 * blended, 4)


def _decisions_for(label):
    """DECISIONS.md blocks (split on '## ' headers) that mention this item's label."""
    text = _read("DECISIONS.md")
    blocks, cur = [], []
    for line in text.splitlines():
        if line.startswith("## "):
            if cur:
                blocks.append("\n".join(cur).strip())
            cur = [line]
        else:
            cur.append(line)
    if cur:
        blocks.append("\n".join(cur).strip())
    key = (label or "")[:30].lower()
    return [b.replace("**", "") for b in blocks if key and key in b.lower()][:3]


def _event_node_detail(node_id, plan):
    """Best-effort detail for a conductor event node (rev-/hyp-/sub-)."""
    cur = None
    for e in read_events(limit=500)[::-1]:
        ev = e.get("event")
        if ev == "item_start":
            cur = _match_item(e.get("item"), plan)
        elif ev == "review" and cur and node_id == "rev-%s-r%s" % (cur, e.get("round", 1)):
            return {"id": node_id, "kind": "verify", "label": "review r%s" % e.get("round", 1),
                    "state": "done" if e.get("ok") else "error", "source": "conductor",
                    "detail": "clean" if e.get("ok") else "%s blocking" % e.get("blocking", "?"),
                    "round": e.get("round", 1), "panel": e.get("panel"), "lenses": e.get("lenses")}
        elif ev == "hypothesis" and cur and node_id == "hyp-%s-%s" % (cur, e.get("ts")):
            return {"id": node_id, "kind": "hypothesis",
                    "label": "hypothesis (%s)" % (e.get("angle") or "?"),
                    "state": "done" if e.get("theory") else "open", "source": "conductor",
                    "theory": e.get("theory", ""), "confidence": e.get("confidence"),
                    "considered": e.get("considered")}
        elif ev == "subagent_spawn" and cur and node_id == "sub-%s" % (e.get("ts") or e.get("total")):
            return {"id": node_id, "kind": "fork" if e.get("fork") else "subagent",
                    "label": ("fork" if e.get("fork") else "subagent") + " #%s" % (e.get("total") or ""),
                    "state": "done", "source": "conductor", "promptKb": e.get("prompt_kb")}
    return None


def node_detail(node_id):
    node_id = str(node_id)
    # workflow phase / agent nodes: "<runId>-p<j>" and "<runId>-p<j>-a<k>"
    for wf in read_workflows():
        rid = wf.get("runId") or wf.get("name") or "wf"
        for j, ph in enumerate(wf.get("phases") or []):
            if node_id == "%s-p%d" % (rid, j):
                return {"id": node_id, "kind": "phase", "label": ph.get("title"),
                        "state": "running" if ph.get("running") else "done",
                        "tokens": ph.get("tokens", 0), "agents": len(ph.get("agents") or []),
                        "estUsd": _node_est_usd("", ph.get("tokens", 0)),
                        "source": "workflow:%s" % rid, "workflow": wf.get("name")}
            for k, a in enumerate(ph.get("agents") or []):
                if node_id == "%s-p%d-a%d" % (rid, j, k):
                    tokens = a.get("tokens", 0) or 0
                    return {"id": node_id,
                            "kind": "verify" if _VERIFY_RE.match(a.get("label", "")) else "agent",
                            "label": a.get("label"), "state": a.get("state", ""),
                            "model": (a.get("model") or "").replace("claude-", ""),
                            "tokens": tokens, "toolCalls": a.get("toolCalls", 0),
                            "lastTool": a.get("lastTool", ""), "durationMs": a.get("durationMs", 0),
                            "attempt": a.get("attempt", 1),
                            "promptPreview": (a.get("promptPreview") or "")[:600],
                            "resultPreview": (a.get("resultPreview") or "")[:600],
                            "estUsd": _node_est_usd(a.get("model", ""), tokens),
                            "source": "workflow:%s" % rid, "phase": ph.get("title")}
    # conductor PLAN item nodes: "item-<N>"
    plan = read_plan().get("items", [])
    m = re.match(r"^item-(\d+)$", node_id)
    if m:
        idx = int(m.group(1))
        if 1 <= idx <= len(plan):
            it = plan[idx - 1]
            label = _strip_after(it["text"])
            awaiting = any(e.get("event") == "awaiting_human" and str(e.get("item")) == str(idx)
                           for e in read_events(limit=500))
            d = {"id": node_id, "kind": "item", "label": label,
                 "state": "done" if it["done"] else ("awaiting" if awaiting else "open"),
                 "source": "conductor",
                 "position": idx, "after": _parse_after(it["text"]),
                 "decisions": _decisions_for(label)}
            # What the item authored, verbatim — the inspector is where a human checks
            # that the graph on screen is the graph they wrote.
            if (it.get("kind") or "work") != "work":
                d["nodeKind"] = it["kind"]
            if it.get("kindLabel"):
                d["nodeLabel"] = it["kindLabel"]
            if it.get("routes"):
                d["routes"] = ["@on %s -> %s" % (r.get("when", ""), r.get("target") or "?")
                               for r in it["routes"]]
            if it.get("emits"):
                d["emits"] = list(it["emits"])
            if it.get("needs"):
                d["needs"] = list(it["needs"])
            return d
    # conductor event nodes (rev-/hyp-/sub-)
    return _event_node_detail(node_id, plan) or {"id": node_id, "error": "node not found"}


# --------------------------------------------------------------------------- steer (write side)
# The canvas POSTs a steer command here. A conductor node's command lands in
# .leopold/commands.jsonl (the /leopold-run driver drains it at the next turn
# boundary); a workflow node's command becomes a directive in
# .leopold/workflow-directives.json — the dynamic-workflow runtime can't be preempted
# from outside, so it applies on the NEXT resume/re-run, honestly labeled.
#
# SECURITY: the command kind is whitelisted; this only ever writes those two files —
# never a git-unlock token (ALLOW_GIT / ALLOW_PUSH) and never STOP. The driver
# whitelists again when it drains, so it is defense in depth.
STEER_CMDS = {"approve", "redirect", "inject", "kill-item", "rerun-item"}


def append_command(entry):
    with open(os.path.join(LEO, "commands.jsonl"), "a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")


def append_workflow_directive(entry):
    p = os.path.join(LEO, "workflow-directives.json")
    data = []
    if os.path.isfile(p):
        try:
            with open(p, encoding="utf-8") as f:
                data = json.load(f)
            if not isinstance(data, list):
                data = []
        except (OSError, ValueError):
            data = []
    entry = dict(entry)
    entry["ts"] = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    entry["note"] = "applies on the next workflow resume/re-run"
    data.append(entry)
    with open(p, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


def apply_canvas_command(body):
    """Validate + route one canvas steer command. Returns (http_code, result)."""
    cmd = body.get("cmd")
    if cmd not in STEER_CMDS:
        return 400, {"ok": False, "error": "unknown command"}
    node_id = str(body.get("nodeId", ""))
    source = str(body.get("source", ""))
    raw_text = body.get("text")
    text = raw_text[:2000] if isinstance(raw_text, str) and raw_text.strip() else None
    if cmd in ("redirect", "inject") and not text:
        return 400, {"ok": False, "error": "redirect/inject need text"}
    if source.startswith("workflow"):
        append_workflow_directive({"cmd": cmd, "nodeId": node_id, "text": text})
        return 200, {"ok": True, "applied": "directive", "note": "queued for next resume"}
    entry = {"cmd": cmd}
    m = re.match(r"item-(\d+)$", node_id)
    if m:
        entry["index"] = int(m.group(1))
    elif node_id:
        entry["item"] = node_id
    if text:
        entry["text"] = text
    append_command(entry)
    return 200, {"ok": True, "applied": "command"}


# --------------------------------------------------------------------------- snapshot
def _num(state, key, default):
    v = state.get(key, default)
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def snapshot():
    st = read_state()
    plan = read_plan()
    meters = [
        {"label": "context", "val": round(_num(st, "context_mb", 0), 1),
         "max": _num(st, "max_context_mb", 5), "unit": "MB"},
        {"label": "iterations", "val": int(_num(st, "iteration", 0)),
         "max": int(_num(st, "max_iterations", 50)), "unit": ""},
        {"label": "subagents", "val": int(_num(st, "subagents_spawned", 0)),
         "max": int(_num(st, "max_subagents", 8)), "unit": ""},
        {"label": "forks", "val": int(_num(st, "forks_spawned", 0)),
         "max": int(_num(st, "max_forks", 0)), "unit": ""},
        {"label": "failures", "val": int(_num(st, "consecutive_failures", 0)),
         "max": int(_num(st, "max_failures", 3)), "unit": ""},
    ]
    return {
        "present": bool(st) and not st.get("_invalid"),
        "invalid": bool(st.get("_invalid")),
        "active": st.get("active") is True,
        "stopped_reason": st.get("stopped_reason", ""),
        "stop_requested": os.path.exists(os.path.join(LEO, "STOP")),
        "session_id": st.get("session_id", ""),
        "plan": plan,
        "meters": meters,
        "cost": read_cost(),
        "events": read_events(),
        "decisions": read_decisions(),
        "workflows": read_workflows(),
        "ts": int(time.time()),
    }


# --------------------------------------------------------------------------- extension dashboards
# A small plugin system: any installed extension whose extension.json carries a
# `dashboard` block contributes a tab. The block names a Python module + a `view`
# callable returning a declarative card/widget view ({"cards":[...]}), and an optional
# `search` callable. The watch imports the module and renders the view with its own
# design system. Any failure drops that extension silently — the tab just won't appear.
_EXT_CACHE = None


def _harness_homes():
    """The data homes an installed payload can live under, Claude first — the same
    order (and the same LEOPOLD_HOME override) the installers resolve with. A
    Codex-only machine has no ~/.claude at all, so hardcoding it here would drop
    every extension tab without a word."""
    home = os.path.expanduser("~")
    leo = os.environ.get("LEOPOLD_HOME")
    out = [leo] if leo else []
    out.append(os.environ.get("CLAUDE_HOME") or os.path.join(home, ".claude"))
    out.append(os.environ.get("CODEX_HOME") or os.path.join(home, ".codex"))
    return out


def _ext_dirs():
    here = os.path.dirname(os.path.abspath(__file__))
    cands = [os.path.join(here, "..", "extensions")]
    leo = os.environ.get("LEOPOLD_HOME")
    if leo:
        cands.append(os.path.join(leo, "extensions"))
    for base in _harness_homes():
        cands.append(os.path.join(base, "leopold", "extensions"))
    out = []
    for cand in cands:
        cand = os.path.abspath(os.path.expanduser(cand))
        if os.path.isdir(cand) and cand not in out:
            out.append(cand)
    return out


def _resolve_ext_module(p):
    """Resolve an extension dashboard's `module` path.

    An absolute or ~-rooted path is taken as given — that is the historical contract
    and it still works. A RELATIVE path (e.g. "ovmem/dashboard.py") is resolved
    against the harness data homes instead, so ONE extension.json points at the right
    file on a Claude box, on a Codex-only box, and under a LEOPOLD_HOME override.
    """
    if not p:
        return ""
    if p.startswith("~") or os.path.isabs(p):
        return os.path.expanduser(p)
    for base in _harness_homes():
        cand = os.path.join(base, p)
        if os.path.isfile(cand):
            return cand
    return ""


def ext_dashboards():
    """Discover installed extensions that contribute a dashboard tab (memoized)."""
    global _EXT_CACHE
    if _EXT_CACHE is not None:
        return _EXT_CACHE
    found, seen = [], set()
    for base in _ext_dirs():
        try:
            names = sorted(os.listdir(base))
        except OSError:
            continue
        for name in names:
            meta = os.path.join(base, name, "extension.json")
            if name in seen or not os.path.isfile(meta):
                continue
            try:
                with open(meta, encoding="utf-8") as f:
                    cfg = json.load(f)
                dash = cfg.get("dashboard")
                if not isinstance(dash, dict):
                    continue
                mod_path = _resolve_ext_module(dash.get("module", ""))
                if not mod_path or not os.path.isfile(mod_path):
                    continue
                spec = importlib.util.spec_from_file_location("ext_dash_%s" % name, mod_path)
                mod = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(mod)
                view_fn = getattr(mod, dash.get("view", "dashboard_view"), None)
                if not callable(view_fn):
                    continue
                search_fn = getattr(mod, dash.get("search", ""), None)
                found.append({
                    "name": cfg.get("name", name),
                    "label": dash.get("label", cfg.get("title", name)),
                    "view": view_fn,
                    "search": search_fn if callable(search_fn) else None,
                })
                seen.add(name)
            except Exception:
                continue
    _EXT_CACHE = found
    return found


def ext_by_name(name):
    for e in ext_dashboards():
        if e["name"] == name:
            return e
    return None


# --------------------------------------------------------------------------- page
# Design system: warm cream (light) / near-black (dark), monochrome with semantic green/red
# + severity tones; Geist / Geist Mono type stack (system fallback, no web fonts -> offline).
PAGE = r"""<!doctype html><html lang="en" class="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Leopold watch</title>
<style>
:root{
 --bg:#efe8da;--fg:#141414;--card:#f6f2e9;--secondary:#e3dccc;--muted-fg:#616161;
 --border:#d7cfbe;--ring:#333;--destructive:#ae1f1f;--dfg:#f7f3ea;--success:#248052;
 --hairline:rgba(20,20,20,.15);--radius:12px;
 --sev-crit:#b91c1c;--sev-high:#c2410c;--sev-med:#b45309;--sev-low:#0369a1;--warnbar:#b45309;
 --route:#6d28d9;--await:#b45309;
 --sans:"Geist","Neue Montreal","General Sans","Inter",ui-sans-serif,system-ui,sans-serif;
 --mono:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
html.dark{
 --bg:#0a0a0a;--fg:#d9d9d9;--card:#0a0a0a;--secondary:#1a1a1a;--muted-fg:#808080;
 --border:#262626;--ring:#d9d9d9;--destructive:#7d2020;--dfg:#fafafa;--success:#45c98a;
 --hairline:rgba(217,217,217,.15);
 --sev-crit:#fecaca;--sev-high:#fed7aa;--sev-med:#fde68a;--sev-low:#bae6fd;--warnbar:#d29922;
 --route:#c4b5fd;--await:#d29922;
}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--fg);font-family:var(--sans);
 -webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
.wrap{max-width:1000px;margin:0 auto;padding:26px 20px 48px}
.head{display:flex;align-items:center;gap:11px;margin-bottom:18px}
.eyebrow{font-family:var(--mono);font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--muted-fg)}
.title{font-weight:600;font-size:15px;letter-spacing:-.01em}
.proj{font-family:var(--mono);font-size:11px;color:var(--muted-fg);letter-spacing:.04em}
.grow{flex:1}.sub{color:var(--muted-fg)}.tnum{font-variant-numeric:tabular-nums}
.tgl{background:transparent;border:1px solid var(--border);color:var(--muted-fg);border-radius:9999px;
 height:28px;padding:0 13px;font-family:var(--mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;cursor:pointer}
.tgl:hover{color:var(--fg);border-color:var(--muted-fg)}
.card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:16px 18px;margin-bottom:14px;
 opacity:0;animation:up .6s cubic-bezier(.22,1,.36,1) forwards}
.card:nth-child(2){animation-delay:.04s}.card:nth-child(3){animation-delay:.08s}
.card:nth-child(4){animation-delay:.12s}.card:nth-child(5){animation-delay:.16s}
@keyframes up{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
.sectitle{font-family:var(--mono);font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:var(--muted-fg);margin-bottom:12px}
.row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.pill{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--border);border-radius:9999px;padding:5px 13px;
 font-family:var(--mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted-fg)}
.pill .dot{width:8px;height:8px;border-radius:9999px;background:currentColor}
.pill.on{border-color:rgba(36,128,82,.5);color:var(--success)}
.pill.bad{border-color:rgba(174,31,31,.5);color:var(--destructive)}
.pulse{animation:pulse 2s ease-in-out infinite}@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:34px;padding:0 16px;font-family:var(--sans);
 font-weight:500;font-size:13px;border-radius:6px;border:1px solid rgba(0,0,0,.25);cursor:pointer;
 background:var(--destructive);color:var(--dfg);box-shadow:0 3px 0 0 rgba(0,0,0,.35);
 transition:transform .1s ease-out,box-shadow .1s ease-out}
.btn:hover{transform:translateY(-1px);box-shadow:0 4px 0 0 rgba(0,0,0,.35)}
.btn:active{transform:translateY(3px);box-shadow:inset 0 3px 6px rgba(0,0,0,.35)}
.btn:disabled{opacity:.35;cursor:default;transform:none;box-shadow:0 3px 0 0 rgba(0,0,0,.2)}
.cost{margin-top:16px}
.cost .big{font-family:var(--mono);font-size:32px;letter-spacing:-.02em;font-variant-numeric:tabular-nums;line-height:1}
.cost .est{font-family:var(--mono);font-size:10px;color:var(--muted-fg);letter-spacing:.12em;text-transform:uppercase;margin-left:9px}
.cost .meta{font-family:var(--mono);font-size:11px;color:var(--muted-fg);margin-top:6px}
.toks{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:12px;margin-top:16px}
.tok .k{font-family:var(--mono);font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted-fg)}
.tok .v{font-family:var(--mono);font-size:16px;font-variant-numeric:tabular-nums;margin-top:3px}
.mrow{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}
.mchip{font-family:var(--mono);font-size:10px;letter-spacing:.04em;border:1px solid var(--border);border-radius:9999px;padding:3px 10px;color:var(--muted-fg)}
.meters{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px}
.meter .top{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.meter .lbl{font-family:var(--mono);font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted-fg);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.meter .val{font-family:var(--mono);font-size:12px;font-variant-numeric:tabular-nums;flex-shrink:0}
.bar{height:5px;background:var(--secondary);border-radius:9999px;margin-top:7px;overflow:hidden}
.bar>i{display:block;height:100%;background:var(--success);transition:width .3s}
.bar.warn>i{background:var(--warnbar)}.bar.full>i{background:var(--destructive)}
.sev{display:inline-flex;align-items:center;border-radius:9999px;border:1px solid;padding:2px 7px;font-family:var(--mono);
 font-size:10px;letter-spacing:.05em;text-transform:uppercase;line-height:1.4;white-space:nowrap}
.sev-crit{color:var(--sev-crit);background:rgba(239,68,68,.10);border-color:rgba(239,68,68,.4)}
.sev-high{color:var(--sev-high);background:rgba(249,115,22,.10);border-color:rgba(249,115,22,.4)}
.sev-med{color:var(--sev-med);background:rgba(245,158,11,.10);border-color:rgba(245,158,11,.4)}
.sev-low{color:var(--sev-low);background:rgba(14,165,233,.10);border-color:rgba(14,165,233,.4)}
.sev-info{color:var(--muted-fg);background:transparent;border-color:var(--border)}
.feed{max-height:340px;overflow:auto}
.ev{display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--hairline)}
.ev:last-child{border-bottom:0}
.ev .t{font-family:var(--mono);font-size:10px;letter-spacing:.1em;color:var(--muted-fg);white-space:nowrap}
.ev .dt{font-family:var(--mono);font-size:12px;color:var(--muted-fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.plan ul{list-style:none;padding:0;margin:0;max-height:200px;overflow:auto}
.plan li{font-family:var(--mono);font-size:12px;padding:3px 0}
.plan li.d{color:var(--muted-fg);text-decoration:line-through}.plan .mk{color:var(--muted-fg)}
.dec{background:var(--secondary);border:1px solid var(--hairline);border-radius:8px;padding:10px 12px;margin-bottom:8px;
 font-family:var(--mono);font-size:12px;white-space:pre-wrap;line-height:1.5}
.wf{border:1px solid var(--hairline);border-radius:8px;padding:10px 12px;margin-bottom:10px;background:var(--secondary)}
.wf:last-child{margin-bottom:0}
.wf-head{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-bottom:8px}
.wf-name{font-family:var(--mono);font-size:12px;font-weight:600;color:var(--fg)}
.wf-badge{font-family:var(--mono);font-size:9px;letter-spacing:.1em;text-transform:uppercase;border-radius:9999px;border:1px solid var(--border);padding:2px 8px;color:var(--muted-fg)}
.wf-badge.wf-run{color:var(--sev-low);border-color:rgba(14,165,233,.4);background:rgba(14,165,233,.10)}
.wf-badge.wf-done{color:var(--sev-med);border-color:var(--border)}
.wf-badge.wf-err{color:var(--sev-crit);border-color:rgba(239,68,68,.4);background:rgba(239,68,68,.10)}
.wf-meta{font-family:var(--mono);font-size:10px;color:var(--muted-fg);margin-left:auto}
.wf-phase{border-left:2px solid var(--border);padding:2px 0 2px 10px;margin:6px 0 6px 3px}
.wf-ptitle{display:flex;align-items:baseline;gap:8px;margin-bottom:3px}
.wf-pname{font-family:var(--mono);font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--fg)}
.wf-pmeta{font-family:var(--mono);font-size:10px;color:var(--muted-fg)}
.wf-agent{display:flex;align-items:center;gap:8px;padding:2px 0}
.wf-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0;background:var(--muted-fg)}
.wf-dot.wf-done{background:var(--sev-med)}
.wf-dot.wf-run{background:var(--sev-low);box-shadow:0 0 0 3px rgba(14,165,233,.18);animation:wfpulse 1.4s ease-in-out infinite}
.wf-dot.wf-queue{background:transparent;border:1px solid var(--muted-fg)}
.wf-dot.wf-err{background:var(--sev-crit)}
@keyframes wfpulse{50%{opacity:.4}}
.wf-alabel{font-family:var(--mono);font-size:11px;color:var(--fg);white-space:nowrap}
.wf-adetail{font-family:var(--mono);font-size:10px;color:var(--muted-fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
.empty{color:var(--muted-fg);padding:6px 0;font-size:12px}
.tabs{display:flex;gap:6px;margin-bottom:16px;flex-wrap:wrap}
.tab{background:transparent;border:1px solid var(--border);color:var(--muted-fg);border-radius:9999px;
 height:28px;padding:0 14px;font-family:var(--mono);font-size:10px;letter-spacing:.12em;text-transform:uppercase;cursor:pointer}
.tab:hover{color:var(--fg);border-color:var(--muted-fg)}
.tab.active{color:var(--fg);border-color:var(--fg)}
.kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px}
.kv .k{font-family:var(--mono);font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted-fg)}
.kv .v{font-family:var(--mono);font-size:15px;font-variant-numeric:tabular-nums;margin-top:3px;word-break:break-word}
.kv .v.good{color:var(--success)}.kv .v.bad{color:var(--destructive)}.kv .v.warn{color:var(--warnbar)}
.xtab{width:100%;border-collapse:collapse;font-family:var(--mono);font-size:12px}
.xtab th,.xtab td{text-align:left;padding:5px 6px;border-bottom:1px solid var(--hairline);
 white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:340px}
.xtab th{color:var(--muted-fg);font-weight:500;text-transform:uppercase;letter-spacing:.06em;font-size:10px}
.xtab td.n{text-align:right;font-variant-numeric:tabular-nums}
.xsearch{display:flex;gap:8px;margin-bottom:10px}
.xsearch input{flex:1;background:var(--secondary);border:1px solid var(--border);color:var(--fg);
 border-radius:6px;padding:7px 11px;font-family:var(--mono);font-size:12px}
.xsearch button{background:var(--fg);color:var(--bg);border:0;border-radius:6px;padding:7px 14px;
 font-family:var(--sans);font-weight:500;font-size:12px;cursor:pointer}
.xhit{padding:7px 0;border-bottom:1px solid var(--hairline)}.xhit:last-child{border:0}
.xhit .sc{font-family:var(--mono);font-size:11px;color:var(--success);font-weight:600}
.xhit .u{font-family:var(--mono);font-size:10px;color:var(--muted-fg);margin-left:8px}
.xhit .tx{font-size:12px;margin-top:3px;color:var(--fg);opacity:.85}
.xlog{margin:0;font-family:var(--mono);font-size:11px;color:var(--muted-fg);white-space:pre-wrap;max-height:160px;overflow:auto}
.hide{display:none}
::-webkit-scrollbar{width:10px;height:10px}::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--hairline);border:2px solid var(--bg);border-radius:9999px}
::selection{background:var(--fg);color:var(--bg)}
/* ---- canvas (DAG) ---- */
.canvas-wrap{position:relative;height:calc(100vh - 170px);min-height:420px;border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;
 background:radial-gradient(circle at 1px 1px,var(--hairline) 1px,transparent 0) 0 0/22px 22px,var(--card)}
.canvas-svg{width:100%;height:100%;display:block;cursor:grab;touch-action:none;user-select:none}
.canvas-svg.grab{cursor:grabbing}
.cv-edge{fill:none;stroke:var(--border);stroke-width:1.5}
.cv-edge.k-after{stroke:var(--muted-fg)}
.cv-edge.k-seq{stroke:var(--sev-low);stroke-width:2}
.cv-edge.k-contains{stroke:var(--hairline)}
.cv-edge.k-verifies{stroke:var(--sev-med);stroke-dasharray:4 3}
.cv-edge.k-fork{stroke:var(--sev-high);stroke-dasharray:1 4;stroke-linecap:round}
/* a conditional edge is NOT a dependency: long dash, its own colour, and it carries
   the condition that was authored so the picture argues for itself */
.cv-edge.k-route{stroke:var(--route);stroke-width:2;stroke-dasharray:9 5}
.cv-elbl{fill:var(--route);font-family:var(--mono);font-size:9px;letter-spacing:.04em;paint-order:stroke;
 stroke:var(--card);stroke-width:3px;stroke-linejoin:round;text-anchor:middle;pointer-events:none}
.cv-node{cursor:grab}
.cv-node .box{fill:var(--secondary);stroke:var(--border);stroke-width:1.5}
.cv-node.sel .box{stroke:var(--fg);stroke-width:2}
.cv-node.s-done .box{stroke:var(--success)}
.cv-node.s-running .box{stroke:var(--sev-low);animation:wfpulse 1.4s ease-in-out infinite}
.cv-node.s-error .box{stroke:var(--destructive)}
.cv-node.s-open .box{stroke-dasharray:5 4}
/* a @human node waiting on a PERSON: it is not running, not failed, not merely open —
   it is stopped ON YOU, and it says so */
.cv-node.s-awaiting .box{fill:var(--secondary);stroke:var(--await);stroke-width:2.5;animation:wfpulse 1.4s ease-in-out infinite}
.cv-node.s-awaiting .kind,.cv-node.s-awaiting .meta{fill:var(--await)}
/* authored node kinds — the shape of the plan, not of the run */
.cv-node.nk-human .box,.cv-node.nk-gate .box{stroke-width:2}
.cv-node.nk-gate .kind{fill:var(--sev-med)}
.cv-node.nk-verify .kind{fill:var(--sev-med)}
.cv-node.nk-human .kind{fill:var(--await)}
.cv-node.nk-tool .kind{fill:var(--sev-low)}
/* a @feedback node reads the RUN itself and may amend the plan within bounds */
.cv-node.nk-feedback .box{stroke-dasharray:2 3}
.cv-node.nk-feedback .kind{fill:var(--route)}
.cv-node .lbl{fill:var(--fg);font-family:var(--mono);font-size:11px}
.cv-node .meta{fill:var(--muted-fg);font-family:var(--mono);font-size:9px}
.cv-node .kind{fill:var(--muted-fg);font-family:var(--mono);font-size:8px;letter-spacing:.14em}
.cv-node.k-phase .box{stroke-width:2}
.canvas-bar{position:absolute;top:10px;left:10px;display:flex;gap:6px;z-index:2}
.canvas-hint{position:absolute;bottom:9px;right:12px;font-family:var(--mono);font-size:9px;color:var(--muted-fg);letter-spacing:.06em;pointer-events:none}
.cbtn{background:var(--card);border:1px solid var(--border);color:var(--muted-fg);border-radius:6px;height:26px;padding:0 11px;
 font-family:var(--mono);font-size:10px;letter-spacing:.08em;text-transform:uppercase;cursor:pointer}
.cbtn:hover{color:var(--fg);border-color:var(--muted-fg)}
.canvas-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--muted-fg);font-size:13px;pointer-events:none}
.canvas-legend{position:absolute;top:10px;right:12px;display:flex;gap:10px;z-index:2;font-family:var(--mono);font-size:9px;color:var(--muted-fg)}
.canvas-legend span{display:inline-flex;align-items:center;gap:4px}
.canvas-legend i{width:12px;height:0;border-top:2px solid currentColor;display:inline-block}
.cv-inspector{position:absolute;top:0;right:0;width:332px;max-width:82%;height:100%;background:var(--card);border-left:1px solid var(--border);
 overflow:auto;padding:15px 16px 26px;z-index:3;box-shadow:-10px 0 26px rgba(0,0,0,.18)}
.cv-inspector .ihead{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.cv-inspector .ikind{font-family:var(--mono);font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted-fg);border:1px solid var(--border);border-radius:9999px;padding:2px 9px}
.cv-inspector .iclose{margin-left:auto;background:transparent;border:0;color:var(--muted-fg);font-size:19px;line-height:1;cursor:pointer}
.cv-inspector .iclose:hover{color:var(--fg)}
.cv-inspector .ititle{font-family:var(--mono);font-size:12px;color:var(--fg);line-height:1.5;margin-bottom:12px;word-break:break-word}
.cv-inspector .ikv{display:grid;grid-template-columns:repeat(auto-fit,minmax(84px,1fr));gap:10px;margin-bottom:6px}
.cv-inspector .ikv .k{font-family:var(--mono);font-size:9px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted-fg)}
.cv-inspector .ikv .v{font-family:var(--mono);font-size:13px;font-variant-numeric:tabular-nums;margin-top:2px;word-break:break-word}
.cv-inspector .isec{font-family:var(--mono);font-size:9px;letter-spacing:.16em;text-transform:uppercase;color:var(--muted-fg);margin:13px 0 6px}
.cv-inspector pre.iprev{background:var(--secondary);border:1px solid var(--hairline);border-radius:6px;padding:9px 10px;font-family:var(--mono);font-size:11px;color:var(--fg);white-space:pre-wrap;word-break:break-word;max-height:190px;overflow:auto;margin:0 0 4px}
.cv-inspector .idec{background:var(--secondary);border:1px solid var(--hairline);border-radius:6px;padding:9px 10px;font-family:var(--mono);font-size:11px;white-space:pre-wrap;line-height:1.5;margin-bottom:8px;color:var(--fg)}
.cv-inspector .iwfnote{font-family:var(--mono);font-size:10px;color:var(--warnbar);margin-bottom:8px;line-height:1.4}
.cv-inspector .isteerrow{display:flex;gap:6px;margin-bottom:6px;flex-wrap:wrap}
.cv-inspector .isteerin{flex:1;min-width:120px;background:var(--secondary);border:1px solid var(--border);color:var(--fg);border-radius:6px;padding:6px 9px;font-family:var(--mono);font-size:11px}
.cv-inspector .cbtn.danger{color:var(--destructive);border-color:rgba(174,31,31,.4)}
.cv-inspector .cbtn.danger:hover{border-color:var(--destructive);color:var(--destructive)}
.cv-inspector .isteerstatus{font-family:var(--mono);font-size:10px;color:var(--success);margin-top:4px;min-height:13px;word-break:break-word}
</style>
<script>try{document.documentElement.className=localStorage.getItem("leo-theme")||"dark"}catch(e){}</script>
</head><body><div class="wrap">
<div class="head">
  <span class="eyebrow">Leopold</span><span class="title">watch</span>
  <span class="proj" id="proj"></span><span class="grow"></span>
  <button class="tgl" id="tgl">theme</button>
</div>
<div class="tabs" id="tabs"></div>
<div id="tab-run">
<div class="card">
  <div class="row">
    <span class="pill" id="status"><span class="dot" id="dot"></span><span id="stext">—</span></span>
    <span class="sub tnum" id="planline" style="font-family:var(--mono);font-size:11px"></span>
    <span class="grow"></span>
    <button class="btn" id="stop" disabled>Stop run</button>
  </div>
  <div class="cost" id="cost"></div>
</div>
<div class="card"><div class="sectitle">Budgets</div><div class="meters" id="meters"></div></div>
<div class="card"><div class="sectitle">Live events</div><div class="feed" id="feed"></div></div>
<div class="card"><div class="sectitle">Plan</div><div id="plan" class="plan"></div></div>
<div class="card" id="wfcard" style="display:none"><div class="sectitle">Dynamic workflows · phase tree</div><div id="workflows"></div></div>
<div class="card"><div class="sectitle">Decisions · newest</div><div id="decisions"></div></div>
</div><!-- /tab-run -->
<div id="tab-canvas" class="hide">
<div class="card" style="padding:0;overflow:hidden">
  <div class="canvas-wrap">
    <div class="canvas-bar">
      <button class="cbtn" id="cv-fit">Fit</button>
      <button class="cbtn" id="cv-dir">Dir: TB</button>
      <button class="cbtn" id="cv-reset">Reset</button>
    </div>
    <div class="canvas-legend">
      <span style="color:var(--sev-low)"><i></i>seq</span>
      <span style="color:var(--muted-fg)"><i></i>dep</span>
      <span style="color:var(--sev-med)"><i></i>verify</span>
      <span style="color:var(--sev-high)"><i></i>fork</span>
      <span style="color:var(--route)"><i style="border-top-style:dashed"></i>route</span>
      <span style="color:var(--await)">◍ awaiting you</span>
    </div>
    <svg class="canvas-svg" id="cv-svg"><g id="cv-view"></g></svg>
    <div class="canvas-hint">drag bg to pan · wheel to zoom · drag node to pin · click to select</div>
    <div class="canvas-empty" id="cv-empty">no graph yet — start a run</div>
    <div class="cv-inspector hide" id="cv-inspector"></div>
  </div>
</div>
</div><!-- /tab-canvas -->
<div id="extviews"></div>
<script src="/leopold-canvas-layout.js"></script>
<script>
const $=s=>document.querySelector(s);
function el(t,c,txt){const e=document.createElement(t);if(c)e.className=c;if(txt!=null)e.textContent=txt;return e;}
function hms(ts){return ts&&ts.length>=19?ts.slice(11,19):"";}
function fmtUsd(x){if(x==null)return"$0";return x>=1?("$"+x.toFixed(2)):("$"+x.toFixed(x>=0.01?3:4));}
function fmtTok(n){return n>=1e6?(n/1e6).toFixed(2)+"M":n>=1e3?(n/1e3).toFixed(1)+"k":(""+(n||0));}
function fmtDur(s){if(!s)return"0m";const h=Math.floor(s/3600),m=Math.floor(s%3600/60);return h?(h+"h"+m+"m"):(m+"m"+(m?"":(s%60+"s")));}
const SEV={guard_block:"sev-crit",state_invalid:"sev-crit",turn_start:"sev-low",stop:"sev-info",subagent_spawn:"sev-med",
  review:"sev-med",hypothesis:"sev-high",item_start:"sev-low",item_done:"sev-info",item_incomplete:"sev-med",merge_conflict:"sev-crit",cost:"sev-low",learn:"sev-high",
  awaiting_human:"sev-high"};
function renderCost(c){
  const box=$("#cost");box.innerHTML="";
  if(!c||!c.available){box.append(el("div","meta",c&&c.reason?c.reason:"waiting for session data… (cost shows once the run has a turn)"));return;}
  const hero=el("div");hero.append(el("span","big",fmtUsd(c.usd)),el("span","est","est · "+(c.models[0]?c.models[0].model.replace("claude-",""):(c.harness||""))));
  box.append(hero);
  const t=c.tokens;
  box.append(el("div","meta",c.messages+" turns · "+fmtTok(t.total)+" tokens · cache "+c.cache_hit_pct+"% · "+fmtDur(c.duration_s)));
  if(c.context_window)box.append(el("div","meta","context "+fmtTok(c.context_tokens)+" / "+fmtTok(c.context_window)+" ("+c.context_pct+"%)"));
  const grid=el("div","toks");
  [["input",t.input],["output",t.output],["cache write",t.cache_write],["cache read",t.cache_read]].forEach(p=>{
    const d=el("div","tok");d.append(el("div","k",p[0]),el("div","v",fmtTok(p[1])));grid.append(d);
  });
  box.append(grid);
  if(c.models&&c.models.length){const mr=el("div","mrow");
    c.models.forEach(m=>mr.append(el("span","mchip",m.model.replace("claude-","")+" · "+fmtUsd(m.usd))));box.append(mr);}
  if(c.sub_msgs)box.append(el("div","meta","main "+fmtUsd(c.main_usd)+" · subagents "+fmtUsd(c.sub_usd)+" ("+c.sub_msgs+" msgs)"));
}
function render(s){
  $("#proj").textContent=s.session_id?("· "+s.session_id):"";
  const pill=$("#status"),dot=$("#dot"),tx=$("#stext");
  pill.className="pill";dot.classList.remove("pulse");
  if(!s.present){tx.textContent="no active run";}
  else if(s.invalid){pill.className="pill bad";tx.textContent="state invalid";}
  else if(s.active){pill.className="pill on";dot.classList.add("pulse");tx.textContent="run active";}
  else{tx.textContent="stopped"+(s.stopped_reason?(" · "+s.stopped_reason):"");}
  $("#planline").textContent=s.plan.total?("plan "+s.plan.done+"/"+s.plan.total):"";
  const stop=$("#stop");stop.disabled=!s.active;stop.textContent=s.stop_requested?"stop requested…":"Stop run";
  renderCost(s.cost);
  const m=$("#meters");m.innerHTML="";
  s.meters.forEach(x=>{
    const pct=x.max>0?Math.min(100,Math.round(x.val/x.max*100)):(x.val>0?100:0);
    const d=el("div","meter"),top=el("div","top");
    top.append(el("span","lbl",x.label),el("span","val tnum",x.val+x.unit+" / "+x.max+x.unit));
    const bar=el("div","bar"+(pct>=100?" full":pct>=75?" warn":"")),i=el("i");i.style.width=pct+"%";bar.append(i);
    d.append(top,bar);m.append(d);
  });
  const f=$("#feed");f.innerHTML="";
  if(!s.events.length)f.append(el("div","empty","no events yet"));
  s.events.forEach(e=>{
    const r=el("div","ev");r.append(el("span","t",hms(e.ts)));
    let sev=SEV[e.event]||"sev-info";
    if(e.event==="subagent_spawn"&&e.fork)sev="sev-high";
    if(e.event==="review"&&e.ok===false)sev="sev-high";
    r.append(el("span","sev "+sev,(e.event||"?").replace(/_/g," ")));
    let d="";
    if(e.event==="turn_start")d="iter "+e.iteration+" · open "+e.open_items+(e.no_progress?(" · stuck "+e.no_progress):"");
    else if(e.event==="guard_block")d=e.tool||"";
    else if(e.event==="subagent_spawn")d=(e.prompt_kb||0)+"KB"+(e.fork?" · FORK":"")+" · #"+(e.total||"");
    else if(e.event==="stop")d="reason: "+(e.reason||"");
    else if(e.event==="state_invalid")d=e.reason||"";
    else if(e.event==="awaiting_human")d="item "+(e.item||"?")+" needs you · "+(e.text||"").slice(0,80);
    else if(e.event==="review")d=(e.ok?"clean":(e.blocking+" blocking"))+" · round "+(e.round||1)+(e.panel?(" · panel "+e.panel):(e.lenses?(" · "+e.lenses+" lens"):""));
    else if(e.event==="hypothesis")d=e.theory?("survivor ("+(e.angle||"?")+", "+(e.confidence==null?"?":e.confidence)+"/10): "+e.theory):("no survivor · "+(e.considered||0)+" considered");
    else if(e.event==="item_start")d=(e.item||"").slice(0,80)+" · effort "+(e.effort||"?")+(e.critical?" · CRITICAL":"");
    else if(e.event==="item_done")d=(e.item||"").slice(0,80)+" · "+(e.open_left==null?"":(e.open_left+" left"));
    else if(e.event==="item_incomplete")d=(e.item||"").slice(0,80)+" · fails "+(e.fails||"?");
    else if(e.event==="merge_conflict")d=(e.item||"").slice(0,60)+" · worktree kept";
    else if(e.event==="cost")d=(e.usd!=null?("+$"+Number(e.usd).toFixed(3)):"")+(e.spent_usd!=null?(" · total $"+Number(e.spent_usd).toFixed(2)):"");
    else if(e.event==="learn")d=(e.proposed>0?(e.proposed+" charter amendment"+(e.proposed==1?"":"s")+" proposed"):"no amendments")+(e.out?(" · "+e.out.split("/").pop()):"");
    r.append(el("span","dt",d));f.append(r);
  });
  const p=$("#plan");p.innerHTML="";
  if(!s.plan.items.length)p.append(el("div","empty","no PLAN.md items"));
  else{const ul=el("ul");s.plan.items.forEach(it=>{const li=el("li",it.done?"d":null);
    li.append(el("span","mk",it.done?"[x] ":"[ ] "));li.append(document.createTextNode(it.text));ul.append(li);});p.append(ul);}
  const dc=$("#decisions");dc.innerHTML="";
  if(!s.decisions.length)dc.append(el("div","empty","none yet"));
  s.decisions.forEach(b=>dc.append(el("div","dec",b)));
  renderWorkflows(s.workflows||[]);
}
function wfDur(ms){if(!ms)return"";const s=Math.round(ms/1000);return s<60?(s+"s"):(Math.floor(s/60)+"m"+(s%60)+"s");}
const WFST={done:"wf-done",running:"wf-run",queued:"wf-queue",error:"wf-err",failed:"wf-err"};
function renderWorkflows(runs){
  const card=$("#wfcard"),box=$("#workflows");
  if(!runs.length){card.style.display="none";return;}
  card.style.display="";box.innerHTML="";
  runs.forEach(r=>{
    const w=el("div","wf");
    const head=el("div","wf-head");
    head.append(el("span","wf-name",r.name));
    const stCls=r.status==="running"?"wf-run":(r.status==="completed"?"wf-done":(r.status?"wf-err":""));
    head.append(el("span","wf-badge "+stCls,r.status||"—"));
    head.append(el("span","wf-meta",r.agentCount+" agents · "+fmtTok(r.totalTokens)+" tok · "+(r.totalToolCalls||0)+" tools"+(r.durationMs?(" · "+wfDur(r.durationMs)):"")));
    w.append(head);
    (r.phases||[]).forEach(ph=>{
      const pe=el("div","wf-phase");
      const pt=el("div","wf-ptitle");
      pt.append(el("span","wf-pname",ph.title));
      pt.append(el("span","wf-pmeta",ph.done+"✓"+(ph.running?(" · "+ph.running+"⋯"):"")+" · "+fmtTok(ph.tokens)+" tok"));
      pe.append(pt);
      (ph.agents||[]).forEach(a=>{
        const ae=el("div","wf-agent");
        ae.append(el("span","wf-dot "+(WFST[a.state]||"wf-queue")));
        ae.append(el("span","wf-alabel",a.label));
        const detail=(a.lastTool?(" · "+a.lastTool):"");
        ae.append(el("span","wf-adetail",fmtTok(a.tokens)+"tok · "+a.toolCalls+"tc"+detail));
        pe.append(ae);
      });
      w.append(pe);
    });
    box.append(w);
  });
}
$("#stop").addEventListener("click",()=>{
  if(!confirm("Stop the run at the next turn boundary? (touches .leopold/STOP)"))return;
  fetch("/api/stop",{method:"POST"}).then(()=>{const b=$("#stop");b.textContent="stop requested…";b.disabled=true;});
});
$("#tgl").addEventListener("click",()=>{
  const d=document.documentElement.className!=="dark";document.documentElement.className=d?"dark":"light";
  try{localStorage.setItem("leo-theme",d?"dark":"light")}catch(e){}
});
fetch("/api/state").then(r=>r.json()).then(render).catch(()=>{});
const es=new EventSource("/api/events");
es.onmessage=ev=>{try{render(JSON.parse(ev.data))}catch(_){}};

// ---- Canvas: live DAG (zero-dep SVG over the hand-rolled layout) ----
const Canvas=(()=>{
  const SVG="http://www.w3.org/2000/svg";
  const NW=176,NH=52;
  let vp={x:40,y:40,k:1},dir="TB",timer=null,sig="",nodes=[],edges=[],selId=null,P={},pinned={},drag=null,fitted=false,wired=false,selectCb=null;
  const svg=()=>document.getElementById("cv-svg");
  const view=()=>document.getElementById("cv-view");
  function pkey(){try{return (document.getElementById("proj").textContent||"x")}catch(e){return "x"}}
  function loadPinned(){try{return JSON.parse(localStorage.getItem("leo-cvpos-"+pkey())||"{}")}catch(e){return {}}}
  function savePinned(){try{localStorage.setItem("leo-cvpos-"+pkey(),JSON.stringify(pinned))}catch(e){}}
  function e(t,a,c){const n=document.createElementNS(SVG,t);if(c)n.setAttribute("class",c);for(const k in(a||{}))n.setAttribute(k,a[k]);return n;}
  function txt(x,y,s,c){const n=e("text",{x,y},c);n.textContent=s;return n;}
  function clip(s,n){s=s||"";return s.length>n?s.slice(0,n-1)+"…":s;}
  function applyVp(){view().setAttribute("transform","translate("+vp.x+","+vp.y+") scale("+vp.k+")");}
  function scls(st){st=(st||"").toLowerCase();return st==="done"?"s-done":(st==="running"||st==="queued")?"s-running":(st==="error"||st==="failed")?"s-error":st==="awaiting"?"s-awaiting":st==="open"?"s-open":"";}
  // A node's classes: the canvas kind, the AUTHORED kind (@gate/@human/@tool/@verify/@feedback)
  // when the plan declared one, and the run state.
  function ncls(n){return "cv-node k-"+(n.kind||"")+(n.nodeKind?" nk-"+n.nodeKind:"")+" "+scls(n.state)+(n.id===selId?" sel":"");}
  // The badge a node wears: what you authored wins over what the canvas calls it.
  function nkind(n){return ((n.nodeKind||n.kind||"")+(n.nodeLabel?" · "+n.nodeLabel:"")).toUpperCase();}
  function nmeta(n){if((n.state||"")==="awaiting")return "needs you";
    return (n.tokens?fmtTok(n.tokens)+"tok":"")+(n.model?(" · "+n.model):"");}
  function anchor(p,side){if(dir==="LR")return side==="out"?[p.x+NW,p.y+NH/2]:[p.x,p.y+NH/2];return side==="out"?[p.x+NW/2,p.y+NH]:[p.x+NW/2,p.y];}
  // `bow` bends the curve sideways: a route edge is bowed so it stays readable even
  // when it runs between the same two nodes as a static (after:) edge.
  function edgeD(a,b,bow){bow=bow||0;const o=anchor(a,"out"),i=anchor(b,"in");
    if(dir==="LR"){const mx=(o[0]+i[0])/2;return "M"+o[0]+","+o[1]+" C"+mx+","+(o[1]+bow)+" "+mx+","+(i[1]+bow)+" "+i[0]+","+i[1];}
    const my=(o[1]+i[1])/2;return "M"+o[0]+","+o[1]+" C"+(o[0]+bow)+","+my+" "+(i[0]+bow)+","+my+" "+i[0]+","+i[1];}
  function bowOf(ed){return ed.kind==="route"?34:0;}
  function relayout(){
    if(!window.LeopoldLayout)return;
    const r=window.LeopoldLayout.layout(nodes,edges,{dir:dir,nodeW:NW+30,nodeH:NH+34});
    P=r.positions;
    for(const id in pinned){if(P[id])P[id]={x:pinned[id].x,y:pinned[id].y,layer:P[id].layer,order:P[id].order};}
    draw();
  }
  // A point ON the curve (the same cubic edgeD draws), so a condition label sits on its
  // own edge. t=.3 rather than the midpoint: two routes between the same pair in
  // opposite directions then label at different points instead of writing over each other.
  function edgePt(a,b,bow,t){bow=bow||0;t=(t==null?0.3:t);
    const o=anchor(a,"out"),i=anchor(b,"in");let c1,c2;
    if(dir==="LR"){const mx=(o[0]+i[0])/2;c1=[mx,o[1]+bow];c2=[mx,i[1]+bow];}
    else{const my=(o[1]+i[1])/2;c1=[o[0]+bow,my];c2=[i[0]+bow,my];}
    const u=1-t,k0=u*u*u,k1=3*u*u*t,k2=3*u*t*t,k3=t*t*t;
    return [k0*o[0]+k1*c1[0]+k2*c2[0]+k3*i[0],k0*o[1]+k1*c1[1]+k2*c2[1]+k3*i[1]-3];}
  function draw(){
    const g=view();g.innerHTML="";
    edges.forEach(ed=>{const a=P[ed.from],b=P[ed.to];if(!a||!b)return;g.append(e("path",{d:edgeD(a,b,bowOf(ed))},"cv-edge k-"+ed.kind));});
    nodes.forEach(n=>{const p=P[n.id];if(!p)return;
      const gg=e("g",{transform:"translate("+p.x+","+p.y+")","data-id":n.id},ncls(n));
      gg.append(e("rect",{x:0,y:0,width:NW,height:NH,rx:9},"box"));
      gg.append(txt(11,16,clip(nkind(n),24),"kind"));
      gg.append(txt(11,32,clip(n.label,25),"lbl"));
      gg.append(txt(11,46,nmeta(n),"meta"));
      g.append(gg);});
    // The condition a route edge carries, drawn on top of the nodes so it always reads.
    edges.forEach(ed=>{if(!ed.when)return;const a=P[ed.from],b=P[ed.to];if(!a||!b)return;
      const m=edgePt(a,b,bowOf(ed));g.append(txt(m[0],m[1],clip(ed.when,26),"cv-elbl"));});
    const em=document.getElementById("cv-empty");if(em)em.style.display=nodes.length?"none":"";
  }
  function redrawEdges(){const v=view(),paths=v.querySelectorAll(".cv-edge"),lbls=v.querySelectorAll(".cv-elbl");let i=0,j=0;
    edges.forEach(ed=>{const a=P[ed.from],b=P[ed.to];if(!a||!b)return;const pt=paths[i++];if(pt)pt.setAttribute("d",edgeD(a,b,bowOf(ed)));
      if(ed.when){const lb=lbls[j++];if(lb){const m=edgePt(a,b,bowOf(ed));lb.setAttribute("x",m[0]);lb.setAttribute("y",m[1]);}}});}
  function updateStates(){const map={};view().querySelectorAll(".cv-node").forEach(nd=>map[nd.getAttribute("data-id")]=nd);
    nodes.forEach(n=>{const nd=map[n.id];if(!nd)return;nd.setAttribute("class",ncls(n));
      const mt=nd.querySelector(".meta");if(mt)mt.textContent=nmeta(n);});}
  function select(id){selId=id;view().querySelectorAll(".cv-node").forEach(nd=>nd.classList.toggle("sel",nd.getAttribute("data-id")===id));if(selectCb)selectCb(id);}
  function onDown(ev){const nodeEl=ev.target.closest(".cv-node");
    if(nodeEl){const id=nodeEl.getAttribute("data-id");if(!P[id])return;drag={mode:"node",id,el:nodeEl,sx:ev.clientX,sy:ev.clientY,px:P[id].x,py:P[id].y,moved:false};}
    else{drag={mode:"pan",sx:ev.clientX,sy:ev.clientY,ox:vp.x,oy:vp.y};svg().classList.add("grab");}}
  function onMove(ev){if(!drag)return;
    if(drag.mode==="pan"){vp.x=drag.ox+(ev.clientX-drag.sx);vp.y=drag.oy+(ev.clientY-drag.sy);applyVp();}
    else{const sdx=ev.clientX-drag.sx,sdy=ev.clientY-drag.sy;if(Math.abs(sdx)+Math.abs(sdy)>3)drag.moved=true;
      P[drag.id].x=drag.px+sdx/vp.k;P[drag.id].y=drag.py+sdy/vp.k;drag.el.setAttribute("transform","translate("+P[drag.id].x+","+P[drag.id].y+")");redrawEdges();}}
  function onUp(){if(!drag)return;if(drag.mode==="pan")svg().classList.remove("grab");
    else if(drag.moved){pinned[drag.id]={x:P[drag.id].x,y:P[drag.id].y};savePinned();}else select(drag.id);drag=null;}
  function onWheel(ev){ev.preventDefault();const r=svg().getBoundingClientRect(),mx=ev.clientX-r.left,my=ev.clientY-r.top,f=ev.deltaY<0?1.1:1/1.1,nk=Math.min(2.5,Math.max(0.2,vp.k*f));vp.x=mx-(mx-vp.x)/vp.k*nk;vp.y=my-(my-vp.y)/vp.k*nk;vp.k=nk;applyVp();}
  function fit(){if(!nodes.length)return;let a=1e9,b=1e9,c=-1e9,d=-1e9;nodes.forEach(n=>{const p=P[n.id];if(!p)return;a=Math.min(a,p.x);b=Math.min(b,p.y);c=Math.max(c,p.x+NW);d=Math.max(d,p.y+NH);});
    const s=svg().getBoundingClientRect(),gw=c-a||1,gh=d-b||1,k=Math.min(2,Math.max(0.2,Math.min((s.width-70)/gw,(s.height-70)/gh)));vp.k=k;vp.x=(s.width-gw*k)/2-a*k;vp.y=(s.height-gh*k)/2-b*k;applyVp();}
  async function tick(){let g;try{g=await(await fetch("/api/graph")).json();}catch(e){return;}
    nodes=g.nodes||[];edges=g.edges||[];
    // The signature covers the AUTHORED graph too: edit a kind or a route condition in
    // PLAN.md and the canvas redraws, instead of showing yesterday's plan.
    const ns=nodes.map(n=>n.id+(n.nodeKind||"")).sort().join(",")+"|"+edges.map(ed=>ed.kind+(ed.when||"")).join(",")+"|"+dir;
    if(ns!==sig){sig=ns;relayout();if(!fitted&&nodes.length){fitted=true;setTimeout(fit,20);}}else updateStates();}
  return {
    start(){pinned=loadPinned();
      if(!wired){const s=svg();s.addEventListener("mousedown",onDown);window.addEventListener("mousemove",onMove);window.addEventListener("mouseup",onUp);s.addEventListener("wheel",onWheel,{passive:false});
        document.getElementById("cv-fit").onclick=fit;
        document.getElementById("cv-reset").onclick=()=>{pinned={};savePinned();sig="";fitted=false;tick();};
        document.getElementById("cv-dir").onclick=ev=>{dir=dir==="TB"?"LR":"TB";ev.target.textContent="Dir: "+dir;sig="";fitted=false;tick();};
        wired=true;}
      tick();if(timer)clearInterval(timer);timer=setInterval(tick,2000);},
    stop(){if(timer){clearInterval(timer);timer=null;}},
    setOnSelect(fn){selectCb=fn;},
  };
})();

// ---- Canvas node inspector (side panel; polls the selected node while open) ----
const Inspector=(()=>{
  let openId=null,timer=null;
  const box=()=>document.getElementById("cv-inspector");
  function kv(k,v){const d=el("div");d.append(el("div","k",k),el("div","v",v==null||v===""?"—":String(v)));return d;}
  async function load(id){
    const inp=document.querySelector('#cv-inspector .isteerin');
    if(inp&&(inp===document.activeElement||inp.value.trim()))return; // don't clobber in-progress steering
    let d;try{d=await(await fetch("/api/node/"+encodeURIComponent(id))).json();}catch(e){return;}if(openId!==id)return;render(d);}
  function render(d){
    const b=box();b.innerHTML="";
    const head=el("div","ihead");head.append(el("span","ikind",(d.nodeKind||d.kind||"node").toUpperCase()+(d.nodeLabel?" · "+d.nodeLabel:"")));
    const x=el("button","iclose","×");x.onclick=close;head.append(x);b.append(head);
    if(d.error){b.append(el("div","ititle",d.error));return;}
    b.append(el("div","ititle",d.label||d.id));
    const g=el("div","ikv");
    if(d.state)g.append(kv("state",d.state));
    if(d.model)g.append(kv("model",d.model));
    if(d.tokens!=null&&(d.tokens||d.kind!=="item"))g.append(kv("tokens",fmtTok(d.tokens)));
    if(d.estUsd!=null&&d.estUsd>0)g.append(kv("est cost","≈"+fmtUsd(d.estUsd)));
    if(d.toolCalls!=null)g.append(kv("tools",d.toolCalls));
    if(d.durationMs)g.append(kv("duration",fmtDur(Math.round(d.durationMs/1000))));
    if(d.attempt&&d.attempt>1)g.append(kv("attempt",d.attempt));
    if(d.phase)g.append(kv("phase",d.phase));
    if(d.position!=null)g.append(kv("plan #",d.position));
    if(d.round!=null)g.append(kv("round",d.round));
    if(d.confidence!=null)g.append(kv("confidence",d.confidence+"/10"));
    if(g.children.length)b.append(g);
    if(d.after&&d.after.length){b.append(el("div","isec","depends on"));b.append(el("div","idec","plan items "+d.after.join(", ")));}
    if(d.needs&&d.needs.length){b.append(el("div","isec","needs signals"));b.append(el("div","idec",d.needs.join(", ")));}
    if(d.emits&&d.emits.length){b.append(el("div","isec","emits signals"));b.append(el("div","idec",d.emits.join("\n")));}
    if(d.routes&&d.routes.length){b.append(el("div","isec","routes"));b.append(el("div","idec",d.routes.join("\n")));}
    if(d.theory){b.append(el("div","isec","hypothesis"));b.append(el("div","idec",d.theory));}
    if(d.detail){b.append(el("div","isec","verdict"));b.append(el("div","idec",d.detail));}
    if(d.promptPreview){b.append(el("div","isec","prompt"));b.append(el("pre","iprev",d.promptPreview));}
    if(d.resultPreview){b.append(el("div","isec","result"));b.append(el("pre","iprev",d.resultPreview));}
    if(d.decisions&&d.decisions.length){b.append(el("div","isec","decisions"));d.decisions.forEach(t=>b.append(el("div","idec",t)));}
    if(!d.error)renderActions(b,d);
  }
  function renderActions(b,d){
    b.append(el("div","isec","steer"));
    if((d.source||"").startsWith("workflow"))b.append(el("div","iwfnote","workflow node — steer applies on the next resume/re-run (runtime isn't preemptible)"));
    const inp=el("input","isteerin");inp.placeholder="redirect / inject text…";
    const r1=el("div","isteerrow");
    const bR=el("button","cbtn","Redirect");bR.onclick=()=>send("redirect",d,inp.value);
    const bI=el("button","cbtn","Inject");bI.onclick=()=>send("inject",d,inp.value);
    r1.append(inp,bR,bI);b.append(r1);
    const r2=el("div","isteerrow");
    const bRe=el("button","cbtn","Re-run");bRe.onclick=()=>send("rerun-item",d,"");
    let armed=false;const bK=el("button","cbtn danger","Kill");
    bK.onclick=()=>{if(!armed){armed=true;bK.textContent="Confirm kill?";setTimeout(()=>{armed=false;bK.textContent="Kill";},2500);}else{armed=false;bK.textContent="Kill";send("kill-item",d,"");}};
    r2.append(bRe,bK);b.append(r2);
    b.append(el("div","isteerstatus"));
  }
  async function send(cmd,d,text){
    if((cmd==="redirect"||cmd==="inject")&&!(text||"").trim()){setStatus("type a note first");return;}
    setStatus("sending…");
    let r;try{r=await(await fetch("/api/command",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({cmd,nodeId:d.id,source:d.source||"",text:text||""})})).json();}catch(e){setStatus("failed");return;}
    setStatus(r.ok?("✓ "+cmd+" · "+(r.applied||"")+(r.note?(" — "+r.note):"")):("error: "+(r.error||"?")));
    const inp=document.querySelector('#cv-inspector .isteerin');if(inp&&(cmd==="redirect"||cmd==="inject"))inp.value="";
  }
  function setStatus(s){const e2=document.querySelector('#cv-inspector .isteerstatus');if(e2)e2.textContent=s;}
  function open(id){openId=id;box().classList.remove("hide");load(id);if(timer)clearInterval(timer);timer=setInterval(()=>{if(openId)load(openId);},2500);}
  function close(){openId=null;box().classList.add("hide");if(timer){clearInterval(timer);timer=null;}}
  return {open,close};
})();
Canvas.setOnSelect(id=>Inspector.open(id));

// ---- tabs: Run (SSE) + Canvas + one per extension dashboard (polled) ----
let curTab="run",extTimer=null;
function setTab(name){
  curTab=name;
  document.querySelectorAll(".tab").forEach(b=>b.classList.toggle("active",b.dataset.tab===name));
  $("#tab-run").classList.toggle("hide",name!=="run");
  $("#tab-canvas").classList.toggle("hide",name!=="canvas");
  document.querySelectorAll("[data-extview]").forEach(v=>v.classList.toggle("hide",v.dataset.extview!==name));
  try{localStorage.setItem("leo-tab",name)}catch(e){}
  if(extTimer){clearInterval(extTimer);extTimer=null;}
  if(name==="canvas")Canvas.start();else Canvas.stop();
  if(name!=="run"&&name!=="canvas"){loadExt(name);extTimer=setInterval(()=>loadExt(name),5000);}
}
async function loadExt(name){
  const host=document.querySelector('[data-extview="'+name+'"]');if(!host)return;
  const inp=host.querySelector(".xsearch input");        // don't clobber an in-progress search
  if(inp&&(inp===document.activeElement||inp.value.trim()))return;
  let v;try{v=await (await fetch("/api/ext/"+encodeURIComponent(name)+"/stats")).json();}catch(e){return;}
  renderView(host,name,v);
}
function widgetEl(name,w){
  if(w.kind==="kpis"){
    const g=el("div","kv");
    (w.items||[]).forEach(it=>{const d=el("div");d.append(el("div","k",it.label));
      const v=el("div","v"+(it.tone&&it.tone!=="none"?(" "+it.tone):""));v.textContent=it.value;d.append(v);g.append(d);});
    return g;
  }
  if(w.kind==="bars"){
    const wrap=el("div","meters"),items=w.items||[],mx=Math.max(1,...items.map(x=>x.max||x.value||0));
    items.forEach(it=>{const m=el("div","meter"),top=el("div","top");
      const lbl=el("span","lbl",it.label);lbl.title=it.label;
      top.append(lbl,el("span","val tnum",""+it.value));
      const bar=el("div","bar"),i=el("i");i.style.width=Math.round(100*(it.value||0)/(it.max||mx))+"%";bar.append(i);
      m.append(top,bar);wrap.append(m);});
    return wrap;
  }
  if(w.kind==="table"){
    const t=el("table","xtab"),cols=w.columns||[],rows=w.rows||[];
    if(cols.length){const tr=el("tr");cols.forEach((c,i)=>tr.append(el("th",i>0?"n":null,c)));
      const th=el("thead");th.append(tr);t.append(th);}
    const tb=el("tbody");
    rows.forEach(row=>{const tr=el("tr");row.forEach((cell,i)=>{
      const td=el("td",(i>0&&typeof cell==="number")?"n":null);td.textContent=cell;tr.append(td);});tb.append(tr);});
    if(!rows.length){const tr=el("tr"),td=el("td","empty","empty");td.colSpan=Math.max(1,cols.length);tr.append(td);tb.append(tr);}
    t.append(tb);return t;
  }
  if(w.kind==="search"){
    const box=el("div"),row=el("div","xsearch"),inp=el("input"),btn=el("button",null,"Search"),res=el("div");
    inp.placeholder=w.placeholder||"search…";
    const go=async()=>{const q=inp.value.trim();if(!q)return;res.textContent="searching…";
      let r;try{r=await (await fetch("/api/ext/"+encodeURIComponent(name)+"/search?q="+encodeURIComponent(q))).json();}
      catch(e){res.textContent="failed";return;}
      res.innerHTML="";if(r.error){res.append(el("div","empty",r.error));return;}
      if(!(r.hits||[]).length){res.append(el("div","empty","no results"));return;}
      r.hits.forEach(h=>{const d=el("div","xhit"),t=el("div");
        t.append(el("span","sc",h.score!=null?h.score.toFixed(3):""),el("span","u",h.uri||""));
        d.append(t);if(h.text)d.append(el("div","tx",h.text));res.append(d);});};
    btn.onclick=go;inp.addEventListener("keydown",e=>{if(e.key==="Enter")go();});
    row.append(inp,btn);box.append(row,res);return box;
  }
  if(w.kind==="log"){const pre=el("pre","xlog");pre.textContent=(w.lines||[]).join("\n");return pre;}
  return el("div");
}
function renderView(host,name,v){
  host.innerHTML="";
  const cards=(v&&v.cards)||[];
  if(v&&v.error){const c=el("div","card");c.append(el("div","empty","error: "+v.error));host.append(c);}
  cards.forEach(card=>{const c=el("div","card");c.append(el("div","sectitle",card.title||""));
    (card.widgets||[]).forEach(w=>c.append(widgetEl(name,w)));host.append(c);});
  if(!cards.length&&!(v&&v.error)){const c=el("div","card");c.append(el("div","empty","no data"));host.append(c);}
}
(async()=>{
  let exts=[];try{exts=await (await fetch("/api/ext")).json();}catch(e){}
  const nav=$("#tabs"),views=$("#extviews");
  const mk=(tab,label)=>{const b=el("button","tab",label);b.dataset.tab=tab;b.onclick=()=>setTab(tab);nav.append(b);};
  mk("run","Run");mk("canvas","Canvas");
  exts.forEach(e=>{mk(e.name,e.label);const v=el("div","hide");v.dataset.extview=e.name;views.append(v);});
  let start="run";try{start=localStorage.getItem("leo-tab")||"run";}catch(e){}
  if(start!=="run"&&start!=="canvas"&&!exts.some(e=>e.name===start))start="run";
  setTab(start);
})();
</script></body></html>"""


# --------------------------------------------------------------------------- server
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def _send(self, code, ctype, body):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _serve_asset(self, name, ctype):
        """Serve a sibling static file (the canvas layout JS) from the script's dir."""
        here = os.path.dirname(os.path.abspath(__file__))
        try:
            with open(os.path.join(here, name), "rb") as f:
                self._send(200, ctype, f.read())
        except OSError:
            self._send(404, "text/plain", b"not found")

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/":
            self._send(200, "text/html; charset=utf-8", PAGE.encode())
        elif path == "/leopold-canvas-layout.js":
            self._serve_asset("leopold-canvas-layout.js", "application/javascript; charset=utf-8")
        elif path == "/api/state":
            self._send(200, "application/json", json.dumps(snapshot()).encode())
        elif path == "/api/graph":
            self._send(200, "application/json", json.dumps(graph()).encode())
        elif path.startswith("/api/node/"):
            nid = urllib.parse.unquote(path[len("/api/node/"):])
            self._send(200, "application/json", json.dumps(node_detail(nid)).encode())
        elif path == "/api/events":
            self._sse()
        elif path == "/api/ext":
            tabs = [{"name": e["name"], "label": e["label"], "search": bool(e["search"])}
                    for e in ext_dashboards()]
            self._send(200, "application/json", json.dumps(tabs).encode())
        elif path.startswith("/api/ext/"):
            self._ext_route(path)
        else:
            self._send(404, "text/plain", b"not found")

    def _ext_route(self, path):
        parts = path.split("/")  # ['', 'api', 'ext', '<name>', 'stats'|'search']
        if len(parts) != 5:
            self._send(404, "text/plain", b"not found")
            return
        name, action = urllib.parse.unquote(parts[3]), parts[4]
        e = ext_by_name(name)
        if not e:
            self._send(404, "application/json", b'{"error":"unknown extension"}')
            return
        if action == "stats":
            try:
                body = json.dumps(e["view"]())
            except Exception as ex:
                body = json.dumps({"cards": [], "error": str(ex)})
            self._send(200, "application/json", body.encode())
        elif action == "search":
            if not e["search"]:
                self._send(404, "application/json", b'{"hits":[]}')
                return
            q = ""
            if "?" in self.path:
                q = urllib.parse.parse_qs(self.path.split("?", 1)[1]).get("q", [""])[0]
            try:
                body = json.dumps(e["search"](q))
            except Exception as ex:
                body = json.dumps({"hits": [], "error": str(ex)})
            self._send(200, "application/json", body.encode())
        else:
            self._send(404, "text/plain", b"not found")

    def _json_body(self):
        try:
            length = int(self.headers.get("Content-Length", 0) or 0)
            raw = self.rfile.read(length) if length else b"{}"
            body = json.loads(raw or b"{}")
            return body if isinstance(body, dict) else {}
        except (ValueError, OSError):
            return None

    # JSON POST endpoints -> (http_code, result_dict). All are steer/task writes only.
    # Plain functions stored in a dict (not staticmethod, so it stays callable on 3.8).
    _POST = {
        "/api/command": apply_canvas_command,
    }

    def do_POST(self):
        p = self.path.split("?", 1)[0]
        if p == "/api/stop":
            try:
                open(os.path.join(LEO, "STOP"), "a").close()
                self._send(200, "application/json", b'{"ok":true}')
            except OSError as e:
                self._send(500, "application/json", json.dumps({"ok": False, "error": str(e)}).encode())
            return
        fn = self._POST.get(p)
        if not fn:
            self._send(404, "text/plain", b"not found")
            return
        body = self._json_body()
        if body is None:
            self._send(400, "application/json", b'{"ok":false,"error":"bad json"}')
            return
        try:
            code, result = fn(body)
        except OSError as e:
            code, result = 500, {"ok": False, "error": str(e)}
        self._send(code, "application/json", json.dumps(result).encode())

    def _sse(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        last, beat = None, 0
        try:
            while True:
                data = json.dumps(snapshot())
                if data != last:
                    self.wfile.write(b"data: " + data.encode() + b"\n\n")
                    self.wfile.flush()
                    last = data
                beat += 1
                if beat % 15 == 0:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                time.sleep(1.0)
        except (BrokenPipeError, ConnectionResetError):
            return


def main():
    global LEO, PROJECT
    ap = argparse.ArgumentParser(description="Local live dashboard for a Leopold run.")
    ap.add_argument("--project", default=os.getcwd(), help="project dir containing .leopold/ (default: cwd)")
    ap.add_argument("--port", type=int, default=int(os.environ.get("LEOPOLD_WATCH_PORT", "4179")))
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args()
    PROJECT = os.path.abspath(args.project)
    LEO = os.path.join(PROJECT, ".leopold")
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.daemon_threads = True
    url = "http://%s:%d" % (args.host, args.port)
    print("Leopold watch -> %s   (project: %s)" % (url, args.project))
    print("Reading: %s + the session transcript   ·   Ctrl-C to stop" % LEO)
    tabs = ext_dashboards()  # warm the cache once (single-threaded) + surface what's wired
    if tabs:
        print("Extension tabs: %s" % ", ".join(e["label"] for e in tabs))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Leopold watch — a local, zero-dependency live dashboard for an autonomous run.

It reads the run's own files in `.leopold/` (state.json, PLAN.md, DECISIONS.md,
events.jsonl) AND the Claude Code session transcript (for real token/cost data), and
serves a dashboard on 127.0.0.1 with live (SSE) updates. Read-only except one action:
a Stop button that touches `.leopold/STOP` — the same kill switch `/leopold-stop` uses.

Cost is parsed from the transcript JSONL (each assistant message carries `usage` +
`model`); the dashboard finds it via the run state's `transcript_path` or by the cwd's
project slug under ~/.claude/projects/. Cost is an ESTIMATE from a built-in price map.

No dependencies (Python 3.8+ stdlib). Nothing leaves the machine; it binds to loopback
and uses no web fonts. Usage:

    python3 leopold-watch.py [--project DIR] [--port 4179] [--host 127.0.0.1]
"""
import argparse
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


def read_plan():
    items, done, opened = [], 0, 0
    for line in _read("PLAN.md").splitlines():
        s = line.strip()
        if s.startswith("- [ ]"):
            opened += 1
            items.append({"done": False, "text": s[5:].strip()})
        elif s.lower().startswith("- [x]"):
            done += 1
            items.append({"done": True, "text": s[5:].strip()})
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
           if ("Fork:" in b or "Decision:" in b or "Decisão:" in b)]
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
PRICES = {
    "opus":   {"in": 15.0, "out": 75.0},
    "sonnet": {"in": 3.0,  "out": 15.0},
    "haiku":  {"in": 1.0,  "out": 5.0},
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


def find_transcript():
    # 1) explicit path recorded by the Stop hook (the run's actual session).
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
        return None
    return max(files, key=os.path.getmtime) if files else None


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
    result = _parse_cost(tp)
    _COST_CACHE[tp] = (st.st_mtime, st.st_size, result)
    return result


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
        "ts": int(time.time()),
    }


# --------------------------------------------------------------------------- extension dashboards
# A small plugin system: any installed extension whose extension.json carries a
# `dashboard` block contributes a tab. The block names a Python module + a `view`
# callable returning a declarative card/widget view ({"cards":[...]}), and an optional
# `search` callable. The watch imports the module and renders the view with its own
# design system. Any failure drops that extension silently — the tab just won't appear.
_EXT_CACHE = None


def _ext_dirs():
    here = os.path.dirname(os.path.abspath(__file__))
    out = []
    for cand in (os.path.join(here, "..", "extensions"),
                 os.path.expanduser("~/.claude/leopold/extensions")):
        cand = os.path.abspath(cand)
        if os.path.isdir(cand) and cand not in out:
            out.append(cand)
    return out


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
                mod_path = os.path.expanduser(dash.get("module", ""))
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
 --sans:"Geist","Neue Montreal","General Sans","Inter",ui-sans-serif,system-ui,sans-serif;
 --mono:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
html.dark{
 --bg:#0a0a0a;--fg:#d9d9d9;--card:#0a0a0a;--secondary:#1a1a1a;--muted-fg:#808080;
 --border:#262626;--ring:#d9d9d9;--destructive:#7d2020;--dfg:#fafafa;--success:#45c98a;
 --hairline:rgba(217,217,217,.15);
 --sev-crit:#fecaca;--sev-high:#fed7aa;--sev-med:#fde68a;--sev-low:#bae6fd;--warnbar:#d29922;
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
<div class="card"><div class="sectitle">Decisions · newest</div><div id="decisions"></div></div>
</div><!-- /tab-run -->
<div id="extviews"></div>
<script>
const $=s=>document.querySelector(s);
function el(t,c,txt){const e=document.createElement(t);if(c)e.className=c;if(txt!=null)e.textContent=txt;return e;}
function hms(ts){return ts&&ts.length>=19?ts.slice(11,19):"";}
function fmtUsd(x){if(x==null)return"$0";return x>=1?("$"+x.toFixed(2)):("$"+x.toFixed(x>=0.01?3:4));}
function fmtTok(n){return n>=1e6?(n/1e6).toFixed(2)+"M":n>=1e3?(n/1e3).toFixed(1)+"k":(""+(n||0));}
function fmtDur(s){if(!s)return"0m";const h=Math.floor(s/3600),m=Math.floor(s%3600/60);return h?(h+"h"+m+"m"):(m+"m"+(m?"":(s%60+"s")));}
const SEV={guard_block:"sev-crit",state_invalid:"sev-crit",turn_start:"sev-low",stop:"sev-info",subagent_spawn:"sev-med"};
function renderCost(c){
  const box=$("#cost");box.innerHTML="";
  if(!c||!c.available){box.append(el("div","meta","waiting for session data… (cost shows once the run has a turn)"));return;}
  const hero=el("div");hero.append(el("span","big",fmtUsd(c.usd)),el("span","est","est · "+(c.models[0]?c.models[0].model.replace("claude-",""):"")));
  box.append(hero);
  const t=c.tokens;
  box.append(el("div","meta",c.messages+" turns · "+fmtTok(t.total)+" tokens · cache "+c.cache_hit_pct+"% · "+fmtDur(c.duration_s)));
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
    r.append(el("span","sev "+sev,(e.event||"?").replace(/_/g," ")));
    let d="";
    if(e.event==="turn_start")d="iter "+e.iteration+" · open "+e.open_items+(e.no_progress?(" · stuck "+e.no_progress):"");
    else if(e.event==="guard_block")d=e.tool||"";
    else if(e.event==="subagent_spawn")d=(e.prompt_kb||0)+"KB"+(e.fork?" · FORK":"")+" · #"+(e.total||"");
    else if(e.event==="stop")d="reason: "+(e.reason||"");
    else if(e.event==="state_invalid")d=e.reason||"";
    r.append(el("span","dt",d));f.append(r);
  });
  const p=$("#plan");p.innerHTML="";
  if(!s.plan.items.length)p.append(el("div","empty","no PLAN.md items"));
  else{const ul=el("ul");s.plan.items.forEach(it=>{const li=el("li",it.done?"d":null);
    li.append(el("span","mk",it.done?"[x] ":"[ ] "));li.append(document.createTextNode(it.text));ul.append(li);});p.append(ul);}
  const dc=$("#decisions");dc.innerHTML="";
  if(!s.decisions.length)dc.append(el("div","empty","none yet"));
  s.decisions.forEach(b=>dc.append(el("div","dec",b)));
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

// ---- tabs: Run (SSE) + one per extension dashboard (polled) ----
let curTab="run",extTimer=null;
function setTab(name){
  curTab=name;
  document.querySelectorAll(".tab").forEach(b=>b.classList.toggle("active",b.dataset.tab===name));
  $("#tab-run").classList.toggle("hide",name!=="run");
  document.querySelectorAll("[data-extview]").forEach(v=>v.classList.toggle("hide",v.dataset.extview!==name));
  try{localStorage.setItem("leo-tab",name)}catch(e){}
  if(extTimer){clearInterval(extTimer);extTimer=null;}
  if(name!=="run"){loadExt(name);extTimer=setInterval(()=>loadExt(name),5000);}
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
  mk("run","Run");
  exts.forEach(e=>{mk(e.name,e.label);const v=el("div","hide");v.dataset.extview=e.name;views.append(v);});
  if(!exts.length)nav.classList.add("hide");                // no extensions -> plain single page
  let start="run";try{start=localStorage.getItem("leo-tab")||"run";}catch(e){}
  if(start!=="run"&&!exts.some(e=>e.name===start))start="run";
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

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/":
            self._send(200, "text/html; charset=utf-8", PAGE.encode())
        elif path == "/api/state":
            self._send(200, "application/json", json.dumps(snapshot()).encode())
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

    def do_POST(self):
        if self.path.split("?", 1)[0] == "/api/stop":
            try:
                open(os.path.join(LEO, "STOP"), "a").close()
                self._send(200, "application/json", b'{"ok":true}')
            except OSError as e:
                self._send(500, "application/json", json.dumps({"ok": False, "error": str(e)}).encode())
        else:
            self._send(404, "text/plain", b"not found")

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

#!/usr/bin/env python3
"""
ovmem dashboard - local web panel to observe the RAG memory (OpenViking).

Zero dependencies (stdlib only). Serves at http://127.0.0.1:1934:
  /              -> HTML page (auto-refresh)
  /api/stats     -> aggregated JSON: server, hooks, hotness, sessions, server-side usage
  /api/search?q= -> live recall (POST /search/find on the OpenViking server)

Everything is read-only. SQLite databases are opened mode=ro so they never compete
with the server.

It also exposes a small "dashboard provider" contract so a host dashboard (the
leopold-watch tab system) can render a Memory tab without a second HTTP server:
  dashboard_view()        -> {"cards": [...]}  declarative widget view
  dashboard_search(query) -> {"hits": [...]}   live recall

Usage:
  python3 dashboard.py                 # serve the panel (port 1934, or the next free one)
  python3 dashboard.py --port 9000     # fixed port
  python3 dashboard.py --json          # print the aggregate and exit (no server)
"""
import json
import os
import sqlite3
import sys
import time
import urllib.request
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOME = os.path.expanduser("~")
OVMEM_DIR = os.path.join(HOME, ".claude", "ovmem")
STATE_DIR = os.path.join(OVMEM_DIR, "state")
LOG_PATH = os.path.join(OVMEM_DIR, "ovmem.log")
CONF_PATH = os.path.join(HOME, ".openviking", "ov.conf")
DATA_DIR = os.path.join(HOME, ".openviking", "data")
AUDIT_DB = os.path.join(DATA_DIR, "_system", "usage_audit", "usage_audit.sqlite3")
QUEUE_DB = os.path.join(DATA_DIR, "_system", "queue", "queue.db")


# ---------- config ----------

def load_conf():
    host, port, key, lang, vlm, emb = "127.0.0.1", 1933, "ov-local-dev-key", "?", "?", "?"
    try:
        with open(CONF_PATH) as f:
            c = json.load(f)
        srv = c.get("server", {})
        host = srv.get("host", host)
        port = int(srv.get("port", port))
        key = srv.get("root_api_key", key)
        lang = c.get("output_language_override", "?")
        vlm = (c.get("vlm") or {}).get("model", "?")
        emb = ((c.get("embedding") or {}).get("dense") or {}).get("model", "?")
    except Exception:
        pass
    return host, port, key, lang, vlm, emb


HOST, PORT, API_KEY, LANG, VLM, EMB = load_conf()
OV_BASE = "http://%s:%d" % (HOST, PORT)


def ov_call(path, body=None, timeout=5):
    url = OV_BASE + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method="POST" if data else "GET")
    req.add_header("x-api-key", API_KEY)
    req.add_header("X-OpenViking-Account", "default")
    req.add_header("X-OpenViking-User", os.environ.get("USER", "jonhvmp"))
    req.add_header("X-OpenViking-Agent", "claude-code")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


# ---------- collectors ----------

def server_health():
    out = {"up": False, "version": None, "auth_mode": None, "pid": None}
    try:
        out.update({k: v for k, v in ov_call("/health", timeout=2).items()
                    if k in ("version", "auth_mode")})
        out["up"] = True
    except Exception:
        pass
    pidf = os.path.join(DATA_DIR, ".openviking.pid")
    try:
        with open(pidf) as f:
            pid = int(f.read().strip())
        os.kill(pid, 0)  # does not send a signal, just checks the process exists
        out["pid"] = pid
    except Exception:
        pass
    return out


def hotness():
    """Read access.json (local recall signal) -> top memories by frequency/recency."""
    path = os.path.join(STATE_DIR, "access.json")
    out = {"tracked": 0, "total_hits": 0, "last_access": None, "top": []}
    try:
        with open(path) as f:
            d = json.load(f)
    except Exception:
        return out
    out["tracked"] = len(d)
    out["total_hits"] = sum(int(v.get("n", 0)) for v in d.values())
    if d:
        out["last_access"] = max(int(v.get("t", 0)) for v in d.values())
    rows = sorted(d.items(), key=lambda kv: int(kv[1].get("n", 0)), reverse=True)
    for uri, v in rows[:12]:
        out["top"].append({
            "name": uri.rstrip("/").split("/")[-1],
            "uri": uri,
            "n": int(v.get("n", 0)),
            "t": int(v.get("t", 0)),
        })
    return out


def sessions():
    out = {"count": 0, "total_lines": 0, "recent": []}
    try:
        files = [f for f in os.listdir(STATE_DIR)
                 if f.endswith(".json") and f != "access.json"]
    except Exception:
        return out
    items = []
    for f in files:
        p = os.path.join(STATE_DIR, f)
        try:
            lines = json.load(open(p)).get("lines", 0)
            items.append((f[:-5], int(lines), os.path.getmtime(p)))
        except Exception:
            continue
    out["count"] = len(items)
    out["total_lines"] = sum(i[1] for i in items)
    for sid, lines, mt in sorted(items, key=lambda x: x[2], reverse=True)[:6]:
        out["recent"].append({"id": sid[:8], "lines": lines, "mtime": int(mt)})
    return out


def _conn(db):
    return sqlite3.connect("file:%s?mode=ro" % db, uri=True, timeout=3)


def usage():
    out = {"requests": 0, "by_route": [], "recent": [], "avg_ms": None,
           "tokens": None, "retrievals": None, "errors": 0}
    if not os.path.exists(AUDIT_DB):
        return out
    try:
        c = _conn(AUDIT_DB)
        out["requests"] = c.execute("select count(*) from request_audit").fetchone()[0]
        out["errors"] = c.execute(
            "select count(*) from request_audit where status_code >= 400").fetchone()[0]
        avg = c.execute(
            "select avg(duration_ms) from request_audit where duration_ms is not null"
        ).fetchone()[0]
        out["avg_ms"] = round(avg, 1) if avg is not None else None
        for route, n in c.execute(
                "select route, count(*) c from request_audit group by route "
                "order by c desc limit 8"):
            out["by_route"].append({"route": route, "n": n})
        for row in c.execute(
                "select route, status_code, duration_ms, created_at from request_audit "
                "order by id desc limit 12"):
            out["recent"].append({
                "route": row[0], "status": row[1],
                "ms": row[2], "at": str(row[3])[:19],
            })
        # tokens: dynamic sum of any column with 'token' in its name
        try:
            cols = [r[1] for r in c.execute("pragma table_info(usage_token_hourly)")]
            tcols = [x for x in cols if "token" in x.lower()]
            if tcols:
                expr = "+".join("coalesce(sum(%s),0)" % x for x in tcols)
                out["tokens"] = c.execute(
                    "select %s from usage_token_hourly" % expr).fetchone()[0]
        except Exception:
            pass
        try:
            cols = [r[1] for r in c.execute("pragma table_info(usage_retrieval_hourly)")]
            rcols = [x for x in cols if any(k in x.lower()
                     for k in ("count", "retriev", "hits", "queries"))]
            if rcols:
                expr = "+".join("coalesce(sum(%s),0)" % x for x in rcols)
                out["retrievals"] = c.execute(
                    "select %s from usage_retrieval_hourly" % expr).fetchone()[0]
        except Exception:
            pass
        c.close()
    except Exception:
        pass
    return out


def hook_log():
    out = {"last_lines": [], "mtime": None}
    try:
        out["mtime"] = int(os.path.getmtime(LOG_PATH))
        with open(LOG_PATH) as f:
            out["last_lines"] = [l.rstrip("\n") for l in f.readlines()[-8:]]
    except Exception:
        pass
    return out


def collect_stats():
    return {
        "now": int(time.time()),
        "config": {"host": HOST, "port": PORT, "lang": LANG, "vlm": VLM, "embedding": EMB},
        "server": server_health(),
        "hotness": hotness(),
        "sessions": sessions(),
        "usage": usage(),
        "log": hook_log(),
    }


def live_search(q):
    if not q:
        return {"hits": []}
    try:
        r = ov_call("/api/v1/search/find", body={
            "query": q,
            "target_uri": ["viking://user/", "viking://session/"],
            "limit": 8,
        }, timeout=8)
        res = r.get("result", {}) or {}
        hits = []
        for key in ("memories", "resources", "skills"):
            hits += (res.get(key) or [])
        hits.sort(key=lambda x: x.get("score", 0), reverse=True)
        return {"hits": [{
            "score": round(h.get("score", 0), 3),
            "uri": h.get("uri", ""),
            "text": (h.get("overview") or h.get("abstract") or "")[:300],
        } for h in hits[:8]]}
    except Exception as e:
        return {"hits": [], "error": str(e)}


# ---------- dashboard provider contract (for a host like leopold-watch) ----------

def _fmt_age(now, t):
    if not t:
        return "-"
    d = now - t
    if d < 60:
        return "%ds ago" % d
    if d < 3600:
        return "%dmin ago" % (d // 60)
    if d < 86400:
        return "%dh ago" % (d // 3600)
    return "%dd ago" % (d // 86400)


def _tone_age(now, t):
    if not t:
        return "warn"
    return "good" if (now - t) < 86400 else "warn"


def dashboard_view():
    """Plugin contract: a declarative card/widget view for a host dashboard.

    The host renders this with its own design system; we only describe data. Widget
    kinds: kpis | bars | table | search | log. tone in good|warn|bad|none.
    """
    s = collect_stats()
    now = s["now"]
    srv, cfg, h, u, ses, lg = (s["server"], s["config"], s["hotness"],
                               s["usage"], s["sessions"], s["log"])
    cards = []

    cards.append({"title": "OpenViking server", "widgets": [
        {"kind": "kpis", "items": [
            {"label": "status", "value": "online" if srv["up"] else "offline",
             "tone": "good" if srv["up"] else "bad"},
            {"label": "version", "value": srv.get("version") or "-"},
            {"label": "port", "value": cfg["port"]},
            {"label": "pid", "value": srv.get("pid") or "-"},
            {"label": "vlm", "value": cfg["vlm"]},
            {"label": "embedding", "value": cfg["embedding"]},
        ]},
    ]})

    maxn = max([x["n"] for x in h["top"]] or [1])
    cards.append({"title": "Recall (local hotness)", "widgets": [
        {"kind": "kpis", "items": [
            {"label": "memories", "value": h["tracked"],
             "tone": "good" if h["tracked"] else "none"},
            {"label": "total hits", "value": h["total_hits"]},
            {"label": "last recall", "value": _fmt_age(now, h["last_access"]),
             "tone": _tone_age(now, h["last_access"])},
        ]},
        {"kind": "bars", "items": [
            {"label": x["name"], "value": x["n"], "max": maxn} for x in h["top"][:8]
        ]},
    ]})

    cards.append({"title": "Server-side activity", "widgets": [
        {"kind": "kpis", "items": [
            {"label": "requests", "value": u["requests"]},
            {"label": "avg latency",
             "value": ("%sms" % u["avg_ms"]) if u["avg_ms"] is not None else "-"},
            {"label": "errors", "value": u["errors"],
             "tone": "warn" if u["errors"] else "none"},
            {"label": "tokens", "value": u["tokens"] if u["tokens"] is not None else "-"},
            {"label": "retrievals",
             "value": u["retrievals"] if u["retrievals"] is not None else "-"},
        ]},
        {"kind": "table", "columns": ["route", "n"],
         "rows": [[r["route"], r["n"]] for r in u["by_route"]]},
    ]})

    cards.append({"title": "Recent requests", "widgets": [
        {"kind": "table", "columns": ["when", "route", "status", "ms"],
         "rows": [[r["at"], r["route"], r["status"], r["ms"] if r["ms"] is not None else "-"]
                  for r in u["recent"]]},
    ]})

    cards.append({"title": "Tracked sessions", "widgets": [
        {"kind": "kpis", "items": [
            {"label": "sessions", "value": ses["count"]},
            {"label": "lines committed", "value": ses["total_lines"]},
        ]},
        {"kind": "table", "columns": ["id", "lines", "updated"],
         "rows": [[x["id"], x["lines"], _fmt_age(now, x["mtime"])] for x in ses["recent"]]},
    ]})

    cards.append({"title": "Live memory search", "widgets": [
        {"kind": "search", "placeholder": "e.g. ovmem project, user stack, deadline..."},
    ]})

    cards.append({"title": "Hook log", "widgets": [
        {"kind": "log", "lines": lg["last_lines"] or ["no log (OVMEM_DEBUG off)"]},
    ]})

    return {"cards": cards, "ok": srv["up"]}


def dashboard_search(q):
    """Plugin contract: live recall for the host's search widget."""
    return live_search(q)


# ---------- HTML ----------

PAGE = r"""<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ovmem dashboard</title>
<style>
  :root{
    --bg:#0b0d10; --panel:#14181d; --panel2:#1b2027; --line:#262d36;
    --txt:#e6edf3; --dim:#8b97a5; --acc:#5ad1a0; --warn:#e3b341; --bad:#f0746e;
    --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--txt);
    font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  header{display:flex;align-items:center;gap:14px;padding:16px 22px;
    border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:5}
  header h1{font-size:16px;margin:0;font-weight:600;letter-spacing:.2px}
  .dot{width:9px;height:9px;border-radius:50%;display:inline-block}
  .up{background:var(--acc);box-shadow:0 0 8px var(--acc)}
  .down{background:var(--bad);box-shadow:0 0 8px var(--bad)}
  .pill{font:12px var(--mono);color:var(--dim);border:1px solid var(--line);
    padding:2px 8px;border-radius:99px}
  .spacer{flex:1}
  #updated{font:11px var(--mono);color:var(--dim)}
  main{padding:18px 22px;display:grid;gap:16px;
    grid-template-columns:repeat(auto-fit,minmax(330px,1fr));max-width:1400px;margin:0 auto}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;
    padding:16px 18px;min-width:0}
  .card.wide{grid-column:1/-1}
  .card h2{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--dim);
    margin:0 0 12px;font-weight:600}
  .kpis{display:flex;gap:18px;flex-wrap:wrap}
  .kpi .v{font:22px var(--mono);font-weight:600}
  .kpi .l{font-size:11px;color:var(--dim)}
  .v.acc{color:var(--acc)} .v.warn{color:var(--warn)} .v.bad{color:var(--bad)}
  table{width:100%;border-collapse:collapse;font:12px var(--mono)}
  td,th{text-align:left;padding:5px 6px;border-bottom:1px solid var(--line);
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  th{color:var(--dim);font-weight:500} tr:last-child td{border-bottom:none}
  td.num{text-align:right;color:var(--acc)}
  .name{max-width:0;width:100%}
  .bar{height:5px;background:var(--panel2);border-radius:3px;overflow:hidden;margin-top:3px}
  .bar>i{display:block;height:100%;background:var(--acc)}
  .ok{color:var(--acc)} .err{color:var(--bad)} .muted{color:var(--dim)}
  pre{margin:0;font:11px var(--mono);color:var(--dim);white-space:pre-wrap;
    max-height:160px;overflow:auto}
  .search{display:flex;gap:8px;margin-bottom:12px}
  .search input{flex:1;background:var(--panel2);border:1px solid var(--line);color:var(--txt);
    border-radius:8px;padding:8px 12px;font:13px var(--mono)}
  .search button{background:var(--acc);color:#03130c;border:0;border-radius:8px;
    padding:8px 16px;font-weight:600;cursor:pointer}
  .hit{padding:8px 0;border-bottom:1px solid var(--line)}
  .hit:last-child{border:none}
  .hit .top{display:flex;gap:8px;align-items:baseline}
  .hit .sc{font:12px var(--mono);color:var(--acc);font-weight:600}
  .hit .u{font:11px var(--mono);color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .hit .tx{font-size:12px;color:var(--txt);margin-top:3px;opacity:.85}
  .foot{padding:10px 22px;color:var(--dim);font:11px var(--mono);
    border-top:1px solid var(--line)}
</style></head>
<body>
<header>
  <span id="dot" class="dot down"></span>
  <h1>ovmem &middot; long-term memory</h1>
  <span class="pill" id="srv">openviking ...</span>
  <span class="pill" id="cfg"></span>
  <span class="spacer"></span>
  <span id="updated">connecting...</span>
</header>
<main id="grid">
  <section class="card">
    <h2>OpenViking server</h2>
    <div class="kpis" id="k-server"></div>
  </section>
  <section class="card">
    <h2>Recall (local hotness)</h2>
    <div class="kpis" id="k-recall"></div>
  </section>
  <section class="card">
    <h2>Server-side activity</h2>
    <div class="kpis" id="k-usage"></div>
  </section>
  <section class="card wide">
    <h2>Live memory search</h2>
    <div class="search">
      <input id="q" placeholder="e.g. ovmem project, user stack, deadline..." />
      <button id="go">Search</button>
    </div>
    <div id="hits"><span class="muted">type a query and hit Enter</span></div>
  </section>
  <section class="card">
    <h2>Hottest memories</h2>
    <table><tbody id="t-hot"></tbody></table>
  </section>
  <section class="card">
    <h2>Top routes</h2>
    <table><tbody id="t-routes"></tbody></table>
  </section>
  <section class="card wide">
    <h2>Recent requests</h2>
    <table>
      <thead><tr><th>when</th><th>route</th><th>status</th><th class="num">ms</th></tr></thead>
      <tbody id="t-recent"></tbody>
    </table>
  </section>
  <section class="card">
    <h2>Tracked sessions</h2>
    <table>
      <thead><tr><th>id</th><th class="num">lines</th><th>updated</th></tr></thead>
      <tbody id="t-sess"></tbody>
    </table>
  </section>
  <section class="card">
    <h2>Hook log</h2>
    <pre id="log">no log (OVMEM_DEBUG off)</pre>
  </section>
</main>
<div class="foot" id="foot"></div>
<script>
const $=s=>document.querySelector(s);
const ago=ts=>{if(!ts)return "-";let d=Math.floor(Date.now()/1000)-ts;
  if(d<60)return d+"s ago";if(d<3600)return Math.floor(d/60)+"min ago";
  if(d<86400)return Math.floor(d/3600)+"h ago";return Math.floor(d/86400)+"d ago";};
const esc=s=>(s||"").replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
function kpi(v,l,cls){return `<div class="kpi"><div class="v ${cls||''}">${v}</div><div class="l">${l}</div></div>`;}

async function refresh(){
  let s;try{s=await (await fetch('/api/stats')).json();}catch(e){
    $('#updated').textContent='dashboard server offline';return;}
  const srvUp=s.server.up;
  $('#dot').className='dot '+(srvUp?'up':'down');
  $('#srv').textContent='openviking '+(s.server.version?('v'+s.server.version):'down')
    +(s.server.pid?(' · pid '+s.server.pid):'');
  $('#cfg').textContent=`lang:${s.config.lang} · vlm:${s.config.vlm} · emb:${s.config.embedding}`;

  $('#k-server').innerHTML=
    kpi(srvUp?'online':'offline','status',srvUp?'acc':'bad')
    +kpi(s.config.port,'port')
    +kpi(s.server.auth_mode||'-','auth');

  const h=s.hotness;
  $('#k-recall').innerHTML=
    kpi(h.tracked,'memories','acc')
    +kpi(h.total_hits,'total hits')
    +kpi(ago(h.last_access),'last recall',(Date.now()/1000-h.last_access<86400)?'acc':'warn');

  const u=s.usage;
  $('#k-usage').innerHTML=
    kpi(u.requests,'requests','acc')
    +kpi(u.avg_ms!=null?u.avg_ms+'ms':'-','avg latency')
    +kpi(u.errors,'errors 4xx/5xx',u.errors>0?'warn':'')
    +(u.tokens!=null?kpi(u.tokens.toLocaleString(),'tokens (server)'):'');

  const maxN=Math.max(1,...h.top.map(x=>x.n));
  $('#t-hot').innerHTML=h.top.map(x=>`<tr>
    <td class="name" title="${esc(x.uri)}">${esc(x.name)}
      <div class="bar"><i style="width:${Math.round(100*x.n/maxN)}%"></i></div></td>
    <td class="num">${x.n}</td></tr>`).join('')||'<tr><td class="muted">empty</td></tr>';

  $('#t-routes').innerHTML=u.by_route.map(r=>`<tr>
    <td class="name">${esc(r.route)}</td><td class="num">${r.n}</td></tr>`).join('')
    ||'<tr><td class="muted">empty</td></tr>';

  $('#t-recent').innerHTML=u.recent.map(r=>`<tr>
    <td>${esc(r.at)}</td><td class="name">${esc(r.route)}</td>
    <td class="${r.status>=400?'err':'ok'}">${r.status}</td>
    <td class="num">${r.ms!=null?r.ms:'-'}</td></tr>`).join('')
    ||'<tr><td class="muted">empty</td></tr>';

  $('#t-sess').innerHTML=s.sessions.recent.map(x=>`<tr>
    <td>${esc(x.id)}</td><td class="num">${x.lines}</td>
    <td class="muted">${ago(x.mtime)}</td></tr>`).join('')
    ||'<tr><td class="muted">empty</td></tr>';

  if(s.log.last_lines.length)$('#log').textContent=s.log.last_lines.join('\n');
  $('#updated').textContent='updated '+new Date().toLocaleTimeString();
  $('#foot').textContent=`${s.sessions.count} sessions · ${s.sessions.total_lines} lines committed · `
    +`retrievals: ${u.retrievals!=null?u.retrievals:'n/a'} · read-only dashboard`;
}

async function search(){
  const q=$('#q').value.trim();if(!q)return;
  $('#hits').innerHTML='<span class="muted">searching...</span>';
  let r;try{r=await (await fetch('/api/search?q='+encodeURIComponent(q))).json();}
  catch(e){$('#hits').innerHTML='<span class="err">failed</span>';return;}
  if(r.error){$('#hits').innerHTML='<span class="err">'+esc(r.error)+'</span>';return;}
  if(!r.hits.length){$('#hits').innerHTML='<span class="muted">no results</span>';return;}
  $('#hits').innerHTML=r.hits.map(h=>`<div class="hit">
    <div class="top"><span class="sc">${h.score.toFixed(3)}</span>
      <span class="u" title="${esc(h.uri)}">${esc(h.uri)}</span></div>
    <div class="tx">${esc(h.text)}</div></div>`).join('');
}
$('#go').onclick=search;
$('#q').addEventListener('keydown',e=>{if(e.key==='Enter')search();});
refresh();setInterval(refresh,5000);
</script>
</body></html>"""


# ---------- http server ----------

class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype):
        data = body.encode() if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/":
            self._send(200, PAGE, "text/html; charset=utf-8")
        elif parsed.path == "/api/stats":
            self._send(200, json.dumps(collect_stats()), "application/json")
        elif parsed.path == "/api/search":
            q = urllib.parse.parse_qs(parsed.query).get("q", [""])[0]
            self._send(200, json.dumps(live_search(q)), "application/json")
        else:
            self._send(404, "not found", "text/plain")

    def log_message(self, *a):
        pass  # quiet


def main():
    if "--json" in sys.argv:
        print(json.dumps(collect_stats(), indent=2, ensure_ascii=False))
        return
    port = 1934
    if "--port" in sys.argv:
        port = int(sys.argv[sys.argv.index("--port") + 1])
    srv = None
    for p in range(port, port + 10):
        try:
            srv = ThreadingHTTPServer(("127.0.0.1", p), Handler)
            port = p
            break
        except OSError:
            continue
    if srv is None:
        print("no free port in %d..%d" % (port, port + 9))
        return
    url = "http://127.0.0.1:%d" % port
    print("ovmem dashboard  ->  %s" % url)
    print("(Ctrl+C to stop)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()

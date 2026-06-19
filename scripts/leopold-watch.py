#!/usr/bin/env python3
"""Leopold watch — a local, zero-dependency live dashboard for an autonomous run.

It reads the run's own files in `.leopold/` (state.json, PLAN.md, DECISIONS.md,
events.jsonl) and serves a dashboard on 127.0.0.1 with live (SSE) updates. It is
read-only except for one action: a Stop button that touches `.leopold/STOP` — the
same kill switch `/leopold-stop` uses.

No dependencies (Python 3.8+ stdlib only). Nothing leaves the machine; it binds to
loopback and uses no web fonts. The UI follows a warm-cream / near-black design
system (Geist / Geist Mono type stack with system fallbacks). Usage:

    python3 leopold-watch.py [--project DIR] [--port 4179] [--host 127.0.0.1]
"""
import argparse
import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LEO = ""          # set in main(): the project's .leopold dir


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
    # keep only real decision blocks (the protocol writes "Fork:" / "Decision:" lines);
    # this drops the "# Decisions" heading and the intro line.
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


def _num(state, key, default):
    v = state.get(key, default)
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def snapshot():
    st = read_state()
    plan = read_plan()
    active = st.get("active") is True
    stopped_reason = st.get("stopped_reason", "")
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
        "active": active,
        "stopped_reason": stopped_reason,
        "stop_requested": os.path.exists(os.path.join(LEO, "STOP")),
        "started_at": st.get("started_at", ""),
        "last_turn": st.get("last_turn", ""),
        "session_id": st.get("session_id", ""),
        "plan": plan,
        "meters": meters,
        "events": read_events(),
        "decisions": read_decisions(),
        "ts": int(time.time()),
    }


# --------------------------------------------------------------------------- page
# Design system: warm cream (light) / near-black (dark), strictly monochrome with
# semantic green/red + severity tones; Geist / Geist Mono type stack (system fallback,
# no web fonts so it works fully offline); tactile "pushable" buttons; pill + severity
# chips; hairline dividers.
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
.card:nth-child(2){animation-delay:.04s}.card:nth-child(3){animation-delay:.08s}.card:nth-child(4){animation-delay:.12s}
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
.meters{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin-top:14px}
.meter .top{display:flex;justify-content:space-between;align-items:baseline}
.meter .lbl{font-family:var(--mono);font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted-fg)}
.meter .val{font-family:var(--mono);font-size:12px;font-variant-numeric:tabular-nums}
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
<div class="card"><div class="row">
  <span class="pill" id="status"><span class="dot" id="dot"></span><span id="stext">—</span></span>
  <span class="sub tnum" id="planline" style="font-family:var(--mono);font-size:11px"></span>
  <span class="grow"></span>
  <button class="btn" id="stop" disabled>Stop run</button>
</div><div class="meters" id="meters"></div></div>
<div class="card"><div class="sectitle">Live events</div><div class="feed" id="feed"></div></div>
<div class="card"><div class="sectitle">Plan</div><div id="plan" class="plan"></div></div>
<div class="card"><div class="sectitle">Decisions · newest</div><div id="decisions"></div></div>
<script>
const $=s=>document.querySelector(s);
function el(t,c,txt){const e=document.createElement(t);if(c)e.className=c;if(txt!=null)e.textContent=txt;return e;}
function hms(ts){return ts&&ts.length>=19?ts.slice(11,19):"";}
const SEV={guard_block:"sev-crit",state_invalid:"sev-crit",turn_start:"sev-low",stop:"sev-info",subagent_spawn:"sev-med"};
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
    global LEO
    ap = argparse.ArgumentParser(description="Local live dashboard for a Leopold run.")
    ap.add_argument("--project", default=os.getcwd(), help="project dir containing .leopold/ (default: cwd)")
    ap.add_argument("--port", type=int, default=int(os.environ.get("LEOPOLD_WATCH_PORT", "4179")))
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args()
    LEO = os.path.join(os.path.abspath(args.project), ".leopold")
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.daemon_threads = True
    url = "http://%s:%d" % (args.host, args.port)
    print("Leopold watch -> %s   (project: %s)" % (url, args.project))
    print("Reading: %s   ·   Ctrl-C to stop" % LEO)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()

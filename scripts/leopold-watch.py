#!/usr/bin/env python3
"""Leopold watch — a local, zero-dependency live dashboard for an autonomous run.

It reads the run's own files in `.leopold/` (state.json, PLAN.md, DECISIONS.md,
events.jsonl) and serves a dashboard on 127.0.0.1 with live (SSE) updates. It is
read-only except for one action: a Stop button that touches `.leopold/STOP` — the
same kill switch `/leopold-stop` uses.

No dependencies (Python 3.8+ stdlib only). Nothing leaves the machine; it binds to
loopback. Usage:

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
    out = [b for b in blocks if ("Fork:" in b or "Decision:" in b or "Decisão:" in b)]
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
PAGE = r"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Leopold watch</title>
<style>
:root{--bg:#0d1117;--panel:#161b22;--line:#30363d;--dim:#8b949e;--fg:#e6edf3;
--green:#3fb950;--yellow:#d29922;--red:#f85149;--cyan:#39c5cf;--accent:#d97757}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);
font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.wrap{max-width:960px;margin:0 auto;padding:18px}
h1{font-size:15px;margin:0 0 14px;font-weight:600}.dot{color:var(--accent)}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:8px;
padding:14px;margin-bottom:14px}
.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.badge{padding:2px 9px;border-radius:99px;font-weight:600;font-size:12px}
.on{background:rgba(63,185,80,.15);color:var(--green)}
.off{background:rgba(139,148,158,.15);color:var(--dim)}
.warn{background:rgba(210,153,34,.15);color:var(--yellow)}
.sub{color:var(--dim)}.spacer{flex:1}
button{background:var(--red);color:#fff;border:0;border-radius:6px;padding:7px 14px;
font:inherit;font-weight:600;cursor:pointer}button:disabled{opacity:.4;cursor:default}
.meters{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-top:12px}
.meter .top{display:flex;justify-content:space-between}.meter .lbl{color:var(--dim)}
.bar{height:6px;background:#21262d;border-radius:4px;margin-top:4px;overflow:hidden}
.bar>i{display:block;height:100%;background:var(--green);transition:width .3s}
.bar.hi>i{background:var(--yellow)}.bar.full>i{background:var(--red)}
.sectitle{color:var(--dim);text-transform:uppercase;font-size:11px;letter-spacing:.06em;margin-bottom:8px}
.feed{max-height:320px;overflow:auto}.ev{display:flex;gap:10px;padding:3px 0;border-bottom:1px solid #1b2129}
.ev .t{color:var(--dim);white-space:nowrap}.ev .k{white-space:nowrap}
.k-turn_start{color:var(--cyan)}.k-guard_block{color:var(--red)}
.k-subagent_spawn{color:var(--yellow)}.k-stop{color:var(--accent)}.k-state_invalid{color:var(--red)}
.dec{padding:8px 0;border-bottom:1px solid #1b2129;white-space:pre-wrap}
.plan li{list-style:none}.plan .d{color:var(--dim);text-decoration:line-through}
.plan .o{color:var(--fg)}.plan ul{padding-left:0;margin:6px 0 0;max-height:180px;overflow:auto}
.empty{color:var(--dim);padding:8px 0}
</style></head><body><div class="wrap">
<h1><span class="dot">●</span> leopold watch <span class="sub" id="proj"></span></h1>
<div class="panel"><div class="row">
  <span id="status" class="badge off">—</span>
  <span class="sub" id="planline"></span>
  <span class="spacer"></span>
  <button id="stop" disabled>Stop run</button>
</div><div class="meters" id="meters"></div></div>
<div class="panel"><div class="sectitle">Live events</div><div class="feed" id="feed"></div></div>
<div class="panel"><div class="sectitle">Plan</div><div id="plan"></div></div>
<div class="panel"><div class="sectitle">Decisions (newest)</div><div id="decisions"></div></div>
<script>
const $=s=>document.querySelector(s);
function el(t,c,txt){const e=document.createElement(t);if(c)e.className=c;if(txt!=null)e.textContent=txt;return e;}
function hms(ts){const d=ts&&ts.length>=19?ts.slice(11,19):"";return d;}
function render(s){
  $("#proj").textContent = s.session_id ? "· "+s.session_id : "";
  const st=$("#status");
  if(!s.present){st.className="badge off";st.textContent="no active run";}
  else if(s.invalid){st.className="badge warn";st.textContent="state invalid";}
  else if(s.active){st.className="badge on";st.textContent="● RUN ACTIVE";}
  else{st.className="badge off";st.textContent="stopped"+(s.stopped_reason?" · "+s.stopped_reason:"");}
  $("#planline").textContent = s.plan.total ? ("plan "+s.plan.done+"/"+s.plan.total+" done") : "";
  $("#stop").disabled = !(s.active);
  $("#stop").textContent = s.stop_requested ? "stop requested…" : "Stop run";
  // meters
  const m=$("#meters");m.innerHTML="";
  s.meters.forEach(x=>{
    const pct=x.max>0?Math.min(100,Math.round(x.val/x.max*100)):(x.val>0?100:0);
    const d=el("div","meter");
    const top=el("div","top");top.append(el("span","lbl",x.label),el("span",null,x.val+(x.unit?x.unit:"")+" / "+x.max+(x.unit?x.unit:"")));
    const bar=el("div","bar"+(pct>=100?" full":pct>=75?" hi":""));const i=el("i");i.style.width=pct+"%";bar.append(i);
    d.append(top,bar);m.append(d);
  });
  // feed
  const f=$("#feed");f.innerHTML="";
  if(!s.events.length)f.append(el("div","empty","no events yet"));
  s.events.forEach(e=>{
    const r=el("div","ev");r.append(el("span","t",hms(e.ts)||""));
    r.append(el("span","k k-"+(e.event||""),e.event||"?"));
    let d="";
    if(e.event==="turn_start")d="iter "+e.iteration+" · open "+e.open_items+(e.no_progress?" · no_progress "+e.no_progress:"");
    else if(e.event==="guard_block")d=e.tool||"";
    else if(e.event==="subagent_spawn")d=(e.prompt_kb||0)+"KB"+(e.fork?" · FORK":"")+" · total "+(e.total||"");
    else if(e.event==="stop")d="reason: "+(e.reason||"");
    else if(e.event==="state_invalid")d=e.reason||"";
    r.append(el("span","sub",d));f.append(r);
  });
  // plan
  const p=$("#plan");p.innerHTML="";
  if(!s.plan.items.length)p.append(el("div","empty","no PLAN.md items"));
  else{const ul=el("ul");s.plan.items.forEach(it=>{const li=el("li",null);li.append(el("span",it.done?"d":"o",(it.done?"[x] ":"[ ] ")+it.text));ul.append(li);});p.className="plan";p.append(ul);}
  // decisions
  const dc=$("#decisions");dc.innerHTML="";
  if(!s.decisions.length)dc.append(el("div","empty","none yet"));
  s.decisions.forEach(b=>dc.append(el("div","dec",b)));
}
$("#stop").addEventListener("click",()=>{
  if(!confirm("Stop the run at the next turn boundary? (touches .leopold/STOP)"))return;
  fetch("/api/stop",{method:"POST"}).then(()=>{$("#stop").textContent="stop requested…";$("#stop").disabled=true;});
});
fetch("/api/state").then(r=>r.json()).then(render).catch(()=>{});
const es=new EventSource("/api/events");
es.onmessage=ev=>{try{render(JSON.parse(ev.data));}catch(_){}};
</script></div></body></html>"""


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

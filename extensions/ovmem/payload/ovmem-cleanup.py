#!/usr/bin/env python3
"""
ovmem-cleanup - hotness-based lifecycle pruning of OpenViking long-term memory.

Faithfully mirrors OpenViking's native MemoryArchiver, but over REST (so it coexists
with the running server without touching internals or fighting over locks):

    hotness = sigmoid(log1p(active_count)) * exp(-ln2/half_life * age_days)
    archive L2 leaves with hotness < threshold AND age >= min_age,
    moving them to {parent}/_archive/ (reversible - nothing is deleted).

What it does NOT do (OpenViking already does this natively on commit):
  - note dedup: MemoryDeduplicator (LLM) updates instead of duplicating.
  - reconsolidation/obsolescence: contradicts / evolved_from / supersedes relations.
This script only handles accumulation of COLD memory by disuse, which the engine
has the logic for (MemoryArchiver) but never triggers on its own.

Usage:
  ovmem-cleanup.py            # DRY-RUN: list candidates, move nothing
  ovmem-cleanup.py --apply    # move candidates to _archive/

Env (defaults match the native archiver):
  OVMEM_HOTNESS_THRESHOLD=0.1   OVMEM_HALF_LIFE_DAYS=7   OVMEM_MIN_AGE_DAYS=7
  OVMEM_CLEANUP_PROTECT="identity.md,soul.md"   (leaves that are never archived)
"""
import json
import math
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ovmem  # reuse config (host/key/user/agent), api() and log()


def load_access():
    """Local access signal (frequency + recency) written by ovmem.py's recall."""
    try:
        with open(os.path.join(ovmem.STATE_DIR, "access.json")) as f:
            return json.load(f)
    except Exception:
        return {}


THRESHOLD = float(os.environ.get("OVMEM_HOTNESS_THRESHOLD", "0.1"))
HALF_LIFE = float(os.environ.get("OVMEM_HALF_LIFE_DAYS", "7"))
MIN_AGE = float(os.environ.get("OVMEM_MIN_AGE_DAYS", "7"))
PROTECT = set(p.strip() for p in
              os.environ.get("OVMEM_CLEANUP_PROTECT", "identity.md,soul.md").split(",")
              if p.strip())


def parse_dt(s):
    if not s:
        return None
    try:
        d = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except Exception:
        return None


def hotness(active_count, updated_at, now):
    """Returns (score, age_days), faithful to memory_lifecycle.hotness_score."""
    freq = 1.0 / (1.0 + math.exp(-math.log1p(max(active_count, 0))))
    if updated_at is None:
        return 0.0, 1e9
    age_days = max((now - updated_at).total_seconds() / 86400.0, 0.0)
    recency = math.exp(-(math.log(2) / HALF_LIFE) * age_days)
    return freq * recency, age_days


def scroll_all():
    """Page through every record in the vector index (memory is small; safety cap)."""
    out, cursor = [], None
    for _ in range(200):
        params = {"limit": 500}
        if cursor:
            params["cursor"] = cursor
        r = ovmem.api("GET", "/debug/vector/scroll", params=params, timeout=15)
        res = (r or {}).get("result") or {}
        recs = res.get("records") or []
        out.extend(recs)
        cursor = res.get("cursor") or res.get("next_cursor")
        if not cursor or not recs:
            break
    return out


def is_ours(rec):
    return rec.get("owner_user_id") == ovmem.USER or rec.get("owner_agent_id") == ovmem.AGENT


def archive_uri(uri):
    i = uri.rfind("/")
    return uri[:i] + "/_archive" + uri[i:] if i != -1 else "_archive/" + uri


def main():
    apply = "--apply" in sys.argv
    now = datetime.now(timezone.utc)
    access = load_access()
    recs = scroll_all()
    candidates = []
    for r in recs:
        if r.get("level") != 2:                 # L2 leaves only (never L0/L1 descriptors)
            continue
        uri = r.get("uri", "")
        if not uri or "/_archive/" in uri:
            continue
        if not is_ours(r):
            continue
        if uri.rstrip("/").split("/")[-1] in PROTECT:
            continue
        # frequency = max(OpenViking active_count, local recall count)
        # recency   = the more recent of updated_at (OV) and last local access
        local = access.get(uri) or {}
        count = max(int(r.get("active_count", 0) or 0), int(local.get("n", 0) or 0))
        last_acc = datetime.fromtimestamp(local["t"], timezone.utc) if local.get("t") else None
        eff = max([d for d in (parse_dt(r.get("updated_at")), last_acc) if d], default=None)
        score, age = hotness(count, eff, now)
        if age < MIN_AGE:
            continue
        if score < THRESHOLD:
            candidates.append((score, age, count, uri))

    candidates.sort()
    mode = "APPLY" if apply else "DRY-RUN"
    print("[ovmem-cleanup %s] %d cold candidates of %d records (thr=%.2f min_age=%.0fd half_life=%.0fd)"
          % (mode, len(candidates), len(recs), THRESHOLD, MIN_AGE, HALF_LIFE))
    ovmem.log("cleanup %s: %d/%d candidates" % (mode, len(candidates), len(recs)))
    moved = 0
    for score, age, ac, uri in candidates:
        print("  hot=%.3f age=%.1fd ac=%d  %s" % (score, age, ac, uri))
        if apply:
            resp = ovmem.api("POST", "/fs/mv",
                             body={"from_uri": uri, "to_uri": archive_uri(uri)}, timeout=15)
            if resp and resp.get("status") == "ok":
                moved += 1
            else:
                print("    ! move failed: %s" % (resp.get("error") if resp else "no response"))
    if apply:
        print("moved to _archive: %d" % moved)
        ovmem.log("cleanup: moved %d" % moved)


if __name__ == "__main__":
    main()

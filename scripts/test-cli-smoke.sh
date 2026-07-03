#!/usr/bin/env bash
# CLI smoke test: exercise the BUILT leopold-driver binary end to end against a
# fixture brief. Unit tests cover the modules; this catches what they can't — a
# broken dist entry, bad subcommand dispatch, a path bug in emit. No network, no
# agents: only the deterministic paths (help, dry-run, workflow compile/emit/print,
# insights).
#
# Usage: bash scripts/test-cli-smoke.sh   (expects packages/driver already built)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$ROOT/packages/driver/dist/index.js"
[ -f "$CLI" ] || { echo "cli-smoke: $CLI not found — run 'npm run build' in packages/driver first."; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"

fail() { echo "cli-smoke FAIL: $1"; exit 1; }
run() { node "$CLI" "$@" 2>&1; }

echo "-> fixture brief"
mkdir -p .leopold
cat > .leopold/MISSION.md <<'EOF'
# Mission
Ship the thing.
EOF
cat > .leopold/CHARTER.md <<'EOF'
# Charter
Be pragmatic.
EOF
cat > .leopold/GUARDRAILS.md <<'EOF'
# Guardrails
max_iterations: 50
max_review_rounds: 3
EOF
cat > .leopold/PLAN.md <<'EOF'
# Plan
- [ ] Add a health endpoint
- [ ] Fix a typo in the readme
- [ ] Add Stripe billing to checkout
- [ ] (after: 3) Migrate the payments table schema
- [ ] (after: 1) Wire the UI to the health endpoint
EOF

echo "-> help"
run --help | grep -q "leopold-driver workflow" || fail "--help must document the workflow subcommand"

echo "-> unknown subcommand exits non-zero"
node "$CLI" definitely-not-a-command >/dev/null 2>&1 && fail "unknown subcommand must exit non-zero" || true

echo "-> run --dry-run"
out="$(run run --dry-run)"
echo "$out" | grep -q "DRY RUN" || fail "run --dry-run must print DRY RUN"
echo "$out" | grep -q "Open plan items: 5" || fail "dry-run must count the 5 open items (got: $out)"

echo "-> workflow --print (compile: waves + classification + guardrails)"
out="$(run workflow --print)"
echo "$out" | node -e '
let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
  const d=JSON.parse(s);
  const flat=d.waves.flat();
  const die=(m)=>{console.error("cli-smoke FAIL:",m);process.exit(1)};
  if(d.maxReviewRounds!==3) die("maxReviewRounds must come from guardrails (3), got "+d.maxReviewRounds);
  if(d.waves.length!==2) die("expected 2 waves, got "+d.waves.length);
  if(d.waves[0].length!==3||d.waves[1].length!==2) die("wave sizes wrong");
  const billing=flat.find(i=>i.text.includes("Stripe"));
  if(!billing||!billing.critical||!billing.sensitive) die("Stripe item must be critical+sensitive");
  const typo=flat.find(i=>i.text.includes("typo"));
  if(!typo||typo.effort!=="low") die("typo item must be low effort");
  console.log("   compile verdict: OK");
});' || fail "workflow --print verification failed"

echo "-> workflow (emit)"
run workflow | grep -q "Compiled the brief" || fail "workflow emit must report compilation"
[ -f .claude/workflows/leopold-run.js ] || fail "emit must write .claude/workflows/leopold-run.js"
[ -f .leopold/workflow-args.json ] || fail "emit must write .leopold/workflow-args.json"
node --check .claude/workflows/leopold-run.js || fail "emitted workflow script must parse"
node -e 'JSON.parse(require("fs").readFileSync(".leopold/workflow-args.json","utf8"))' || fail "emitted args must be valid JSON"

echo "-> insights (empty run is a clean report, not a crash)"
: > .leopold/events.jsonl
run insights | grep -q "Leopold insights" || fail "insights must render its report"
run insights --json | node -e 'JSON.parse(require("fs").readFileSync(0,"utf8"))' || fail "insights --json must be valid JSON"

echo "cli-smoke: all green ✓"

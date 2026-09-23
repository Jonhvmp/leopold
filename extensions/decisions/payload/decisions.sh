#!/usr/bin/env bash
# The shell half of the decisions seam: curl + jq, nothing else.
#
# WHY A SECOND SEAM AT ALL. The driver is TypeScript and the hooks are bash. A hook that wants a
# semantic judgement (hooks/permission-policy.sh, item 15) cannot call into the driver without
# paying for a Node start on every tool call, so it calls this. Both read the SAME catalog and the
# SAME config file and produce the SAME answers -- `packages/driver/test/decisions-parity.test.ts`
# runs a catalog through both against one stub and compares, so this cannot drift from the
# driver without the gate going red.
#
# WHAT IT SPEAKS. The System One wire shape (`jev`, `generic`). A chat-completions provider
# (`openrouter`, `vercel`) is answered with an explicit `unsupported` failure naming the seam --
# never a hang, never a silent fallback that reads as "the model said no". Reimplementing logprob
# extraction in jq would be a second copy of the trickiest mapping in the module, for the benefit
# of the SLOWEST providers, on the one surface that cannot afford latency.
#
# IT WRITES NOTHING. The result, including the events it would have emitted, goes to stdout as one
# JSON object. Whoever called it owns events.jsonl (hooks/_lib.sh has `leo_hook_event`), which
# keeps one writer per surface.
#
# THE KEY NEVER TRAVELS. It is read from the descriptor's `auth_env`, handed to curl through a
# header file read with `-H @file` (stdin carries the request body) -- never as an argv word,
# where `ps` would show it -- and appears in no
# output, no event and no error.
#
#   decisions.sh --leo-dir .leopold --catalog routing --questions effort,cosmetic \
#                --state-file state.json [--schema path] [--timeout-ms 2000]
set -uo pipefail

usage() { sed -n '2,20p' "$0" >&2; exit 64; }

LEO_DIR=""; CATALOG=""; QUESTIONS=""; STATE_FILE=""; SCHEMA=""; TIMEOUT_MS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --leo-dir)    LEO_DIR="${2:-}"; shift 2 ;;
    --catalog)    CATALOG="${2:-}"; shift 2 ;;
    --questions)  QUESTIONS="${2:-}"; shift 2 ;;
    --state-file) STATE_FILE="${2:-}"; shift 2 ;;
    --schema)     SCHEMA="${2:-}"; shift 2 ;;
    --timeout-ms) TIMEOUT_MS="${2:-}"; shift 2 ;;
    -h|--help)    usage ;;
    *) printf 'decisions.sh: unknown argument %s\n' "$1" >&2; exit 64 ;;
  esac
done
[ -n "$LEO_DIR" ] && [ -n "$CATALOG" ] && [ -n "$QUESTIONS" ] || usage

# ---- substrate -------------------------------------------------------------------------------
# A missing tool is a loud non-zero exit, never a hang and never an empty answer that a caller
# might read as "the model declined". The caller falls back to its deterministic path.
for tool in jq curl; do
  command -v "$tool" >/dev/null 2>&1 || {
    printf 'decisions.sh: %s is not on PATH — the shell seam cannot run; the caller must fall back\n' "$tool" >&2
    exit 69
  }
done

QLIST="$(printf '%s' "$QUESTIONS" | jq -R 'split(",") | map(select(length > 0))')"

# One shape for every early exit: the same failure the driver produces, for every question asked.
fail_all() { # <reason> <detail> <provider> <source>
  jq -nc --argjson qs "$QLIST" --arg reason "$1" --arg detail "$2" --arg provider "$3" --arg source "$4" '
    {
      provider: $provider, source: $source, usable: false,
      answers: ($qs | map({ key: ., value: ({ ok: false, reason: $reason, provider: $provider }
                 + (if $detail == "" then {} else { detail: $detail } end)) }) | from_entries),
      bands:   ($qs | map({ key: ., value: "floor" }) | from_entries),
      events:  ($qs | map({ event: "decision_failed", provider: $provider, question: ., reason: $reason, source: $source }
                 + (if $detail == "" then {} else { detail: $detail } end)))
    }'
  exit 0
}

# ---- catalog ----------------------------------------------------------------------------------
CATALOG_FILE="$LEO_DIR/decisions/$CATALOG.json"
[ -f "$CATALOG_FILE" ] || fail_all no_catalog "no catalog at $CATALOG_FILE" none none
jq -e . "$CATALOG_FILE" >/dev/null 2>&1 || fail_all no_catalog "catalog at $CATALOG_FILE is not valid JSON" none none

# ---- provider resolution: config.json, then the environment, then none ------------------------
CONFIG_FILE="$LEO_DIR/decisions/config.json"
CONFIG='{}'
if [ -f "$CONFIG_FILE" ] && jq -e . "$CONFIG_FILE" >/dev/null 2>&1; then CONFIG="$(cat "$CONFIG_FILE")"; fi

RESOLVED="$(printf '%s' "$CONFIG" | jq -c --arg env "${LEOPOLD_DECISIONS_PROVIDER:-}" '
  (if (.provider // "") != "" then { name: .provider, source: "config" }
   elif $env != ""            then { name: $env,      source: "env" }
   else { name: "", source: "none" } end) as $pick
  | { name: $pick.name, source: $pick.source, descriptor: ((.providers // {})[$pick.name] // null) }')"

P_NAME="$(printf '%s' "$RESOLVED" | jq -r '.name')"
P_SOURCE="$(printf '%s' "$RESOLVED" | jq -r '.source')"
DESCRIPTOR="$(printf '%s' "$RESOLVED" | jq -c '.descriptor')"

[ "$P_SOURCE" = "none" ] && fail_all no_provider "" none none
[ "$DESCRIPTOR" = "null" ] && fail_all no_provider "no descriptor for provider \"$P_NAME\"" none "$P_SOURCE"

ENDPOINT="$(printf '%s' "$DESCRIPTOR" | jq -r '.endpoint // ""')"
MODEL="$(printf '%s' "$DESCRIPTOR" | jq -r '.model // ""')"
AUTH_ENV="$(printf '%s' "$DESCRIPTOR" | jq -r '.auth_env // ""')"
TIMEOUT="${TIMEOUT_MS:-$(printf '%s' "$DESCRIPTOR" | jq -r '.timeout_ms // 5000')}"

# This seam speaks one wire shape. Anything else is said out loud rather than attempted.
case "$ENDPOINT" in
  */v1/systemone) : ;;
  *) fail_all unsupported "the shell seam speaks the System One wire shape only; provider \"$P_NAME\" at $ENDPOINT needs the driver" "$P_NAME" "$P_SOURCE" ;;
esac

[ -n "$ENDPOINT" ] || fail_all validation "provider \"$P_NAME\": endpoint is required" "$P_NAME" "$P_SOURCE"
[ -n "$MODEL" ]    || fail_all validation "provider \"$P_NAME\": model is required" "$P_NAME" "$P_SOURCE"
case "$MODEL" in
  *-latest|*-preview|*-stable)
    fail_all validation "provider \"$P_NAME\": model \"$MODEL\" is a moving alias — pin an exact version, because thresholds are tuned against one" "$P_NAME" "$P_SOURCE" ;;
esac

# Schema validation, against the SAME file the driver generates from its own constants.
if [ -n "$SCHEMA" ] && [ -f "$SCHEMA" ]; then
  PROBLEMS="$(jq -r --slurpfile cat "$CATALOG_FILE" '
    . as $s | $cat[0] as $c
    | ($s.properties.questions.additionalProperties.properties.type.enum) as $types
    | ($s.properties.questions.additionalProperties.allOf[1].then.properties.criteria) as $lv
    | [ (if $c.version == $s.properties.version.const then empty else "version" end),
        ( $c.questions // {} | to_entries[] as $e | select(($types | index($e.value.type // "")) == null) | "type:" + $e.key ),
        ( $c.questions // {} | to_entries[] as $e | select($e.value.type == "score")
          | select(($e.value.criteria | length) < $lv.minItems or ($e.value.criteria | length) > $lv.maxItems) | "levels:" + $e.key ),
        ( ($c.thresholds // {} | keys_unsorted[]) as $k | select(($c.questions // {} | has($k)) | not) | "orphan:" + $k ),
        ( ($c.questions // {} | keys_unsorted[]) as $k | select(($c.thresholds // {} | has($k)) | not) | "nothreshold:" + $k )
      ] | join(",")' "$SCHEMA")"
  [ -z "$PROBLEMS" ] || fail_all validation "$PROBLEMS" "$P_NAME" "$P_SOURCE"
fi

# The turn-5 rule, in the shell: an uncalibrated provider may not borrow another's bars.
FITTED="$(jq -r '.thresholds_for // ""' "$CATALOG_FILE")"
CALIBRATED="$(printf '%s' "$DESCRIPTOR" | jq -r '.calibrated // false')"
if [ -n "$FITTED" ] && [ "$FITTED" != "$P_NAME" ]; then
  fail_all validation "thresholds_for: this catalog's bars were fitted against \"$FITTED\" and the active provider is \"$P_NAME\" — a threshold is a statement about one model's probabilities and does not carry across providers. Give \"$P_NAME\" its own threshold file." "$P_NAME" "$P_SOURCE"
fi
if [ -z "$FITTED" ] && [ "$CALIBRATED" != "true" ]; then
  fail_all validation "thresholds_for: provider \"$P_NAME\" is uncalibrated, so it must carry thresholds fitted for itself — set \"thresholds_for\": \"$P_NAME\" on a catalog whose bars were chosen for it, and do not reuse a calibrated provider's." "$P_NAME" "$P_SOURCE"
fi

# `has(.)` would re-bind `.` to the object being tested, not the id — bind the id explicitly.
MISSING="$(jq -r --argjson qs "$QLIST" '. as $c | [ $qs[] as $q | select(($c.questions // {}) | has($q) | not) | $q ] | join(", ")' "$CATALOG_FILE")"
[ -z "$MISSING" ] || fail_all validation "catalog has no question(s): $MISSING" "$P_NAME" "$P_SOURCE"

KEY="$(eval printf '%s' "\${$AUTH_ENV:-}")"
[ -n "$KEY" ] || fail_all auth "$AUTH_ENV is not set" "$P_NAME" "$P_SOURCE"

# ---- the request -------------------------------------------------------------------------------
STATE='{}'
[ -n "$STATE_FILE" ] && [ -f "$STATE_FILE" ] && STATE="$(cat "$STATE_FILE")"

BODY="$(jq -nc --slurpfile cat "$CATALOG_FILE" --argjson qs "$QLIST" --argjson state "$STATE" --arg model "$MODEL" '
  $cat[0] as $c
  | { state: $state, model: $model,
      questions: ($qs | map({ key: ., value: ($c.questions[.] | if .type == "noul" and (has("criteria") | not)
                                then { type, instructions } else { type, instructions, criteria } end) }) | from_entries) }')"

HDRS="$(mktemp)"; trap 'rm -f "$HDRS"' EXIT
# The credential goes in a file curl reads, never in argv: `ps` shows argv to every user on the box.
printf 'authorization: Bearer %s\ncontent-type: application/json\n' "$KEY" > "$HDRS"

RESP="$(mktemp)"; trap 'rm -f "$HDRS" "$RESP"' EXIT
CODE="$(printf '%s' "$BODY" | curl -sS -o "$RESP" -w '%{http_code}' \
  --max-time "$(awk -v ms="$TIMEOUT" 'BEGIN { printf "%.3f", ms / 1000 }')" \
  -H @"$HDRS" --data-binary @- "$ENDPOINT" 2>/dev/null || echo 000)"

case "$CODE" in
  200) : ;;
  000) fail_all transport "no response from $ENDPOINT within ${TIMEOUT}ms" "$P_NAME" "$P_SOURCE" ;;
  401|403) fail_all auth "HTTP $CODE" "$P_NAME" "$P_SOURCE" ;;
  400|422) fail_all validation "HTTP $CODE" "$P_NAME" "$P_SOURCE" ;;
  429) fail_all rate_limit "HTTP $CODE" "$P_NAME" "$P_SOURCE" ;;
  503|529) fail_all overloaded "HTTP $CODE" "$P_NAME" "$P_SOURCE" ;;
  *) fail_all transport "HTTP $CODE" "$P_NAME" "$P_SOURCE" ;;
esac
jq -e . "$RESP" >/dev/null 2>&1 || fail_all malformed "response body is not JSON" "$P_NAME" "$P_SOURCE"

# ---- mapping, bands, events ----------------------------------------------------------------------
# certainty: a noul's distance from the coin flip, a choice or score's own confidence, and null for
# an asserted distribution. band: floor below the floor or with no certainty, act at or above the
# act bar, escalate between. The same three rules the driver's certaintyOf/bandOf implement.
jq -c --slurpfile cat "$CATALOG_FILE" --slurpfile resp "$RESP" --argjson qs "$QLIST" \
      --arg provider "$P_NAME" --arg source "$P_SOURCE" --arg reqModel "$MODEL" '
  $cat[0] as $c | $resp[0] as $r
  | ($r.model // $reqModel) as $served
  | ($qs | map(. as $q
      | ($r.answers[$q] // null) as $raw
      | ($c.thresholds[$q]) as $t
      | (if $raw == null then { ok: false, reason: "malformed", provider: $provider, detail: ("no answer for \"" + $q + "\"") }
         elif $raw.type == "noul"   then { ok: true, type: "noul", noul: $raw.noul, confidence: null, provider: $provider, model: $served }
         elif $raw.type == "choice" then { ok: true, type: "choice", choice: $raw.choice, probabilities: $raw.probabilities, confidence: ($raw.confidence // null), provider: $provider, model: $served }
         elif $raw.type == "score"  then { ok: true, type: "score", score: $raw.score, legend: ($raw.legend // {}), probabilities: $raw.probabilities, confidence: ($raw.confidence // null), provider: $provider, model: $served }
         else { ok: false, reason: "malformed", provider: $provider, detail: ("\"" + $q + "\": unknown answer type") } end) as $a
      | (if $a.ok != true then null
         elif ($a.estimated // false) then null
         elif $a.type == "noul" then (($a.noul - 0.5) | fabs) * 2
         else $a.confidence end) as $cert
      | (if $cert == null then "floor"
         elif $cert < $t.floor then "floor"
         elif $cert >= $t.act then "act"
         else "escalate" end) as $band
      | { q: $q, answer: $a, band: $band, certainty: $cert })) as $rows
  | {
      provider: $provider, source: $source,
      usable: ($rows | all(.answer.ok == true and .band == "act")),
      answers: ($rows | map({ key: .q, value: .answer }) | from_entries),
      bands:   ($rows | map({ key: .q, value: .band }) | from_entries),
      events: ([{ event: "decision_asked", provider: $provider, model: $reqModel, questions: $qs, source: $source }]
               + ($rows | map(if .answer.ok == true
                   then ({ event: "decision_answered", provider: $provider, model: .answer.model, question: .q,
                           confidence: .answer.confidence, certainty: .certainty, threshold_fired: .band, source: $source }
                         + (if .answer.type == "noul" then {} else { probabilities: .answer.probabilities } end))
                   else { event: "decision_failed", provider: $provider, question: .q, reason: .answer.reason, source: $source }
                   end)))
    }' <<< '{}'

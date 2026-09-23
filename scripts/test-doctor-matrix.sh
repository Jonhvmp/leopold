#!/usr/bin/env bash
# Behavior tests for the doctor's capability-matrix report: the join of
# hooks/hook-matrix.tsv with the live wiring, one row per capability per harness
# present, plus the version-drift row.
#
# Asserts all four statuses — verified / wired / not wired / unavailable on <harness>
# <probed version> with the tsv's note — and that a harness that IS here is never
# silent about a capability.
#
# HERMETIC: temp CLAUDE_HOME / CODEX_HOME / LEOPOLD_HOME, a temp PATH holding stub
# `claude` and `codex` binaries, and a temp copy of the matrix + the reference page.
# Never ~/, never the real binaries.
#
# MUTATION-VERIFIED (this item): dropping the partial-capability block from
# leopold-doctor.sh (the one that names the events a harness does NOT have when the
# capability is wired on the others) makes the done-gate Codex row fail — a harness with
# one of the evidence gate's two events would read as parity with the harness that has
# both. Earlier: dropping the `subagent-accounting) subagent-account.sh`
# case from m_hook_script makes the two subagent-accounting rows fail (doctor looks for a
# subagent-accounting.sh that does not exist and tells a healthy install to reinstall).
# Earlier: dropping the `api-error-stop) stop-failure.sh` case from
# m_hook_script makes the verified row fail (doctor looks for an api-error-stop.sh that
# does not exist and tells a healthy install to reinstall); dropping the `_lib.sh` check
# makes the substrate case fail. Earlier passes:
# deleting the file-watch codex row from the temp tsv makes the
# "unavailable" assertion fail; renaming the #stop-claude-code heading in the temp
# reference page makes the "verified" assertion fail (it degrades to "wired"); dropping
# the `sub_note` line from leopold-doctor.sh makes both permission-policy Codex rows fail
# (the harness that honors half the reply would read as full parity); making the on-disk
# hook check stop deriving its list from `leo_core_hook_specs` makes the missing-hook case
# fail (a hook added to the list would go unchecked on disk).
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCTOR="$ROOT/scripts/leopold-doctor.sh"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
fail=0

has() { # name haystack needle
  if printf '%s' "$2" | grep -qF -- "$3"; then echo "  ok: $1"
  else echo "  FAIL: $1 (missing '$3')"; fail=1; fi
}
hasnt() {
  if printf '%s' "$2" | grep -qF -- "$3"; then echo "  FAIL: $1 (unexpectedly found '$3')"; fail=1
  else echo "  ok: $1"; fi
}

export CLAUDE_HOME="$T/claude" CODEX_HOME="$T/codex" LEOPOLD_HOME="$T/leo" LEOPOLD_SRC="$T/src"
export LEOPOLD_PROJECT_DIR="$T/project"
mkdir -p "$CLAUDE_HOME" "$CODEX_HOME" "$LEOPOLD_HOME/hooks" "$LEOPOLD_PROJECT_DIR" "$T/bin"

# The matrix and the evidence page under test are COPIES: a mutation check must never
# touch the checkout.
MTSV="$T/hook-matrix.tsv"; cp "$ROOT/hooks/hook-matrix.tsv" "$MTSV"
MDOC="$T/hook-events.md";  cp "$ROOT/docs/reference/hook-events.md" "$MDOC"
export LEO_MATRIX_TSV="$MTSV" LEO_HOOK_EVENTS_DOC="$MDOC"

PROBED_CLAUDE="$(grep -m1 '^# probed:' "$MTSV" | sed -n 's/.* claude "\([^"]*\)".*/\1/p')"
PROBED_CODEX="$(grep -m1 '^# probed:' "$MTSV" | sed -n 's/.* codex "\([^"]*\)".*/\1/p')"

stub() { # <name> <version line>
  printf '#!/bin/sh\n[ "$1" = "--version" ] && echo %s\nexit 0\n' "$(printf '%q' "$2")" > "$T/bin/$1"
  chmod +x "$T/bin/$1"
}
stub claude "$PROBED_CLAUDE"
stub codex  "$PROBED_CODEX"
export PATH="$T/bin:$PATH"

# Both harnesses present, with the Stop hook and the git lock declared, and every other
# core hook installed on disk but declared nowhere — the evidence gate included, which is
# what the "not wired" row below reads.
touch "$LEOPOLD_HOME/hooks/stop-continuity.sh" "$LEOPOLD_HOME/hooks/guard-irreversible.sh" \
      "$LEOPOLD_HOME/hooks/permission-policy.sh" "$LEOPOLD_HOME/hooks/compact-checkpoint.sh" \
      "$LEOPOLD_HOME/hooks/stop-failure.sh" "$LEOPOLD_HOME/hooks/subagent-account.sh" \
      "$LEOPOLD_HOME/hooks/subagent-cap.sh" "$LEOPOLD_HOME/hooks/verify-receipt.sh" \
      "$LEOPOLD_HOME/hooks/done-gate.sh" "$LEOPOLD_HOME/hooks/file-watch.sh" \
      "$LEOPOLD_HOME/hooks/config-guard.sh"
chmod +x "$LEOPOLD_HOME/hooks"/*.sh
# The shared library the hooks source beside themselves. Not a hook, never wired, and
# checked all the same: three hooks refuse to act without it.
touch "$LEOPOLD_HOME/hooks/_lib.sh"
cat > "$CLAUDE_HOME/settings.json" <<JSON
{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"$LEOPOLD_HOME/hooks/stop-continuity.sh"}]}],
 "PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"$LEOPOLD_HOME/hooks/guard-irreversible.sh"}]}]}}
JSON
cat > "$CODEX_HOME/config.toml" <<TOML
# leopold (managed)
[[hooks.Stop]]
command = "$LEOPOLD_HOME/hooks/stop-continuity.sh"
[[hooks.PreToolUse]]
command = "$LEOPOLD_HOME/hooks/guard-irreversible.sh"
TOML

run_doctor() { bash "$DOCTOR" 2>&1; }

echo "1. the four statuses, both harnesses present"
out="$(run_doctor)"
has "the matrix section is printed"        "$out" "capability matrix"
has "verified: run-continuity on Claude"   "$out" "run-continuity · Claude Code: verified (Stop)"
has "verified: run-continuity on Codex"    "$out" "run-continuity · Codex: verified (Stop)"
has "verified: git-lock on Claude"         "$out" "git-lock · Claude Code: verified (PreToolUse)"
has "not wired: done-gate on Claude"       "$out" "done-gate · Claude Code: not wired — run ./install.sh (PreToolUse, TaskCompleted)"
# The evidence gate is the first capability that is PART of itself on one harness: it
# rides two events, and Codex has only the PLAN.md one. A row that said "PreToolUse" and
# stopped would read as parity with Claude Code, so the event Codex does not have is named
# on the same line with the tsv's own note for what carries the bound there.
dg_row="$(awk -F'\t' '$1=="done-gate" && $2=="TaskCompleted" && $3=="codex" {print $6}' "$MTSV")"
has "partial: done-gate on Codex names the event it lacks" "$out" \
  "done-gate · Codex: not wired — run ./install.sh (PreToolUse) — TaskCompleted: unavailable on Codex $PROBED_CODEX — $dg_row"
# A Claude-only capability: Codex says unavailable, with the probed version and the
# tsv's own note, and the Claude row still states its wiring.
# The API-error stop: wired on Claude Code (the hook is installed but declared nowhere in
# this fixture), and stated as unavailable on Codex with the tsv's own note — a Codex user
# reading this line learns that an API error there ends the run as a plain stop.
has "not wired: api-error-stop on Claude" "$out" \
  "api-error-stop · Claude Code: not wired — run ./install.sh (StopFailure)"
api_row="$(awk -F'\t' '$1=="api-error-stop" && $3=="codex" {print $6}' "$MTSV")"
has "unavailable: api-error-stop on Codex" "$out" \
  "api-error-stop · Codex: unavailable on Codex $PROBED_CODEX — $api_row"
note_row="$(awk -F'\t' '$1=="file-watch" && $3=="codex" {print $6}' "$MTSV")"
has "unavailable: file-watch on Codex"     "$out" "file-watch · Codex: unavailable on Codex $PROBED_CODEX — $note_row"
has "the Claude half is still stated"      "$out" "file-watch · Claude Code: not wired"
# The config tamper guard is the other Claude-only bound of the same pair: Codex fires no
# ConfigChange at all, so a mid-run edit of config.toml is simply not detected there, and
# the row says that in the tsv's own words rather than staying silent about it.
cg_row="$(awk -F'\t' '$1=="config-guard" && $3=="codex" {print $6}' "$MTSV")"
has "unavailable: config-guard on Codex"   "$out" "config-guard · Codex: unavailable on Codex $PROBED_CODEX — $cg_row"
has "not wired: config-guard on Claude"    "$out" "config-guard · Claude Code: not wired — run ./install.sh (ConfigChange)"
# A capability whose hook exists but is declared nowhere, on both harnesses — and on
# Codex the row carries the tsv's own note, because `substitute` there means the event
# fires with a weaker guarantee (deny honored, allow not) and a row that said only
# "wired" would read as full parity.
sub_row="$(awk -F'\t' '$1=="permission-policy" && $3=="codex" {print $6}' "$MTSV")"
has "not wired: permission-policy on Claude" "$out" "permission-policy · Claude Code: not wired — run ./install.sh (PermissionRequest)"
has "not wired: permission-policy on Codex"  "$out" "permission-policy · Codex: not wired — run ./install.sh (PermissionRequest) — substitute on PermissionRequest: $sub_row"
has "the hook files are checked, policy included" "$out" "hooks installed + executable"
# Never silence: every capability of the tsv is spoken for on both harnesses.
for cap in $(awk -F'\t' '!/^[[:space:]]*#/ && NF>=6 && !s[$1]++ {print $1}' "$MTSV"); do
  for w in "Claude Code" "Codex"; do
    printf '%s' "$out" | grep -qF "$cap · $w:" || { echo "  FAIL: no row for $cap · $w"; fail=1; }
  done
done
echo "  ok: one row per capability per harness present"
hasnt "no drift row while the stubs match the probe" "$out" "re-run scripts/probe-hook-events.sh"

# ...and the list it checks is leo_core_hook_specs', not a second copy: drop the policy
# from the asset home and doctor names that file. (MUTATION: this is the check that fails
# if the on-disk list stops being derived from the spec list.)
mv "$LEOPOLD_HOME/hooks/permission-policy.sh" "$LEOPOLD_HOME/hooks/permission-policy.off"
out1b="$(run_doctor)"
has "a missing core hook is named, not lumped into 'hooks not installed'" "$out1b" \
  "hooks not installed or not executable (permission-policy.sh) — run ./install.sh"
mv "$LEOPOLD_HOME/hooks/permission-policy.off" "$LEOPOLD_HOME/hooks/permission-policy.sh"

echo "2. wired but unproven — the evidence anchor moved"
# The page IS installed and the section the matrix cites is not in it: the docs and the
# matrix have drifted, and the only thing that re-derives both is the probe. Naming the
# installer here would send a reader to reinstall a page that is already there.
sed -i.bak 's/^### `Stop` — Claude Code$/### `Stop` — Claude Code (renamed)/' "$MDOC"
out2="$(run_doctor)"
has "verified degrades to wired"           "$out2" "run-continuity · Claude Code: wired (Stop)"
has "and says the bound is still armed"    "$out2" "armed, unproven here"
has "and names the page and the missing section" "$out2" "$MDOC has no #stop-claude-code section"
has "and the remedy is the probe"          "$out2" "re-run: make probe-hook-events"
hasnt "...not the installer"               "$out2" "no #stop-claude-code section; re-run ./install.sh"
mv "$MDOC.bak" "$MDOC"

echo "3. the drift row"
stub claude "9.9.9 (Claude Code)"
out3="$(run_doctor)"
has "the installed version is named"       "$out3" "Claude Code 9.9.9 (Claude Code) installed, matrix probed on $PROBED_CLAUDE"
has "and the probe script is named"        "$out3" "re-run scripts/probe-hook-events.sh"
stub claude "$PROBED_CLAUDE"

echo "4. a harness that is not here is not spoken for"
# A machine with no Codex at all: the stub off PATH, no $CODEX_HOME, and a PATH that
# holds only the stubs plus the system tools (the real codex must not leak in).
ln -sf "$(command -v jq)" "$T/bin/jq" 2>/dev/null || true
mv "$T/bin/codex" "$T/bin/codex.off"; rm -rf "$CODEX_HOME"
out4="$(PATH="$T/bin:/usr/bin:/bin" bash "$DOCTOR" 2>&1)"
has "Claude rows survive"                  "$out4" "run-continuity · Claude Code: verified"
hasnt "no Codex rows"                      "$out4" "· Codex:"
mv "$T/bin/codex.off" "$T/bin/codex"; mkdir -p "$CODEX_HOME"

echo "5. a wired substitute says what it costs on that harness"
# The policy declared on both: Claude Code gets the full bound, Codex gets the deny half
# and the row says so on the same line. Silence here would be the degradation this
# project bans — "verified" on a harness that ignores half the reply.
cat > "$CLAUDE_HOME/settings.json" <<JSON
{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"$LEOPOLD_HOME/hooks/stop-continuity.sh"}]}],
 "PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"$LEOPOLD_HOME/hooks/guard-irreversible.sh"}]}],
 "PermissionRequest":[{"hooks":[{"type":"command","command":"$LEOPOLD_HOME/hooks/permission-policy.sh"}]}]}}
JSON
cat >> "$CODEX_HOME/config.toml" <<TOML
[[hooks.PermissionRequest]]
command = "$LEOPOLD_HOME/hooks/permission-policy.sh"
TOML
out5="$(run_doctor)"
has "verified: permission-policy on Claude" "$out5" "permission-policy · Claude Code: verified (PermissionRequest)"
hasnt "...with no substitute caveat there"  "$out5" "permission-policy · Claude Code: verified (PermissionRequest) — substitute"
has "verified: permission-policy on Codex, with the cost stated" "$out5" \
  "permission-policy · Codex: verified (PermissionRequest) — substitute on PermissionRequest: $sub_row"
has "and the git lock is unaffected"        "$out5" "git-lock · Claude Code: verified (PreToolUse)"

# The compaction checkpoint is the first capability that rides TWO events through ONE
# script, so its row must name both — a row that said only "PreCompact" would read as if
# the post-compaction re-grounding were not wired.
cat > "$CLAUDE_HOME/settings.json" <<JSON
{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"$LEOPOLD_HOME/hooks/stop-continuity.sh"}]}],
 "PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"$LEOPOLD_HOME/hooks/guard-irreversible.sh"}]}],
 "PermissionRequest":[{"hooks":[{"type":"command","command":"$LEOPOLD_HOME/hooks/permission-policy.sh"}]}],
 "PreCompact":[{"hooks":[{"type":"command","command":"$LEOPOLD_HOME/hooks/compact-checkpoint.sh"}]}],
 "PostCompact":[{"hooks":[{"type":"command","command":"$LEOPOLD_HOME/hooks/compact-checkpoint.sh"}]}]}}
JSON
cat >> "$CODEX_HOME/config.toml" <<TOML
[[hooks.PreCompact]]
command = "$LEOPOLD_HOME/hooks/compact-checkpoint.sh"
[[hooks.PostCompact]]
command = "$LEOPOLD_HOME/hooks/compact-checkpoint.sh"
TOML
out5b="$(run_doctor)"
has "verified: compact-checkpoint names BOTH events on Claude" "$out5b" \
  "compact-checkpoint · Claude Code: verified (PreCompact, PostCompact)"
has "verified: compact-checkpoint names BOTH events on Codex"  "$out5b" \
  "compact-checkpoint · Codex: verified (PreCompact, PostCompact)"
hasnt "...and neither row claims a substitute"                 "$out5b" \
  "compact-checkpoint · Codex: verified (PreCompact, PostCompact) — substitute"

# The one capability wired on ONE harness: declared on Claude Code, refused on Codex by
# the matrix. Both halves must be stated — the wired one as verified, the other in words.
python3 - "$CLAUDE_HOME/settings.json" "$LEOPOLD_HOME/hooks/stop-failure.sh" <<'PYEOF'
import json, sys
p, cmd = sys.argv[1], sys.argv[2]
d = json.load(open(p))
d["hooks"]["StopFailure"] = [{"hooks": [{"type": "command", "command": cmd}]}]
json.dump(d, open(p, "w"), indent=1)
PYEOF
out5c="$(run_doctor)"
has "verified: api-error-stop on Claude"   "$out5c" "api-error-stop · Claude Code: verified (StopFailure)"
has "...and Codex still says what it costs there" "$out5c" \
  "api-error-stop · Codex: unavailable on Codex $PROBED_CODEX — $api_row"
# The subagent bounds: two capabilities, one script each, BOTH harnesses available in the
# matrix — so four rows, and `subagent-accounting` is the second capability whose script is
# not <capability>.sh (m_hook_script maps it to subagent-account.sh, the name it installs
# under). Without that case doctor looks for a subagent-accounting.sh that does not exist
# and tells a healthy install to reinstall.
python3 - "$CLAUDE_HOME/settings.json" "$LEOPOLD_HOME/hooks" <<'PYEOF'
import json, sys
p, hooks = sys.argv[1], sys.argv[2]
d = json.load(open(p))
d["hooks"]["SubagentStart"] = [{"hooks": [{"type": "command", "command": hooks + "/subagent-account.sh"}]}]
d["hooks"]["SubagentStop"] = [{"hooks": [{"type": "command", "command": hooks + "/subagent-account.sh"}]}]
d["hooks"]["PreToolUse"].append({"matcher": "Agent|Task|collaborationspawn_agent",
                                 "hooks": [{"type": "command", "command": hooks + "/subagent-cap.sh"}]})
json.dump(d, open(p, "w"), indent=1)
PYEOF
cat >> "$CODEX_HOME/config.toml" <<TOML
[[hooks.SubagentStart]]
command = "$LEOPOLD_HOME/hooks/subagent-account.sh"
[[hooks.SubagentStop]]
command = "$LEOPOLD_HOME/hooks/subagent-account.sh"
[[hooks.PreToolUse]]
matcher = "Agent|Task|collaborationspawn_agent"
command = "$LEOPOLD_HOME/hooks/subagent-cap.sh"
TOML
out5e="$(run_doctor)"
has "verified: subagent-accounting names BOTH events on Claude" "$out5e" \
  "subagent-accounting · Claude Code: verified (SubagentStart, SubagentStop)"
has "verified: subagent-accounting names BOTH events on Codex"  "$out5e" \
  "subagent-accounting · Codex: verified (SubagentStart, SubagentStop)"
has "verified: subagent-cap on Claude" "$out5e" "subagent-cap · Claude Code: verified (PreToolUse)"
has "verified: subagent-cap on Codex"  "$out5e" "subagent-cap · Codex: verified (PreToolUse)"
hasnt "neither subagent row claims a substitute" "$out5e" "subagent-accounting · Codex: verified (SubagentStart, SubagentStop) — substitute"
# ...and the ledger's own script is what doctor looked for: hide it and the row goes to
# "not wired", which is the mutation that proves the m_hook_script case is load-bearing.
mv "$LEOPOLD_HOME/hooks/subagent-account.sh" "$LEOPOLD_HOME/hooks/subagent-account.off"
out5f="$(run_doctor)"
has "a missing ledger script is named by the on-disk check" "$out5f" \
  "hooks not installed or not executable (subagent-account.sh) — run ./install.sh"
mv "$LEOPOLD_HOME/hooks/subagent-account.off" "$LEOPOLD_HOME/hooks/subagent-account.sh"

# The receipts: ONE script on TWO events on Claude Code, and ONE of those two on Codex —
# the first capability whose per-harness EVENT LIST differs, and the second whose Codex row
# is a `substitute` that is still wired. Both halves have to be stated: the Codex line
# names the one event it rides AND quotes the row's note, because "verified" on a harness
# that cannot tell a pass from a failure is exactly the silent degradation this bans.
vr_row="$(awk -F'\t' '$1=="verify-receipt" && $2=="PostToolUse" && $3=="codex" {print $6}' "$MTSV")"
python3 - "$CLAUDE_HOME/settings.json" "$LEOPOLD_HOME/hooks" <<'PYEOF'
import json, sys
p, hooks = sys.argv[1], sys.argv[2]
d = json.load(open(p))
for ev in ("PostToolUse", "PostToolUseFailure"):
    d["hooks"][ev] = [{"matcher": "Bash|Edit|Write|MultiEdit|NotebookEdit|apply_patch",
                       "hooks": [{"type": "command", "command": hooks + "/verify-receipt.sh"}]}]
json.dump(d, open(p, "w"), indent=1)
PYEOF
cat >> "$CODEX_HOME/config.toml" <<TOML
[[hooks.PostToolUse]]
matcher = "Bash|Edit|Write|MultiEdit|NotebookEdit|apply_patch"
command = "$LEOPOLD_HOME/hooks/verify-receipt.sh"
TOML
out5g="$(run_doctor)"
has "verified: verify-receipt names BOTH events on Claude" "$out5g" \
  "verify-receipt · Claude Code: verified (PostToolUse, PostToolUseFailure)"
has "verified: verify-receipt names the ONE event Codex has" "$out5g" \
  "verify-receipt · Codex: verified (PostToolUse) — substitute on PostToolUse: $vr_row"
hasnt "...and never claims PostToolUseFailure on Codex" "$out5g" \
  "verify-receipt · Codex: verified (PostToolUse, PostToolUseFailure)"
# The mutation that proves the on-disk check covers this hook too: hide the script and the
# install is reported incomplete BY NAME, not rounded up to "hooks not installed".
mv "$LEOPOLD_HOME/hooks/verify-receipt.sh" "$LEOPOLD_HOME/hooks/verify-receipt.off"
has "a missing receipt script is named by the on-disk check" "$(run_doctor)" \
  "hooks not installed or not executable (verify-receipt.sh) — run ./install.sh"
mv "$LEOPOLD_HOME/hooks/verify-receipt.off" "$LEOPOLD_HOME/hooks/verify-receipt.sh"

# The pair of Claude-only detectors, declared: the second-writer watch (four FileChanged
# entries for two files — the wiring the live probe forced) and the config tamper guard.
# Both must read `verified` on Claude Code and stay `unavailable` on Codex in the SAME
# run, because a row that went quiet on Codex once its Claude twin was wired would be the
# silent degradation this matrix exists to prevent.
python3 - "$CLAUDE_HOME/settings.json" "$LEOPOLD_HOME/hooks" <<'PYEOF'
import json, sys
p, hooks = sys.argv[1], sys.argv[2]
d = json.load(open(p))
d["hooks"]["FileChanged"] = [
    {"matcher": m, "hooks": [{"type": "command", "command": hooks + "/file-watch.sh"}]}
    for m in (".leopold/PLAN.md", "PLAN.md", ".leopold/DECISIONS.md", "DECISIONS.md")]
d["hooks"]["ConfigChange"] = [{"hooks": [{"type": "command", "command": hooks + "/config-guard.sh"}]}]
json.dump(d, open(p, "w"), indent=1)
PYEOF
out5w="$(run_doctor)"
has "verified: file-watch on Claude"   "$out5w" "file-watch · Claude Code: verified (FileChanged)"
has "verified: config-guard on Claude" "$out5w" "config-guard · Claude Code: verified (ConfigChange)"
has "...and Codex still says unavailable for the watch"  "$out5w" \
  "file-watch · Codex: unavailable on Codex $PROBED_CODEX — $note_row"
has "...and for the config guard"                        "$out5w" \
  "config-guard · Codex: unavailable on Codex $PROBED_CODEX — $cg_row"
mv "$LEOPOLD_HOME/hooks/file-watch.sh" "$LEOPOLD_HOME/hooks/file-watch.off"
has "a missing detector script is named by the on-disk check" "$(run_doctor)" \
  "hooks not installed or not executable (file-watch.sh) — run ./install.sh"
mv "$LEOPOLD_HOME/hooks/file-watch.off" "$LEOPOLD_HOME/hooks/file-watch.sh"

# The shared library is substrate, not a hook: no spec names it, and an install without it
# has three hooks that refuse to act. Doctor names the file rather than reporting health.
mv "$LEOPOLD_HOME/hooks/_lib.sh" "$LEOPOLD_HOME/hooks/_lib.off"
out5d="$(run_doctor)"
has "a hooks dir with no _lib.sh is reported, by name" "$out5d" \
  "hooks not installed or not executable (_lib.sh) — run ./install.sh"
mv "$LEOPOLD_HOME/hooks/_lib.off" "$LEOPOLD_HOME/hooks/_lib.sh"

echo "6. the npm install path — the asset home the driver's build vendors"
# Every section above exports LEO_HOOK_EVENTS_DOC, which is precisely why none of them
# could see this: on npm — "the fastest path" in docs/getting-started/install.md — the
# asset home is a copy of packages/driver/assets, and doctor has to FIND the evidence
# page in it with no env var pointing the way. When the build did not vendor docs/,
# every correctly wired capability reported "wired … re-run ./install.sh" and nothing
# was ever `verified`: the four-status contract collapsed to three, the armed git lock
# read as a warning, and the remedy named could not fix it (reinstalling never brought a
# page the package did not carry).
#
# The dirs are DERIVED from copy-runtime.mjs, never re-typed here — drop `docs` from
# that list and this section fails, which is the whole point of reading it rather than
# listing it.
NPM_LEO="$T/npm-leo"; mkdir -p "$NPM_LEO"
CRUNTIME="$ROOT/packages/driver/scripts/copy-runtime.mjs"
VENDORED="$(sed -n 's/^const DIRS = \[\(.*\)\];[[:space:]]*$/\1/p' "$CRUNTIME" | tr -d '" ' | tr ',' ' ')"
if [ -z "$VENDORED" ]; then
  echo "  FAIL: could not read the vendored dir list out of $CRUNTIME (did 'const DIRS = [...]' change shape?)"; fail=1
fi
for d in $VENDORED; do [ -d "$ROOT/$d" ] && cp -R "$ROOT/$d" "$NPM_LEO/"; done
cat > "$CLAUDE_HOME/settings.json" <<JSON
{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"$NPM_LEO/hooks/stop-continuity.sh"}]}],
 "PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"$NPM_LEO/hooks/guard-irreversible.sh"}]}],
 "PermissionRequest":[{"hooks":[{"type":"command","command":"$NPM_LEO/hooks/permission-policy.sh"}]}]}}
JSON
cat > "$CODEX_HOME/config.toml" <<TOML
# leopold (managed)
[[hooks.Stop]]
command = "$NPM_LEO/hooks/stop-continuity.sh"
[[hooks.PreToolUse]]
command = "$NPM_LEO/hooks/guard-irreversible.sh"
[[hooks.PermissionRequest]]
command = "$NPM_LEO/hooks/permission-policy.sh"
TOML
# No LEO_HOOK_EVENTS_DOC and no LEO_MATRIX_TSV: both must resolve out of the asset home,
# and the doctor under test is the INSTALLED copy, the one an npm user actually runs.
run_npm_doctor() {
  env -u LEO_HOOK_EVENTS_DOC -u LEO_MATRIX_TSV LEOPOLD_HOME="$NPM_LEO" \
    bash "$NPM_LEO/scripts/leopold-doctor.sh" 2>&1
}
out6="$(run_npm_doctor)"
has "the matrix is found in the asset home"  "$out6" "$NPM_LEO/hooks/hook-matrix.tsv"
has "verified: git-lock on Claude"           "$out6" "git-lock · Claude Code: verified (PreToolUse)"
has "verified: git-lock on Codex"            "$out6" "git-lock · Codex: verified (PreToolUse)"
has "verified: run-continuity on Claude"     "$out6" "run-continuity · Claude Code: verified (Stop)"
has "verified: permission-policy on Claude"  "$out6" "permission-policy · Claude Code: verified (PermissionRequest)"
hasnt "nothing is 'armed, unproven' here"    "$out6" "armed, unproven"

# ...and when the page really is absent, that is a DIFFERENT diagnosis from a moved
# anchor, with a different remedy: the installer brings the page, the probe rewrites it.
[ -d "$NPM_LEO/docs" ] && mv "$NPM_LEO/docs" "$NPM_LEO/docs.off"
out6b="$(run_npm_doctor)"
has "the bound is still reported as armed" "$out6b" "git-lock · Claude Code: wired (PreToolUse) — armed, unproven here"
has "and says the page is not installed"   "$out6b" "docs/reference/hook-events.md is not installed"
has "and names where it looked"            "$out6b" "looked in: $NPM_LEO/docs/reference/hook-events.md"
has "and the remedy is the installer"      "$out6b" "re-run ./install.sh to bring it"
# On the row itself, not the whole report: the probe is the OTHER diagnosis's remedy, and
# sending someone to spend model calls re-probing a page that was simply never copied is
# the wrong instruction. (Asserted against one row so it cannot pass vacuously.)
gl_row="$(printf '%s\n' "$out6b" | grep -F 'git-lock · Claude Code:')"
hasnt "...and that row does not send them to the probe" "$gl_row" "probe-hook-events"
has "the git lock is never silent"         "$out6b" "git-lock · Codex:"
[ -d "$NPM_LEO/docs.off" ] && mv "$NPM_LEO/docs.off" "$NPM_LEO/docs"

echo
echo "7. review-lens-roles — the capability whose substrate is role FILES, not a hook"
# Codex reads an agent role from $CODEX_HOME/agents/<role>.toml; Claude Code has no role
# files at all. Reporting this through the hook check would look for a
# review-lens-roles.sh that is not supposed to exist and tell a healthy install to
# re-install. (MUTATION: delete the m_review_lens_row branch in leopold-doctor.sh and
# every case below fails.)
rm -rf "${CODEX_HOME:?}/agents"
out7="$(run_doctor)"
has "Codex without the roles says they are not installed" "$out7" \
  "review-lens-roles · Codex: not installed — run ./install.sh (4 role files under $CODEX_HOME/agents)"
hasnt "and never asks for a hook that does not exist"     "$out7" "review-lens-roles · Codex: not wired"
has "Claude Code is stated as the substitute it is"       "$out7" \
  "review-lens-roles · Claude Code: verified (SubagentStart) — no role files on Claude Code; each lens is the driver's own SDK session"

# Install them through the one writer, exactly as scripts/install-codex.sh does.
bash -c '. "$1"/extensions/lib/harness.sh
  specs=(); while IFS= read -r l; do [ -n "$l" ] && specs+=("$l"); done < <(leo_review_lens_specs)
  leo_write_codex_agent_roles "$2" "${specs[@]}"' _ "$ROOT" "$CODEX_HOME" >/dev/null
out7b="$(run_doctor)"
has "with the roles installed the row is verified" "$out7b" \
  "review-lens-roles · Codex: verified (SubagentStart) — 4 role files in $CODEX_HOME/agents"
has "and it names how to spawn one"                "$out7b" 'spawn_agent(agent_type="leopold-lens-<lens>")'
# The honesty the probe demands: the roles exist, and `codex exec` still cannot BE one.
has "and states what codex exec cannot do"         "$out7b" "cannot run as a role (probed)"
has "and what keeps a headless lens read-only"     "$out7b" "read-only via --sandbox"

# Half the roles is not the capability: say which file is missing rather than pass.
rm -f "$CODEX_HOME/agents/leopold-lens-conformance.toml"
out7c="$(run_doctor)"
has "a missing lens is named, not rounded up" "$out7c" \
  "review-lens-roles · Codex: incomplete — 3/4 role files in $CODEX_HOME/agents (missing: leopold-lens-conformance.toml)"

# ---- the decisions capability ------------------------------------------------------------
# Five statuses and one silence. The silence is the one worth a test: an optional capability
# nobody opted into must not add a line to a health report, and "byte for byte what it was
# before" is only true if something checks.
echo
echo "decisions capability rows"

export LEOPOLD_DECISIONS_DIR="$T/decisions"
DEC_PROJ="$LEOPOLD_PROJECT_DIR/.leopold"
mkdir -p "$DEC_PROJ"

out_absent="$(bash "$ROOT/scripts/leopold-doctor.sh" 2>&1 || true)"
hasnt "absent: doctor says nothing about decisions" "$out_absent" "decisions"

mkdir -p "$LEOPOLD_DECISIONS_DIR"
install -m 0755 "$ROOT/extensions/decisions/payload/decisions.sh" "$LEOPOLD_DECISIONS_DIR/decisions.sh"
install -m 0644 "$ROOT/packages/driver/src/decisions/catalog.schema.json" "$LEOPOLD_DECISIONS_DIR/"
install -m 0644 "$ROOT/packages/driver/src/decisions/providers.json" "$LEOPOLD_DECISIONS_DIR/"

out_unconf="$(bash "$ROOT/scripts/leopold-doctor.sh" 2>&1 || true)"
has "installed: the payload row names the dir and the one-seam fact" "$out_unconf" "decisions installed in"
has "installed: the seam is stated as harness-independent" "$out_unconf" "same seam on every harness"
has "no config: consumers are said to use the deterministic path" "$out_unconf" "every consumer uses its deterministic path"

mkdir -p "$DEC_PROJ/decisions"
cat > "$DEC_PROJ/decisions/config.json" <<'JSON'
{ "version": "decisions/1.0", "provider": "jev",
  "providers": {
    "jev": { "name":"jev","endpoint":"https://api.typesafe.ai/v1/systemone","model":"jev-1.13.0",
             "calibrated":true,"calibration_source":"trained","auth_env":"DOCTOR_TEST_KEY",
             "timeout_ms":5000,"max_options":255,"max_state_tokens":32000 },
    "openrouter": { "name":"openrouter","endpoint":"https://openrouter.ai/api/v1/chat/completions",
             "model":"openai/gpt-5.1","calibrated":false,"auth_env":"DOCTOR_TEST_OR_KEY",
             "timeout_ms":20000,"max_options":64,"max_state_tokens":32000 }
  } }
JSON

out_nokey="$(bash "$ROOT/scripts/leopold-doctor.sh" 2>&1 || true)"
has "active provider is marked active" "$out_nokey" "decisions provider jev · active"
has "a configured but inactive provider is listed too" "$out_nokey" "decisions provider openrouter · configured"
has "an absent key is named by variable, not by value" "$out_nokey" "key: DOCTOR_TEST_KEY absent"
has "an uncalibrated provider carries the portability warning" "$out_nokey" "UNCALIBRATED — thresholds not portable"

export DOCTOR_TEST_KEY="doctor-canary-0002"
out_key="$(bash "$ROOT/scripts/leopold-doctor.sh" 2>&1 || true)"
has "a present key is reported as present" "$out_key" "key: DOCTOR_TEST_KEY present"
hasnt "the key VALUE never reaches the report" "$out_key" "doctor-canary-0002"

# An operator-declared claim must never read like a trained one.
python3 - "$DEC_PROJ/decisions/config.json" <<'PYEOF'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d["providers"]["jev"]["calibration_source"] = "operator-declared"
json.dump(d, open(p, "w"))
PYEOF
out_declared="$(bash "$ROOT/scripts/leopold-doctor.sh" 2>&1 || true)"
has "an operator-declared claim is labelled unverified" "$out_declared" "calibrated (operator-declared, unverified)"

# A catalog that does not parse is named, and its consumer is said to fall back.
printf 'not json' > "$DEC_PROJ/decisions/routing.json"
out_badcat="$(bash "$ROOT/scripts/leopold-doctor.sh" 2>&1 || true)"
has "an unparseable catalog is named" "$out_badcat" "decisions catalog routing.json is not valid JSON"
rm -f "$DEC_PROJ/decisions/routing.json"

# A half-install is a FAIL, not a warning: the seam cannot validate a catalog without its schema.
rm -f "$LEOPOLD_DECISIONS_DIR/catalog.schema.json"
out_half="$(bash "$ROOT/scripts/leopold-doctor.sh" 2>&1 || true)"
has "a missing derived asset is named" "$out_half" "missing catalog.schema.json"
unset DOCTOR_TEST_KEY LEOPOLD_DECISIONS_DIR

echo
if [ "$fail" = "0" ]; then echo "doctor capability matrix: all checks passed"; else echo "doctor capability matrix: FAILURES"; fi
exit "$fail"

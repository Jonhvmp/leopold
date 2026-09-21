#!/usr/bin/env bash
# Behavior tests for the shared harness wiring helper (extensions/lib/harness.sh)
# and for the two installers that now use it.
#
# HERMETIC: every path is inside a temp dir. CLAUDE_HOME / CODEX_HOME / LEOPOLD_HOME
# are pointed at it, so this never reads or writes the developer's real ~/.claude
# or ~/.codex. A test that mutates your harness home is not a test.
#
# The core-spec, capability-matrix, status-word, prune-scope, fail-open, accounting,
# stale-wiring, parity, docs and Claude-install sections were each verified by mutation —
# the defect reintroduced, the failure watched, the code restored. Every mutation and the
# cases it breaks are recorded in .leopold/DECISIONS.md, under "core hook specs — mutation
# checks for this item's tests", "... for the review fixes" and "... for the second review
# pass".
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB="$ROOT/extensions/lib/harness.sh"

# shellcheck source=../extensions/lib/harness.sh
. "$LIB"

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  \033[32mok\033[0m   %s\n' "$*"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "$*"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want [$3], got [$2])"; fi; }

# Fingerprint the developer's REAL harness homes so the last assertions can prove
# nothing in this file wandered outside its temp dir.
#
# Names only, and never "." / "..": a live agent session writes into its own home
# the whole time this suite runs (transcripts, history, sqlite), and $HOME's own
# mtime moves on its own. Timestamps here would make the test fail for reasons that
# have nothing to do with Leopold. What an escaped write actually looks like is a
# NEW entry — leopold/, skills/, config.toml, settings.json — and that is what this
# catches. The per-file assertions above cover content.
real_home_fingerprint()   { ls -A "$HOME/.codex"  2>/dev/null | sort | cksum; }
real_claude_fingerprint() { ls -A "$HOME/.claude" 2>/dev/null | sort | cksum; }
REAL_BEFORE="$(real_home_fingerprint)"
REAL_CLAUDE_BEFORE="$(real_claude_fingerprint)"

TD="$(mktemp -d)"
trap 'rm -rf "$TD"' EXIT
export CLAUDE_HOME="$TD/claude" CODEX_HOME="$TD/codex" LEOPOLD_HOME="$TD/leopold"
mkdir -p "$CLAUDE_HOME" "$CODEX_HOME" "$LEOPOLD_HOME"

toml_hook_count() { # <file> <event>
  python3 - "$1" "$2" <<'PY'
import sys, tomllib
with open(sys.argv[1], "rb") as fh:
    d = tomllib.load(fh)
print(len(d.get("hooks", {}).get(sys.argv[2], [])))
PY
}
toml_ok() { python3 -c 'import sys,tomllib;tomllib.load(open(sys.argv[1],"rb"))' "$1" 2>/dev/null; }

echo "harness.sh — TOML writer"

# --- 1. idempotency: three writes, one hook, still valid TOML -----------------
CFG="$TD/codex/config.toml"
printf 'model = "gpt-5"\n\n[tui]\ntheme = "dark"\n' > "$CFG"
for _ in 1 2 3; do
  leo_wire_hooks_toml "$CFG" leopold "PreToolUse|Bash|/x/guard.sh|5" "Stop||/x/stop.sh|15" >/dev/null
done
if toml_ok "$CFG"; then ok "config.toml still parses as TOML after 3 writes"; else bad "config.toml no longer parses"; fi
check "exactly one PreToolUse hook after 3 writes" "$(toml_hook_count "$CFG" PreToolUse)" "1"
check "exactly one Stop hook after 3 writes"       "$(toml_hook_count "$CFG" Stop)"       "1"
check "exactly one managed block"                  "$(grep -c '^# >>> leopold (managed) >>>$' "$CFG")" "1"
check "the user's own keys survived"               "$(python3 -c 'import tomllib,sys;print(tomllib.load(open(sys.argv[1],"rb"))["tui"]["theme"])' "$CFG")" "dark"
check "backup written"                             "$( [ -f "$CFG.leopold.bak" ] && echo yes || echo no )" "yes"

# tag "leopold" must keep the ORIGINAL markers — an existing install has to be
# replaced, never shadowed by a second block under a new marker name.
check "legacy marker preserved for the leopold tag" "$(grep -c '^# <<< leopold (managed) <<<$' "$CFG")" "1"

# a second, differently tagged block coexists without disturbing the first
leo_wire_hooks_toml "$CFG" enhance "UserPromptSubmit||python3 /x/enhance.py|30" >/dev/null
check "second tag adds its own block"    "$(grep -c '^# >>> leopold:enhance (managed) >>>$' "$CFG")" "1"
check "first block untouched by the second tag" "$(toml_hook_count "$CFG" PreToolUse)" "1"
check "still valid TOML with two blocks" "$(toml_ok "$CFG" && echo yes || echo no)" "yes"

# Regression: re-wiring a block that sits in the MIDDLE of the file must not grow it.
# Removing the block used to leave its leading blank line behind while the fresh copy
# brought a new one, so config.toml gained an empty line on every re-install — for the
# installer, which rewrites three blocks per run, that is unbounded growth.
leo_wire_hooks_toml "$CFG" leopold "PreToolUse|Bash|/x/guard.sh|5" "Stop||/x/stop.sh|15" >/dev/null
cp "$CFG" "$TD/mid-before.toml"
for _ in 1 2 3; do
  leo_wire_hooks_toml "$CFG" leopold "PreToolUse|Bash|/x/guard.sh|5" "Stop||/x/stop.sh|15" >/dev/null
done
check "re-wiring a middle block leaves the file byte-identical" \
  "$(diff -q "$TD/mid-before.toml" "$CFG" >/dev/null && echo same || echo changed)" "same"
check "and never stacks up blank lines" \
  "$(awk 'BEGIN{n=0;m=0} /^[[:space:]]*$/{n++; if(n>m)m=n; next} {n=0} END{print m}' "$CFG")" "1"
check "every managed block is still separated by one blank line" \
  "$(awk '/^# >>> .* \(managed\) >>>$/ && NR > 1 && prev !~ /^[[:space:]]*$/ {n++} {prev=$0} END{print n+0}' "$CFG")" "0"

# quotes/backslashes in a command must be escaped, not left to break the file
leo_wire_hooks_toml "$CFG" quoting 'Stop||/x/we"ird\path.sh|5' >/dev/null
check "a quote in the command stays valid TOML" "$(toml_ok "$CFG" && echo yes || echo no)" "yes"

# --- 2. rollback: a config that cannot parse is never replaced ----------------
BROKEN="$TD/codex/broken.toml"
printf 'this is = not [valid toml\n' > "$BROKEN"
before="$(cat "$BROKEN")"
out="$(leo_wire_hooks_toml "$BROKEN" leopold "Stop||/x/stop.sh|15" 2>&1)"; rc=$?
check "unparseable result -> non-zero exit"      "$rc" "1"
check "unparseable result -> original untouched" "$(cat "$BROKEN")" "$before"
if printf '%s' "$out" | grep -q '\[\[hooks.Stop\]\]'; then
  ok "unparseable result -> the block is printed for manual use"
else
  bad "unparseable result -> no manual block printed"
fi

echo
echo "harness.sh — JSON writer"

# --- 3. idempotency: three writes, one hook, still valid JSON -----------------
SET="$TD/claude/settings.json"
printf '{"permissions":{"allow":["Bash(ls:*)"]}}\n' > "$SET"
for _ in 1 2 3; do
  leo_wire_hooks_json "$SET" leopold \
    "PreToolUse|Bash|/x/guard.sh|" "Stop||/x/stop.sh|" >/dev/null
done
if jq -e . "$SET" >/dev/null 2>&1; then ok "settings.json still parses as JSON after 3 writes"; else bad "settings.json no longer parses"; fi
check "exactly one PreToolUse entry after 3 writes" "$(jq '[.hooks.PreToolUse[].hooks[]] | length' "$SET")" "1"
check "exactly one Stop entry after 3 writes"       "$(jq '[.hooks.Stop[].hooks[]] | length' "$SET")" "1"
check "matcher written"     "$(jq -r '.hooks.PreToolUse[0].matcher' "$SET")" "Bash"
check "command written"     "$(jq -r '.hooks.PreToolUse[0].hooks[0].command' "$SET")" "/x/guard.sh"
check "no timeout when unset" "$(jq -r '.hooks.Stop[0].hooks[0] | has("timeout")' "$SET")" "false"
check "user settings survived" "$(jq -r '.permissions.allow[0]' "$SET")" "Bash(ls:*)"
check "backup written"      "$( [ -f "$SET.leopold.bak" ] && echo yes || echo no )" "yes"

# an existing entry is re-timed, not duplicated
leo_wire_hooks_json "$SET" leopold "Stop||/x/stop.sh|22" >/dev/null
check "re-wiring updates the timeout in place" "$(jq -r '.hooks.Stop[0].hooks[0].timeout' "$SET")" "22"
check "and still exactly one Stop entry"       "$(jq '[.hooks.Stop[].hooks[]] | length' "$SET")" "1"

# a different extension's hook lands next to it
leo_wire_hooks_json "$SET" enhance "UserPromptSubmit||python3 /x/enhance.py|30" >/dev/null
check "a second extension coexists" "$(jq '[.hooks.UserPromptSubmit[].hooks[]] | length' "$SET")" "1"
check "and the first is untouched"  "$(jq '[.hooks.Stop[].hooks[]] | length' "$SET")" "1"

# --- 4. rollback: settings that cannot parse are never replaced ---------------
BAD="$TD/claude/bad.json"
printf '{ this is not json\n' > "$BAD"
before="$(cat "$BAD")"
out="$(leo_wire_hooks_json "$BAD" leopold "Stop||/x/stop.sh|" 2>&1)"; rc=$?
check "unparseable result -> non-zero exit"      "$rc" "1"
check "unparseable result -> original untouched" "$(cat "$BAD")" "$before"
if printf '%s' "$out" | grep -q '"command": "/x/stop.sh"'; then
  ok "unparseable result -> the block is printed for manual use"
else
  bad "unparseable result -> no manual block printed"
fi

echo
echo "harness.sh — harness resolution"
check "LEOPOLD_HARNESS=claude" "$(LEOPOLD_HARNESS=claude leo_harness_targets)" "claude"
check "LEOPOLD_HARNESS=codex"  "$(LEOPOLD_HARNESS=codex  leo_harness_targets)" "codex"
check "LEOPOLD_HARNESS=all"    "$(LEOPOLD_HARNESS=all    leo_harness_targets)" "claude codex"
check "LEOPOLD_HOME wins for the asset home" "$(leo_asset_home)" "$LEOPOLD_HOME"
(LEOPOLD_HARNESS=bogus leo_harness_targets >/dev/null 2>&1)
check "an unknown harness is rejected" "$?" "2"

# the dispatcher writes both formats in one call
DTD="$TD/dispatch"; mkdir -p "$DTD/claude" "$DTD/codex"
( export CLAUDE_HOME="$DTD/claude" CODEX_HOME="$DTD/codex" LEOPOLD_HARNESS=all
  leo_wire_hooks demo "Stop||/x/demo.sh|9" >/dev/null 2>&1 )
check "dispatcher wrote settings.json" "$(jq -r '.hooks.Stop[0].hooks[0].command' "$DTD/claude/settings.json" 2>/dev/null)" "/x/demo.sh"
check "dispatcher wrote config.toml"   "$(grep -c '^command = "/x/demo.sh"$' "$DTD/codex/config.toml" 2>/dev/null)" "1"

echo
echo "install-codex.sh — hermetic install (no real ~/.codex touched)"

# A full Codex install into a throwaway CODEX_HOME, three times over.
ITD="$TD/install"; mkdir -p "$ITD/codex" "$ITD/leo/hooks"
cp "$ROOT/hooks/guard-irreversible.sh" "$ROOT/hooks/stop-continuity.sh" "$ITD/leo/hooks/"
printf 'model = "gpt-5"\n' > "$ITD/codex/config.toml"
irc=0
for _ in 1 2 3; do
  ( export CODEX_HOME="$ITD/codex"
    bash "$ROOT/scripts/install-codex.sh" "$ROOT" "$ITD/leo" ) >/dev/null 2>&1 || irc=1
done
check "install-codex.sh ran clean 3x"        "$irc" "0"
check "config.toml parses after 3 installs"  "$(toml_ok "$ITD/codex/config.toml" && echo yes || echo no)" "yes"
# PreToolUse carries THREE Leopold hooks now — the git lock, the subagent cap and the
# evidence gate — so the idempotency invariant is one entry per (event, SCRIPT), never one
# per event. Counting per event would either fail here forever or, if relaxed to "at least
# one", stop noticing the duplicate a third install used to leave behind.
check "three PreToolUse hooks: the git lock, the cap and the evidence gate" "$(toml_hook_count "$ITD/codex/config.toml" PreToolUse)" "3"
check "...one git lock, not three"           "$(grep -c 'guard-irreversible.sh' "$ITD/codex/config.toml")" "1"
check "...one subagent cap, not three"       "$(grep -c 'subagent-cap.sh' "$ITD/codex/config.toml")" "1"
check "...and one subagent ledger per event" "$(grep -c 'subagent-account.sh' "$ITD/codex/config.toml")" "2"
check "exactly one Stop hook"                "$(toml_hook_count "$ITD/codex/config.toml" Stop)" "1"
check "the user's own config key survived"   "$(python3 -c 'import tomllib,sys;print(tomllib.load(open(sys.argv[1],"rb"))["model"])' "$ITD/codex/config.toml")" "gpt-5"
check "guard hook points at the asset home"  "$(grep -c "^command = \"$ITD/leo/hooks/guard-irreversible.sh\"$" "$ITD/codex/config.toml")" "1"
check "skills installed"                     "$( [ -f "$ITD/codex/skills/leopold-run/SKILL.md" ] && echo yes || echo no )" "yes"
check "the real ~/.codex gained no new entries"   "$(real_home_fingerprint)" "$REAL_BEFORE"
echo
echo "harness.sh — Codex agent roles (the driver's review lenses)"
# Codex CLI has a native agent role; Claude Code does not. The probe proved a role file
# at $CODEX_HOME/agents/<role>.toml is honored by spawn_agent(agent_type=<role>), that
# ONE unknown key makes Codex ignore the whole file, and that `codex exec` cannot run AS
# a role (docs/reference/hook-events.md, "#subagentstart-codex-cli"). This section tests
# the writer that produces those files; packages/driver/test/codex-agent-roles.test.ts
# tests that what it writes IS what src/review.ts's REVIEW_LENSES says.
RHOME="$TD/roles"
LENS_SPECS=()
while IFS= read -r spec; do [ -n "$spec" ] && LENS_SPECS+=("$spec"); done < <(leo_review_lens_specs)
check "the lens list has one spec per review lens" "${#LENS_SPECS[@]}" "4"

leo_write_codex_agent_roles "$RHOME" "${LENS_SPECS[@]}" >/dev/null
check "roles written on the first install" "${LEO_ROLES_WRITTEN:-x}" "4"
r_missing=0
for lens in correctness security does-it-work conformance; do
  [ -f "$RHOME/agents/leopold-lens-$lens.toml" ] || r_missing=$((r_missing+1))
done
check "one role file per lens, named for the lens" "$r_missing" "0"
check "every role file parses as TOML" \
  "$(n=0; for f in "$RHOME"/agents/*.toml; do toml_ok "$f" || n=$((n+1)); done; echo $n)" "0"
check "every role is read-only" \
  "$(grep -l 'sandbox_mode = "read-only"' "$RHOME"/agents/*.toml | wc -l | tr -d ' ')" "4"
check "no key Codex would reject (one unknown key voids the whole file)" \
  "$(grep -h '^[a-z_]* = ' "$RHOME"/agents/*.toml | cut -d' ' -f1 | sort -u \
     | grep -cvE '^(name|description|developer_instructions|sandbox_mode|model)$')" "0"
check "no model pinned when the override env is unset" \
  "$(grep -c '^model = ' "$RHOME"/agents/*.toml | grep -cv ':0$')" "0"

# Idempotency, the installer's promise: three writes, one file per lens, same bytes,
# and no backup churn from rewriting a file that was already correct.
cp "$RHOME/agents/leopold-lens-correctness.toml" "$TD/role-once.toml"
for _ in 2 3; do leo_write_codex_agent_roles "$RHOME" "${LENS_SPECS[@]}" >/dev/null; done
check "the 3rd write changed nothing" "${LEO_ROLES_WRITTEN:-x}" "0"
check "still four role files after three writes" "$(ls -1 "$RHOME"/agents/*.toml | wc -l | tr -d ' ')" "4"
check "and the bytes are unchanged" \
  "$(cmp -s "$TD/role-once.toml" "$RHOME/agents/leopold-lens-correctness.toml" && echo same || echo changed)" "same"
check "no backup was left by a no-op write" "$(set -- "$RHOME"/agents/*.bak; [ -e "$1" ] && echo $# || echo 0)" "0"

# A file that DID change is replaced, and what was there is one cp away.
printf 'name = "hand-edited"\n' > "$RHOME/agents/leopold-lens-security.toml"
leo_write_codex_agent_roles "$RHOME" "${LENS_SPECS[@]}" >/dev/null
check "a drifted role file is rewritten" "${LEO_ROLES_WRITTEN:-x}" "1"
check "and the previous content is backed up" \
  "$(grep -c 'hand-edited' "$RHOME/agents/leopold-lens-security.toml.leopold.bak")" "1"
check "the rewritten file is the lens again" \
  "$(sed -n 's/^name = "\(.*\)"$/\1/p' "$RHOME/agents/leopold-lens-security.toml")" "leopold-lens-security"

# The per-role model: whatever LEOPOLD_CODEX_REVIEW_MODEL holds at install time.
MHOME="$TD/roles-model"
LEOPOLD_CODEX_REVIEW_MODEL="gpt-5.6-sol" leo_write_codex_agent_roles "$MHOME" "${LENS_SPECS[@]}" >/dev/null
check "the override env sets the role's model" \
  "$(grep -h '^model = ' "$MHOME"/agents/*.toml | sort -u)" 'model = "gpt-5.6-sol"'
check "and every lens got it" "$(grep -l '^model = ' "$MHOME"/agents/*.toml | wc -l | tr -d ' ')" "4"

# A model name with a quote in it must not be able to end the TOML string early.
QHOME="$TD/roles-quote"
LEOPOLD_CODEX_REVIEW_MODEL='ev"il' leo_write_codex_agent_roles "$QHOME" "${LENS_SPECS[@]}" >/dev/null
check "a quote in the model name is escaped, not injected" \
  "$(toml_ok "$QHOME/agents/leopold-lens-correctness.toml" && echo yes || echo no)" "yes"

# Nothing is written for a spec with no lens name, and the writer says so.
EHOME="$TD/roles-empty"
r_out="$(leo_write_codex_agent_roles "$EHOME" "|1|X|d|f" 2>&1)"; r_rc=$?
check "a nameless lens spec is refused" "$r_rc" "1"
check "and nothing was written for it" "$(ls -1 "$EHOME/agents" 2>/dev/null | wc -l | tr -d ' ')" "0"
check "and it says so" "$(printf '%s' "$r_out" | grep -c 'no lens name')" "1"

check "the real ~/.claude gained no new entries"  "$(real_claude_fingerprint)" "$REAL_CLAUDE_BEFORE"

# an unparseable existing config must not be clobbered by the installer either
printf 'nope [ = broken\n' > "$ITD/codex/config.toml"
before="$(cat "$ITD/codex/config.toml")"
( export CODEX_HOME="$ITD/codex"; bash "$ROOT/scripts/install-codex.sh" "$ROOT" "$ITD/leo" ) >/dev/null 2>&1
check "a broken config.toml is left untouched" "$(cat "$ITD/codex/config.toml")" "$before"

echo
echo "harness.sh — project memory file"

check "Claude Code reads CLAUDE.md" "$(leo_memory_file claude)" "CLAUDE.md"
# Verified against codex-cli 0.146.0: with both files present in a project,
# `codex debug prompt-input` shows only the AGENTS.md text.
check "Codex CLI reads AGENTS.md"   "$(leo_memory_file codex)"  "AGENTS.md"
check "a codex-only box wants only AGENTS.md" "$(LEOPOLD_HARNESS=codex leo_memory_files)" "AGENTS.md"
check "a two-harness box wants both"          "$(LEOPOLD_HARNESS=all   leo_memory_files)" "CLAUDE.md AGENTS.md"

echo
echo "harness.sh — the enhancer's data dir (ONE per machine, shared by both harnesses)"

# The enhancer is a single user preference: toggling it on inside Codex must read as
# on inside Claude Code. So this resolver deliberately does NOT depend on which
# harness is being wired — only on which homes exist — and it prefers an existing
# ~/.claude install so no one gets migrated.
ED="$TD/enhdir"; mkdir -p "$ED/claude" "$ED/codex"
edir() { env -u LEOPOLD_ENHANCE_DIR -u LEOPOLD_HOME \
             CLAUDE_HOME="$ED/claude" CODEX_HOME="$ED/codex" LEOPOLD_HARNESS="${1:-auto}" \
             bash -c '. "'"$LIB"'"; leo_enhance_dir'; }
check "both homes, neither installed -> Claude's"     "$(edir all)"   "$ED/claude/enhance"
check "and the harness in play does not change it"    "$(edir codex)" "$ED/claude/enhance"
mkdir -p "$ED/codex/enhance"
check "an existing Codex install wins over an empty Claude home" "$(edir all)" "$ED/codex/enhance"
mkdir -p "$ED/claude/enhance"
check "an existing Claude install is never migrated"  "$(edir codex)" "$ED/claude/enhance"
check "LEOPOLD_HOME overrides everything" \
  "$(LEOPOLD_HOME="$TD/leopold" CLAUDE_HOME="$ED/claude" bash -c '. "'"$LIB"'"; leo_enhance_dir')" \
  "$TD/leopold/enhance"
check "LEOPOLD_ENHANCE_DIR wins over that" \
  "$(LEOPOLD_ENHANCE_DIR=/x/e LEOPOLD_HOME="$TD/leopold" bash -c '. "'"$LIB"'"; leo_enhance_dir')" "/x/e"
# The engine resolves the same dir at hook time; if the two ever drift, the installer
# vendors the engine into one dir and the wired hook reads another.
engine_edir() { env -u LEOPOLD_ENHANCE_DIR -u LEOPOLD_HOME CLAUDE_HOME="$1" CODEX_HOME="$2" \
                    python3 - "$ROOT/extensions/enhance/payload/enhance.py" <<'PY'
import importlib.util, sys
spec = importlib.util.spec_from_file_location("enhance_engine", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)      # main() only runs under __main__, so this is inert
print(mod.ENHANCE_DIR)
PY
}
check "the engine agrees with the shell helper (Claude present)" \
  "$(engine_edir "$ED/claude" "$ED/codex")" "$(edir all)"
check "the engine agrees on a Codex-only box" \
  "$(engine_edir "$TD/no-claude" "$ED/codex")" \
  "$(env -u LEOPOLD_ENHANCE_DIR -u LEOPOLD_HOME CLAUDE_HOME="$TD/no-claude" CODEX_HOME="$ED/codex" bash -c '. "'"$LIB"'"; leo_enhance_dir')"

echo
echo "harness.sh — project permissions / trust"

PTD="$TD/perm"; mkdir -p "$PTD/proj" "$PTD/codex"
PCFG="$PTD/codex/config.toml"
printf 'model = "gpt-5"\n' > "$PCFG"
for _ in 1 2 3; do leo_trust_project_toml "$PCFG" "$PTD/proj" >/dev/null 2>&1; done
check "config.toml parses after 3 trust writes" "$(toml_ok "$PCFG" && echo yes || echo no)" "yes"
check "exactly one projects entry"              "$(grep -c "^\[projects\.\"$PTD/proj\"\]$" "$PCFG")" "1"
check "trust_level is trusted"                  "$(python3 -c 'import tomllib,sys;print(tomllib.load(open(sys.argv[1],"rb"))["projects"][sys.argv[2]]["trust_level"])' "$PCFG" "$PTD/proj")" "trusted"
check "the user's own config key survived"      "$(python3 -c 'import tomllib,sys;print(tomllib.load(open(sys.argv[1],"rb"))["model"])' "$PCFG")" "gpt-5"

# a trust level the user already chose is never overwritten
printf 'model = "gpt-5"\n\n[projects."%s"]\ntrust_level = "untrusted"\n' "$PTD/proj" > "$PCFG"
leo_trust_project_toml "$PCFG" "$PTD/proj" >/dev/null 2>&1
check "an existing trust_level is left alone" "$(python3 -c 'import tomllib,sys;print(tomllib.load(open(sys.argv[1],"rb"))["projects"][sys.argv[2]]["trust_level"])' "$PCFG" "$PTD/proj")" "untrusted"

# Regression: NO python3 on the machine (macOS without the Xcode CLT ships none).
# Both the trust reader and the TOML validator go quiet there, so idempotency has to
# hold on text alone — otherwise the second `leopold up` in a project appends a second
# [projects."<path>"] table, TOML forbids declaring a table twice, and Codex can no
# longer parse its own config with no rollback to save it.
NOPY="$TD/nopy/bin"; mkdir -p "$NOPY"
for _t in grep sed awk cp mv rm mkdir dirname basename cat ls mktemp env bash sort cksum timeout; do
  _p="$(command -v "$_t" 2>/dev/null)" && ln -sf "$_p" "$NOPY/$_t"
done
NPCFG="$TD/nopy/config.toml"
printf 'model = "gpt-5"\n' > "$NPCFG"
nopy_out="$( PATH="$NOPY" bash -c '
  . "$1"
  leo_trust_project_toml "$2" "$3"
  leo_trust_project_toml "$2" "$3"
  command -v python3 >/dev/null 2>&1 && echo "PYTHON-STILL-ON-PATH"
' _ "$LIB" "$NPCFG" "$PTD/proj" 2>&1 )"
check "the no-python3 test really had no python3" "$(printf '%s' "$nopy_out" | grep -c 'PYTHON-STILL-ON-PATH')" "0"
check "no python3: exactly one projects table after 2 writes" \
  "$(grep -c "^\[projects\.\"$PTD/proj\"\]$" "$NPCFG")" "1"
check "no python3: the config still parses as TOML" "$(toml_ok "$NPCFG" && echo yes || echo no)" "yes"
check "no python3: trust_level was still written" \
  "$(python3 -c 'import tomllib,sys;print(tomllib.load(open(sys.argv[1],"rb"))["projects"][sys.argv[2]]["trust_level"])' "$NPCFG" "$PTD/proj")" "trusted"
if printf '%s' "$nopy_out" | grep -q 'without a TOML syntax check'; then
  ok "no python3: the skipped validation is stated, not silent"
else bad "no python3: nothing said about the skipped TOML validation"; fi

# An entry that exists with NO trust_level must not be duplicated either — appending
# under it would declare the same table twice just the same.
printf 'model = "gpt-5"\n\n[projects."%s"]\napproved = true\n' "$PTD/proj" > "$PCFG"
leo_trust_project_toml "$PCFG" "$PTD/proj" >/dev/null 2>&1
check "a headerless-trust entry is not duplicated" "$(grep -c "^\[projects\.\"$PTD/proj\"\]$" "$PCFG")" "1"
check "and the config still parses" "$(toml_ok "$PCFG" && echo yes || echo no)" "yes"

# an unparseable config is refused, not clobbered
printf 'nope [ = broken\n' > "$PCFG"
before="$(cat "$PCFG")"
( leo_trust_project_toml "$PCFG" "$PTD/proj" ) >/dev/null 2>&1; rc=$?
check "a broken config.toml -> non-zero exit"      "$rc" "1"
check "a broken config.toml is left untouched"     "$(cat "$PCFG")" "$before"

# the Claude side: merge into the project's settings.json, never clobber
printf '{"permissions":{"allow":["Bash(mycmd:*)"]}}\n' > /dev/null
mkdir -p "$PTD/proj/.claude"
printf '{"permissions":{"allow":["Bash(mycmd:*)"]}}\n' > "$PTD/proj/.claude/settings.json"
for _ in 1 2 3; do leo_seed_permissions_json "$PTD/proj" >/dev/null 2>&1; done
check "project settings.json still parses"   "$(jq -e . "$PTD/proj/.claude/settings.json" >/dev/null 2>&1 && echo yes || echo no)" "yes"
check "the user's own rule survived"         "$(jq '[.permissions.allow[] | select(. == "Bash(mycmd:*)")] | length' "$PTD/proj/.claude/settings.json")" "1"
check "seeded rules are not duplicated"      "$(jq '[.permissions.allow[] | select(. == "Read(*)")] | length' "$PTD/proj/.claude/settings.json")" "1"

# the dispatcher on a codex-only box touches config.toml and NOT .claude/
DTD2="$TD/dispatch2"; mkdir -p "$DTD2/proj" "$DTD2/codex"
( export CODEX_HOME="$DTD2/codex" CLAUDE_HOME="$DTD2/nope" LEOPOLD_HARNESS=codex
  leo_seed_project_permissions "$DTD2/proj" ) >/dev/null 2>&1
check "codex-only: project trusted in config.toml" "$(grep -c "^\[projects\.\"$DTD2/proj\"\]$" "$DTD2/codex/config.toml")" "1"
check "codex-only: no .claude/ created in the project" "$( [ -e "$DTD2/proj/.claude" ] && echo yes || echo no )" "no"

echo
echo "leopold-menu.sh / leopold-up.sh — Codex-only temp layout"

# A real Codex-only install layout: no ~/.claude anywhere, assets under
# <codex home>/leopold, and the scripts run from THERE (not from the repo), so the
# registry has to be found the way a Codex-only user's copy would find it.
MTD="$TD/menu"; mkdir -p "$MTD/codex/leopold" "$MTD/proj"
cp -R "$ROOT/extensions" "$ROOT/scripts" "$MTD/codex/leopold/"
# Bounded: the menu must draw and exit, never hang on a slow extension status probe.
menu_start="$(date +%s)"
menu_out="$( cd "$MTD/proj" && env -u LEOPOLD_HOME CLAUDE_HOME="$MTD/no-such-claude" CODEX_HOME="$MTD/codex" \
             LEOPOLD_HARNESS=codex LEOPOLD_MENU_STATUS_TIMEOUT=3 \
             timeout 60 bash "$MTD/codex/leopold/scripts/leopold-menu.sh" </dev/null 2>&1 || true )"
check "the menu drew and exited within 60s" "$( [ $(( $(date +%s) - menu_start )) -lt 60 ] && echo yes || echo no )" "yes"
check "menu finds its registry without ~/.claude" \
  "$(printf '%s' "$menu_out" | grep -c 'No extensions registry found')" "0"
for _ext in serena enhance ovmem gstack; do
  title="$(jq -r '.title // empty' "$ROOT/extensions/$_ext/extension.json")"; [ -n "$title" ] || title="$_ext"
  if printf '%s' "$menu_out" | grep -qi -- "$title"; then ok "menu lists $_ext"; else bad "menu does not list $_ext"; fi
done
# The header line: "<labels> · <registry path>". Anchored on the registry path so an
# extension that also names the harness in its own status line (serena reports per
# harness now) does not turn this into a counting exercise.
check "menu names the harness it is managing" \
  "$(printf '%s' "$menu_out" | grep -c "Codex CLI · $MTD/codex/leopold/extensions")" "1"

# leopold up, end to end, on the same Codex-only layout: it must run to completion
# and point at AGENTS.md — naming CLAUDE.md here would send the user to a file Codex
# does not read.
up_out="$( cd "$MTD/proj" && env -u LEOPOLD_HOME CLAUDE_HOME="$MTD/no-such-claude" CODEX_HOME="$MTD/codex" \
           LEOPOLD_HOME="$MTD/codex/leopold" LEOPOLD_PROJECT="$MTD/proj" LEOPOLD_NONINTERACTIVE=1 \
           bash "$ROOT/scripts/leopold-up.sh" --harness codex </dev/null 2>&1 )"; up_rc=$?
check "leopold up ran to completion on a Codex-only box" "$up_rc" "0"
if printf '%s' "$up_out" | grep -q 'AGENTS.md'; then ok "leopold up names AGENTS.md as the memory target"; else bad "leopold up never mentions AGENTS.md"; fi
if printf '%s' "$up_out" | grep -q 'CLAUDE.md'; then bad "leopold up still points at CLAUDE.md on a Codex-only box"; else ok "leopold up does not point at CLAUDE.md"; fi
check "leopold up trusted the project for Codex" "$(grep -c "^\[projects\.\"$MTD/proj\"\]$" "$MTD/codex/config.toml")" "1"
check "leopold up created no .claude/ in the project" "$( [ -e "$MTD/proj/.claude" ] && echo yes || echo no )" "no"
check "leopold up installed the Codex skills" "$( [ -f "$MTD/codex/skills/leopold-run/SKILL.md" ] && echo yes || echo no )" "yes"
# the trust writer must not reuse the hook writer's backup name — `leopold up` runs
# both, and one backup overwriting the other loses the pre-install config
check "hook backup kept"  "$( [ -f "$MTD/codex/config.toml.leopold.bak" ] && echo yes || echo no )" "yes"
check "trust backup separate" "$( [ -f "$MTD/codex/config.toml.leopold-trust.bak" ] && echo yes || echo no )" "yes"
check "the real ~/.codex still gained no new entries"  "$(real_home_fingerprint)" "$REAL_BEFORE"
check "the real ~/.claude still gained no new entries" "$(real_claude_fingerprint)" "$REAL_CLAUDE_BEFORE"

echo
echo "leopold-menu.sh — uninstall targets the REAL asset home, and keeps DATA"

# Regression: the menu used to re-derive the asset home from the environment
# (leo_asset_home), which answers ~/.claude/leopold on any box that merely HAS a
# ~/.claude — while an `install.sh --harness codex` install actually lives under
# ~/.codex/leopold and that choice is persisted nowhere. Result: rm -rf on a path that
# does not exist, "removed the asset home ~/.claude/leopold" printed, and the whole real
# install left on disk. The home now comes from the resolved registry (this script ships
# inside the asset home), so the uninstall deletes what is actually there.
UTD="$TD/uninstall"; mkdir -p "$UTD/claude" "$UTD/codex/leopold" "$UTD/codex/skills/leopold-run" "$UTD/codex/enhance"
cp -R "$ROOT/extensions" "$ROOT/scripts" "$ROOT/hooks" "$UTD/codex/leopold/"
cp "$ROOT/VERSION" "$UTD/codex/leopold/"
echo '{"x":1}' > "$UTD/codex/enhance/ledger.jsonl"
printf 'model = "gpt-5"\n\n# >>> leopold (managed) >>>\n[[hooks.Stop]]\n# <<< leopold (managed) <<<\n' > "$UTD/codex/config.toml"
# ~/.claude EXISTS here (so leo_asset_home would wrongly say <claude>/leopold), the real
# assets are under <codex>/leopold. Drive the menu: u -> 1 (core) -> confirm -> confirm -> q.
printf 'u\n1\ny\ny\n\nq\n' > "$TD/uninstall-core.in"
un_out="$( cd "$UTD" && env -u LEOPOLD_HOME CLAUDE_HOME="$UTD/claude" CODEX_HOME="$UTD/codex" \
           LEOPOLD_HARNESS=auto LEOPOLD_MENU_STATUS_TIMEOUT=3 \
           timeout 120 bash "$UTD/codex/leopold/scripts/leopold-menu.sh" < "$TD/uninstall-core.in" 2>&1 || true )"
check "uninstall removed the REAL asset home" "$( [ -d "$UTD/codex/leopold" ] && echo yes || echo no )" "no"
check "uninstall removed the Codex skills"    "$( [ -d "$UTD/codex/skills/leopold-run" ] && echo yes || echo no )" "no"
if printf '%s' "$un_out" | grep -q "removed the asset home $UTD/codex/leopold"; then
  ok "uninstall names the codex asset home it actually removed"
else bad "uninstall did not report removing $UTD/codex/leopold"; fi
if printf '%s' "$un_out" | grep -q "$UTD/claude/leopold"; then
  bad "uninstall still talks about the ~/.claude asset home that was never installed"
else ok "uninstall never mentions the phantom ~/.claude asset home"; fi
# DATA promise: core removal keeps the enhance ledger, and says so.
check "core uninstall KEPT the enhance ledger (data)" \
  "$( [ -f "$UTD/codex/enhance/ledger.jsonl" ] && echo yes || echo no )" "yes"
if printf '%s' "$un_out" | grep -q "kept your enhance data"; then
  ok "core uninstall discloses that the enhance data was kept"
else bad "core uninstall says nothing about the enhance data"; fi

# Safety: run from a source CHECKOUT, the parent of extensions/ is the repo — the menu
# must NOT treat that as an asset home to rm -rf.
STD="$TD/checkout"; mkdir -p "$STD/repo"
cp -R "$ROOT/extensions" "$ROOT/scripts" "$ROOT/hooks" "$ROOT/skills" "$STD/repo/"
cp "$ROOT/VERSION" "$ROOT/install.sh" "$STD/repo/"
sc_out="$( cd "$STD/repo" && env -u LEOPOLD_HOME CLAUDE_HOME="$STD/claude" CODEX_HOME="$STD/codex" \
           LEOPOLD_HARNESS=codex LEOPOLD_MENU_STATUS_TIMEOUT=3 \
           timeout 120 bash "$STD/repo/scripts/leopold-menu.sh" < "$TD/uninstall-core.in" 2>&1 || true )"
check "a checkout is never treated as the asset home" "$( [ -f "$STD/repo/install.sh" ] && echo yes || echo no )" "yes"
check "the checkout's extensions/ survived the uninstall" "$( [ -d "$STD/repo/extensions" ] && echo yes || echo no )" "yes"
if printf '%s' "$sc_out" | grep -q "no asset home at"; then
  ok "uninstall from a checkout says there is no asset home instead of claiming a removal"
else bad "uninstall from a checkout did not report the missing asset home honestly"; fi
check "the real ~/.codex survived the uninstall tests"  "$(real_home_fingerprint)" "$REAL_BEFORE"
check "the real ~/.claude survived the uninstall tests" "$(real_claude_fingerprint)" "$REAL_CLAUDE_BEFORE"

echo
echo "leopold-up.sh — a copy without install.sh still completes"

# The asset home gets scripts/ but NOT install.sh, so a user running the installed copy
# directly must still get permissions + next steps, with the missing installer stated.
NTD="$TD/noinstaller"; mkdir -p "$NTD/codex/leopold" "$NTD/proj"
cp -R "$ROOT/extensions" "$ROOT/scripts" "$NTD/codex/leopold/"
nup_out="$( cd "$NTD/proj" && env -u LEOPOLD_HOME CLAUDE_HOME="$NTD/no-such-claude" CODEX_HOME="$NTD/codex" \
            LEOPOLD_SRC="$NTD/no-such-src" LEOPOLD_PROJECT="$NTD/proj" LEOPOLD_NONINTERACTIVE=1 \
            bash "$NTD/codex/leopold/scripts/leopold-up.sh" --harness codex </dev/null 2>&1 )"; nup_rc=$?
check "leopold up completes without an installer next to it" "$nup_rc" "0"
if printf '%s' "$nup_out" | grep -q "skipping the harness install"; then
  ok "leopold up says the harness install was skipped"
else bad "leopold up silently skipped the harness install"; fi
check "leopold up still trusted the project" "$(grep -c "^\[projects\.\"$NTD/proj\"\]$" "$NTD/codex/config.toml")" "1"

echo
echo "leopold-up.sh — the Claude-only path is unchanged"

# The regression that matters most: a Claude-only user must see exactly what they
# saw before — CLAUDE.md, a merged .claude/settings.json allowlist, and nothing
# reaching for a Codex file.
CTD="$TD/claude-only"; mkdir -p "$CTD/claude" "$CTD/proj"
cup_out="$( cd "$CTD/proj" && env -u LEOPOLD_HOME CLAUDE_HOME="$CTD/claude" CODEX_HOME="$CTD/no-such-codex" \
            LEOPOLD_HOME="$CTD/claude/leopold" LEOPOLD_PROJECT="$CTD/proj" LEOPOLD_NONINTERACTIVE=1 \
            bash "$ROOT/scripts/leopold-up.sh" --harness claude </dev/null 2>&1 )"; cup_rc=$?
check "leopold up ran to completion on a Claude-only box" "$cup_rc" "0"
if printf '%s' "$cup_out" | grep -q 'CLAUDE.md'; then ok "leopold up names CLAUDE.md as the memory target"; else bad "leopold up never mentions CLAUDE.md"; fi
if printf '%s' "$cup_out" | grep -q 'AGENTS.md'; then bad "leopold up mentions AGENTS.md on a Claude-only box"; else ok "leopold up does not mention AGENTS.md"; fi
check "leopold up seeded the project allowlist" \
  "$(jq '[.permissions.allow[] | select(. == "Read(*)")] | length' "$CTD/proj/.claude/settings.json" 2>/dev/null)" "1"
check "leopold up wrote no Codex config" "$( [ -e "$CTD/no-such-codex/config.toml" ] && echo yes || echo no )" "no"
check "the real ~/.codex survived the Claude path"  "$(real_home_fingerprint)" "$REAL_BEFORE"
check "the real ~/.claude survived the Claude path" "$(real_claude_fingerprint)" "$REAL_CLAUDE_BEFORE"

echo
echo "harness.sh — persona guard wire/unwire (active-run wiring, both formats)"

# The persona conductor wires the guard at run start and unwires it at run end.
# What that pair must guarantee: idempotent wiring, complete removal, and no
# collateral damage to the git-lock guard living in the same files.
GTD="$TD/persona-guard"; mkdir -p "$GTD/claude" "$GTD/codex"
( export CLAUDE_HOME="$GTD/claude" CODEX_HOME="$GTD/codex" LEOPOLD_HARNESS=all
  leo_wire_hooks leopold "PreToolUse|Bash|bash /x/guard-irreversible.sh|5" >/dev/null 2>&1
  for _ in 1 2 3; do leo_wire_persona_guard "/x/persona-guard.sh" >/dev/null 2>&1; done )
GSET="$GTD/claude/settings.json"; GCFG="$GTD/codex/config.toml"
check "claude: exactly one persona-guard entry after 3 wires" \
  "$(jq '[.hooks.PreToolUse[].hooks[] | select(.command | test("persona-guard"))] | length' "$GSET")" "1"
# The matcher must route BOTH navigation surfaces the hook judges — MCP tools
# AND WebFetch. A matcher of bare "mcp__.*" here would mean the hook's WebFetch
# branch is reachable by no production wiring: regression-pinned on both formats.
check "claude: the persona matcher routes MCP tools AND WebFetch" \
  "$(jq -r '.hooks.PreToolUse[] | select(.hooks[0].command | test("persona-guard")) | .matcher' "$GSET")" "mcp__.*|WebFetch"
check "codex: the persona matcher routes MCP tools AND WebFetch" \
  "$(grep -cF 'matcher = "mcp__.*|WebFetch"' "$GCFG")" "1"
check "codex: exactly one persona-guard entry after 3 wires" \
  "$(grep -c '^command = "bash /x/persona-guard.sh"$' "$GCFG")" "1"
check "codex: the persona block is its own managed tag" \
  "$(grep -c '^# >>> leopold:leopold-persona-guard (managed) >>>$' "$GCFG")" "1"
check "codex: config still parses with both guards" "$(toml_ok "$GCFG" && echo yes || echo no)" "yes"
( export CLAUDE_HOME="$GTD/claude" CODEX_HOME="$GTD/codex" LEOPOLD_HARNESS=all
  leo_unwire_persona_guard >/dev/null 2>&1 )
check "claude: unwire removes the persona guard" \
  "$(jq '[.hooks.PreToolUse[]?.hooks[]? | select(.command | test("persona-guard"))] | length' "$GSET")" "0"
check "claude: unwire leaves the git lock alone" \
  "$(jq '[.hooks.PreToolUse[]?.hooks[]? | select(.command | test("guard-irreversible"))] | length' "$GSET")" "1"
check "codex: unwire removes the persona block" \
  "$(grep -c 'persona-guard' "$GCFG")" "0"
check "codex: unwire leaves the git lock alone" \
  "$(grep -c '^command = "bash /x/guard-irreversible.sh"$' "$GCFG")" "1"
check "codex: config still parses after unwire" "$(toml_ok "$GCFG" && echo yes || echo no)" "yes"
# The whole point: wire -> unwire -> wire must land in the same wired state.
( export CLAUDE_HOME="$GTD/claude" CODEX_HOME="$GTD/codex" LEOPOLD_HARNESS=all
  leo_wire_persona_guard "/x/persona-guard.sh" >/dev/null 2>&1 )
check "re-wiring after unwire works (claude)" \
  "$(jq '[.hooks.PreToolUse[].hooks[] | select(.command | test("persona-guard"))] | length' "$GSET")" "1"
check "re-wiring after unwire works (codex)" \
  "$(grep -c '^command = "bash /x/persona-guard.sh"$' "$GCFG")" "1"

echo
echo "harness.sh — leo_core_hook_specs (the one list both installers read)"

CORE="$(leo_core_hook_specs /X/leopold)"
check "eighteen core specs today"   "$(printf '%s\n' "$CORE" | wc -l | tr -d ' ')" "18"
check "the Stop hook is first"      "$(printf '%s\n' "$CORE" | sed -n 1p)" "Stop||/X/leopold/hooks/stop-continuity.sh|15"
check "the git lock is second"      "$(printf '%s\n' "$CORE" | sed -n 2p)" "PreToolUse|Bash|Edit|Write|MultiEdit|NotebookEdit|/X/leopold/hooks/guard-irreversible.sh|5"
# No matcher on purpose: the policy answers for every tool and defers the git half to
# the guard, so a tool-name matcher here would be a second place to keep git rules.
check "the permission policy is third" "$(printf '%s\n' "$CORE" | sed -n 3p)" "PermissionRequest||/X/leopold/hooks/permission-policy.sh|5"
# ONE script on TWO events: the compaction checkpoint branches on hook_event_name, so
# both compaction specs must name the same file (a second script would be a second
# copy of the checkpoint contract).
check "the compaction checkpoint is fourth" "$(printf '%s\n' "$CORE" | sed -n 4p)" "PreCompact||/X/leopold/hooks/compact-checkpoint.sh|10"
check "...and fifth, the same script"       "$(printf '%s\n' "$CORE" | sed -n 5p)" "PostCompact||/X/leopold/hooks/compact-checkpoint.sh|10"
# The first spec the matrix refuses on a harness. It is in the ONE list all the same —
# the gate drops it for Codex by name (the section above), and a second list is how a
# hook ends up wired by one installer and not the other.
check "the API-error stop is sixth"         "$(printf '%s\n' "$CORE" | sed -n 6p)" "StopFailure||/X/leopold/hooks/stop-failure.sh|15"
# The subagent ledger: ONE script on TWO events again (it branches on hook_event_name,
# which both harnesses send), so both specs must name the same file — a second script
# would be a second copy of one ledger. Wired at 10s, not 5, because it counts under the
# state lock; the floor below derives that from hooks/_lib.sh rather than trusting this.
check "the subagent ledger is seventh"      "$(printf '%s\n' "$CORE" | sed -n 7p)" "SubagentStart||/X/leopold/hooks/subagent-account.sh|10"
check "...and eighth, the same script"      "$(printf '%s\n' "$CORE" | sed -n 8p)" "SubagentStop||/X/leopold/hooks/subagent-account.sh|10"
# The subagent cap is a SECOND PreToolUse entry beside the git lock, never folded into it:
# guard-irreversible.sh denies two git commands and nothing else. Its matcher is the union
# of both harnesses' spawn tools and the hook re-checks tool_name itself.
check "the subagent cap is ninth"           "$(printf '%s\n' "$CORE" | sed -n 9p)" "PreToolUse|Agent|Task|collaborationspawn_agent|/X/leopold/hooks/subagent-cap.sh|5"
# The verification receipts: the THIRD script wired twice, and for a reason the capture
# forced — MOST non-zero Bash exits do not reach PostToolUse on Claude Code, they fire
# PostToolUseFailure instead, so the two events are the two halves of one receipt. (The
# ones that DO reach it are not passes either; the hook reads the response object's
# denials, which is its business and not the wiring's.) Codex
# has no PostToolUseFailure (the matrix refuses it there by name, like StopFailure) and
# its PostToolUse is a `substitute`. Same matcher on both specs, 10s because the receipt
# is appended under the state lock (the floor below derives that).
check "the receipt hook is tenth"           "$(printf '%s\n' "$CORE" | sed -n 10p)" "PostToolUse|Bash|Edit|Write|MultiEdit|NotebookEdit|apply_patch|/X/leopold/hooks/verify-receipt.sh|10"
check "...and eleventh, the same script"    "$(printf '%s\n' "$CORE" | sed -n 11p)" "PostToolUseFailure|Bash|Edit|Write|MultiEdit|NotebookEdit|apply_patch|/X/leopold/hooks/verify-receipt.sh|10"
# The evidence GATE: the fourth script wired twice, and the first whose two events answer
# in different SHAPES (a PreToolUse deny, a TaskCompleted exit 2) — so both specs naming
# the same file is the contract, not a coincidence. Its PreToolUse matcher is the EDIT
# tools only: the one claim of done it reads is an edit of PLAN.md, so Bash and
# NotebookEdit are not its business. TaskCompleted is the third spec the matrix refuses on
# a harness (Codex has no task events; the PLAN.md half carries the bound). Wired at 5,
# not 10: the gate READS state and never takes the state lock.
check "the evidence gate is twelfth"        "$(printf '%s\n' "$CORE" | sed -n 12p)" "PreToolUse|Edit|Write|MultiEdit|apply_patch|/X/leopold/hooks/done-gate.sh|5"
check "...and thirteenth, the same script"  "$(printf '%s\n' "$CORE" | sed -n 13p)" "TaskCompleted||/X/leopold/hooks/done-gate.sh|5"
# The second-writer detector: ONE script on FOUR entries of ONE event, and that is the
# wiring the live probe forced. `FileChanged`'s matcher is a LITERAL FILE NAME: an
# alternation fired 0 times, basenames alone fired 0 times, paths alone fired 0 times, and
# path-shaped PLUS basename-shaped fired for every change (the table is in
# hooks/file-watch.sh). The path-shaped entry registers the watch, the basename-shaped one
# receives it, so each watched file needs both. Wired at 10, not 5: the detector writes no
# state, but it takes .leopold/.state.lock so its own de-duplication of the harness's two
# deliveries is atomic, and every lock-taking hook is held to the floor derived below.
# `.leopold/state.json` is deliberately not among them (.leopold/
# DECISIONS.md): the run's own hooks rewrite it every turn with nothing to correlate
# against, and its second-writer bound is the ownership gate, which is code.
check "the plan watch registers fourteenth" "$(printf '%s\n' "$CORE" | sed -n 14p)" "FileChanged|.leopold/PLAN.md|/X/leopold/hooks/file-watch.sh|10"
check "...and receives fifteenth, same script" "$(printf '%s\n' "$CORE" | sed -n 15p)" "FileChanged|PLAN.md|/X/leopold/hooks/file-watch.sh|10"
check "the decisions watch registers sixteenth" "$(printf '%s\n' "$CORE" | sed -n 16p)" "FileChanged|.leopold/DECISIONS.md|/X/leopold/hooks/file-watch.sh|10"
check "...and receives seventeenth, same script" "$(printf '%s\n' "$CORE" | sed -n 17p)" "FileChanged|DECISIONS.md|/X/leopold/hooks/file-watch.sh|10"
# The config tamper guard takes no matcher: no tool is named in a ConfigChange payload,
# and the layer it dispatches on (`source`) is read from the payload, not matched here.
check "the config guard is eighteenth"      "$(printf '%s\n' "$CORE" | sed -n 18p)" "ConfigChange||/X/leopold/hooks/config-guard.sh|5"
check "every spec parses back: events" \
  "$(printf '%s\n' "$CORE" | while IFS= read -r s; do _leo_spec_field "$s" 1; echo; done | paste -sd, -)" "Stop,PreToolUse,PermissionRequest,PreCompact,PostCompact,StopFailure,SubagentStart,SubagentStop,PreToolUse,PostToolUse,PostToolUseFailure,PreToolUse,TaskCompleted,FileChanged,FileChanged,FileChanged,FileChanged,ConfigChange"
check "every spec parses back: the alternation matcher survives extraction" \
  "$(_leo_spec_field "$(printf '%s\n' "$CORE" | sed -n 2p)" 2)" "Bash|Edit|Write|MultiEdit|NotebookEdit"
check "...including the spawn-tool alternation of the cap" \
  "$(_leo_spec_field "$(printf '%s\n' "$CORE" | sed -n 9p)" 2)" "Agent|Task|collaborationspawn_agent"
check "...and the edit-tool alternation of the receipts (Codex's apply_patch included)" \
  "$(_leo_spec_field "$(printf '%s\n' "$CORE" | sed -n 10p)" 2)" "Bash|Edit|Write|MultiEdit|NotebookEdit|apply_patch"
check "...and the edit-only alternation of the evidence gate" \
  "$(_leo_spec_field "$(printf '%s\n' "$CORE" | sed -n 12p)" 2)" "Edit|Write|MultiEdit|apply_patch"
check "every spec parses back: commands" \
  "$(printf '%s\n' "$CORE" | while IFS= read -r s; do basename "$(_leo_spec_field "$s" 3)"; done | paste -sd, -)" \
  "stop-continuity.sh,guard-irreversible.sh,permission-policy.sh,compact-checkpoint.sh,compact-checkpoint.sh,stop-failure.sh,subagent-account.sh,subagent-account.sh,subagent-cap.sh,verify-receipt.sh,verify-receipt.sh,done-gate.sh,done-gate.sh,file-watch.sh,file-watch.sh,file-watch.sh,file-watch.sh,config-guard.sh"
check "the asset home is substituted, not hardcoded" \
  "$(leo_core_hook_specs "/tmp/other home" | sed -n 1p)" "Stop||/tmp/other home/hooks/stop-continuity.sh|15"
(leo_core_hook_specs >/dev/null 2>&1)
check "it refuses to guess an asset home" "$?" "1"

echo
echo "a spec that takes the state lock is wired with room to finish waiting for it"

# A timeout is not a free number: a hook that waits ~5s for .leopold/.state.lock inside a
# 5s harness timeout is KILLED MID-WAIT. Verified before this rule existed: with another
# writer holding a fresh lock, hooks/stop-failure.sh (wired at 5) died at 5.03s with
# rc=137 — no state write, no `lock_timeout` event, no `systemMessage`, and the run left
# `active: true` forever, which is the exact failure that hook exists to end. The lock's
# own fallback ("proceed unlocked and log it") was unreachable, so the promise in
# hooks/_lib.sh was fiction. (A full wait clocks ~6.3s, not the 5s of sleeping: every
# attempt also stats the lock for the reap check. The headroom covers that, which is why
# it is part of the floor rather than a comment.)
#
# So the floor is DERIVED from the two places that own the numbers — the budget from
# hooks/_lib.sh, the declared timeout from leo_core_hook_specs — and never typed here.
# Change either side and this recomputes; wire a lock-taking hook too tight and it fails.
# shellcheck source=../hooks/_lib.sh
. "$ROOT/hooks/_lib.sh"
# An empty constant would make the floor 0 and pass everything vacuously, which is how a
# derived check quietly stops checking. So the inputs are asserted first.
check "the lock budget is a number _lib.sh actually defines (tries)" \
  "$(printf '%s' "${LEO_LOCK_TRIES:-}" | grep -cE '^[0-9]+$')" "1"
check "...and a sleep between attempts" \
  "$(printf '%s' "${LEO_LOCK_SLEEP:-}" | grep -cE '^[0-9]+(\.[0-9]+)?$')" "1"
check "...and the headroom a caller must leave beyond it" \
  "$(printf '%s' "${LEO_LOCK_HEADROOM:-}" | grep -cE '^[0-9]+$')" "1"
LOCK_FLOOR="$(awk -v t="${LEO_LOCK_TRIES:-0}" -v s="${LEO_LOCK_SLEEP:-0}" \
                  -v h="${LEO_LOCK_HEADROOM:-0}" 'BEGIN{printf "%g", t*s + h}')"
check "the floor is a positive number of seconds" \
  "$(awk -v f="$LOCK_FLOOR" 'BEGIN{print (f+0 > 0) ? 1 : 0}')" "1"
# The rule itself, over the real hooks: `lock_state` is hooks/stop-continuity.sh's own
# transcribed copy of the same loop (deliberately not moved onto the library — see
# hooks/_lib.sh), so it is held to the same arithmetic.
LOCKED=""
while IFS= read -r sp; do
  [ -n "$sp" ] || continue
  _ev="$(_leo_spec_field "$sp" 1)"; _cmd="$(_leo_spec_field "$sp" 3)"; _to="$(_leo_spec_field "$sp" 4)"
  grep -q 'leo_hook_lock\|lock_state' "$ROOT/hooks/$(basename "$_cmd")" 2>/dev/null || continue
  LOCKED="${LOCKED:+$LOCKED }$_ev"
  check "$_ev ($(basename "$_cmd")) is wired above the ${LOCK_FLOOR}s floor" \
    "$(awk -v a="$_to" -v b="$LOCK_FLOOR" 'BEGIN{print (a+0 >= b+0) ? "ok" : a "s < " b "s"}')" "ok"
done <<EOF
$(leo_core_hook_specs "$ROOT")
EOF
# ...and the loop is not vacuous: these four take the lock, and a fifth that starts to
# must appear here rather than slip through an unmatched grep.
check "every spec whose hook takes the lock was checked" "Stop PreCompact PostCompact StopFailure SubagentStart SubagentStop PostToolUse PostToolUseFailure FileChanged FileChanged FileChanged FileChanged" "$LOCKED"
# The mutation, kept in-suite: the wiring this rule was written against must fail it.
check "a lock-taking hook wired at 5s would fail the rule" \
  "$(awk -v a=5 -v b="$LOCK_FLOOR" 'BEGIN{print (a+0 >= b+0) ? "yes" : "no"}')" "no"

echo
echo "harness.sh — the capability matrix decides what each harness is wired for"

# The ten events this run's bounds ride on, asked of BOTH writers with the real
# hooks/hook-matrix.tsv in play. Claude Code fires all ten (the probe captured every
# one); Codex CLI has five of the twelve events it documents and none of these four,
# so the TOML writer must refuse them by name instead of leaving dead tables behind.
MTD="$TD/matrix"; mkdir -p "$MTD"
MSET="$MTD/settings.json"; MCFG="$MTD/config.toml"
printf '{"permissions":{"allow":["Bash(ls:*)"]}}\n' > "$MSET"
printf 'model = "gpt-5"\n' > "$MCFG"
NEW_SPECS=(
  "SubagentStart|Agent|Task|/x/subagent-account.sh|5"
  "SubagentStop||/x/subagent-account.sh|5"
  "PostToolUse|Edit|Write|MultiEdit|/x/verify-receipt.sh|5"
  "PermissionRequest||/x/permission-policy.sh|5"
  "PreCompact||/x/compact-checkpoint.sh|10"
  "PostCompact||/x/compact-resume.sh|10"
  "TaskCompleted||/x/done-gate.sh|5"
  "StopFailure||/x/stop-failure.sh|5"
  "FileChanged|PLAN.md|/x/file-watch.sh|5"
  "ConfigChange||/x/config-guard.sh|5"
)
JOUT="$(leo_wire_hooks_json "$MSET" leopold-matrix "${NEW_SPECS[@]}" 2>&1)"
TOUT="$(leo_wire_hooks_toml "$MCFG" leopold-matrix "${NEW_SPECS[@]}" 2>&1)"

json_has() { jq --arg e "$1" '[.hooks[$e][]?.hooks[]?] | length' "$MSET"; }
for ev in SubagentStart SubagentStop PostToolUse PermissionRequest PreCompact PostCompact \
          TaskCompleted StopFailure FileChanged ConfigChange; do
  check "claude: $ev is wired (the probe captured it on 2.1.259)" "$(json_has "$ev")" "1"
done
check "claude: settings.json still parses"  "$(jq -e . "$MSET" >/dev/null 2>&1 && echo yes || echo no)" "yes"
check "claude: the user's settings survived" "$(jq -r '.permissions.allow[0]' "$MSET")" "Bash(ls:*)"
check "claude: nothing was refused"          "$(printf '%s' "$JOUT" | grep -c 'not wired')" "0"
check "claude: the Agent|Task alternation survived JSON" \
  "$(jq -r '.hooks.SubagentStart[0].matcher' "$MSET")" "Agent|Task"
check "claude: the Edit|Write|MultiEdit alternation survived JSON" \
  "$(jq -r '.hooks.PostToolUse[0].matcher' "$MSET")" "Edit|Write|MultiEdit"

for ev in SubagentStart SubagentStop PostToolUse PermissionRequest PreCompact PostCompact; do
  check "codex: $ev is wired (the probe captured it on 0.152.1)" "$(toml_hook_count "$MCFG" "$ev")" "1"
done
# @scenario: a spec for an event Codex does not have lands NOWHERE and says so.
for ev in TaskCompleted StopFailure FileChanged ConfigChange; do
  check "codex: $ev lands nowhere in config.toml" "$(grep -c "^\[\[hooks\.$ev\]\]" "$MCFG")" "0"
  check "codex: $ev is refused by name, quoting the probed version" \
    "$(printf '%s\n' "$TOUT" | grep -cF "$ev: unavailable on Codex codex-cli 0.152.1 — not wired")" "1"
done
check "codex: config.toml still parses"      "$(toml_ok "$MCFG" && echo yes || echo no)" "yes"
check "codex: the user's own key survived"   "$(python3 -c 'import tomllib,sys;print(tomllib.load(open(sys.argv[1],"rb"))["model"])' "$MCFG")" "gpt-5"
check "codex: the Agent|Task alternation survived TOML" \
  "$(grep -cF 'matcher = "Agent|Task"' "$MCFG")" "1"
check "codex: the Edit|Write|MultiEdit alternation survived TOML" \
  "$(grep -cF 'matcher = "Edit|Write|MultiEdit"' "$MCFG")" "1"

# A whole list this harness cannot fire must leave the config alone — not rewrite it
# with an empty managed block, not even take a backup it did not need.
ETD="$TD/matrix-empty"; mkdir -p "$ETD"
printf 'model = "gpt-5"\n' > "$ETD/config.toml"
EOUT="$(leo_wire_hooks_toml "$ETD/config.toml" leopold-claude-only "StopFailure||/x/stop-failure.sh|5" 2>&1)"; erc=$?
check "codex: an all-Claude list exits clean" "$erc" "0"
check "codex: and leaves config.toml byte-identical" "$(cat "$ETD/config.toml")" 'model = "gpt-5"'
check "codex: and writes no managed block"    "$(grep -c 'leopold' "$ETD/config.toml")" "0"
check "codex: and still says what it refused" \
  "$(printf '%s\n' "$EOUT" | grep -cF 'StopFailure: unavailable on Codex codex-cli 0.152.1 — not wired')" "1"

# @scenario, through the dispatcher and not the writer: LEOPOLD_HARNESS=codex with a
# StopFailure spec must leave config.toml alone and say why on stdout.
DTD2="$TD/dispatch-codex"; mkdir -p "$DTD2/codex"
printf 'model = "gpt-5"\n' > "$DTD2/codex/config.toml"
DOUT="$( export CLAUDE_HOME="$DTD2/claude" CODEX_HOME="$DTD2/codex" LEOPOLD_HARNESS=codex
         leo_wire_hooks leopold-scenario "StopFailure||/x/stop-failure.sh|5" 2>&1 )"; drc=$?
check "dispatcher (LEOPOLD_HARNESS=codex): exits clean" "$drc" "0"
check "dispatcher: no [[hooks.StopFailure]] table" \
  "$(grep -c '^\[\[hooks\.StopFailure\]\]' "$DTD2/codex/config.toml")" "0"
check "dispatcher: config.toml is untouched" "$(cat "$DTD2/codex/config.toml")" 'model = "gpt-5"'
check "dispatcher: stdout carries the refusal verbatim" \
  "$(printf '%s\n' "$DOUT" | grep -cF 'StopFailure: unavailable on Codex codex-cli 0.152.1 — not wired')" "1"
check "dispatcher: and it never touched the Claude side" \
  "$( [ -e "$DTD2/claude/settings.json" ] && echo yes || echo no )" "no"

# The Claude Code writer is never gated by Codex's gaps: same list, same file.
check "claude: an all-Claude list is wired in full" \
  "$( leo_wire_hooks_json "$ETD/settings.json" leopold-claude-only "StopFailure||/x/stop-failure.sh|5" >/dev/null 2>&1
     jq '[.hooks.StopFailure[]?.hooks[]?] | length' "$ETD/settings.json" )" "1"

# No matrix -> wire everything, and SAY so. A silent fallback here would wire dead
# hooks into a Codex config with nothing in the output to explain it.
NTD="$TD/matrix-missing"; mkdir -p "$NTD"
NOUT="$( LEO_MATRIX_TSV="$NTD/there-is-no-matrix.tsv" \
         leo_wire_hooks_toml "$NTD/config.toml" leopold-nomatrix "StopFailure||/x/stop-failure.sh|5" 2>&1 )"
check "no matrix: the hook is wired unchecked" "$(toml_hook_count "$NTD/config.toml" StopFailure)" "1"
check "no matrix: and it warns loudly"         "$(printf '%s\n' "$NOUT" | grep -c 'hook-matrix.tsv not found')" "1"
check "no matrix: naming the consequence"      "$(printf '%s\n' "$NOUT" | grep -c 'UNCHECKED')" "1"
check "no matrix: nothing is refused silently" "$(printf '%s\n' "$NOUT" | grep -c 'not wired')" "0"

# An event the matrix has no opinion about (the enhancer's, Serena's, ovmem's) is
# none of its business and is wired on both, exactly as before this gate existed.
UTD="$TD/matrix-unlisted"; mkdir -p "$UTD"
leo_wire_hooks_toml "$UTD/config.toml" leopold-unlisted "UserPromptSubmit||python3 /x/enhance.py|30" >/dev/null 2>&1
leo_wire_hooks_json "$UTD/settings.json" leopold-unlisted "SessionEnd||python3 /x/ovmem.py|3" >/dev/null 2>&1
check "an event outside the matrix is wired on codex" "$(toml_hook_count "$UTD/config.toml" UserPromptSubmit)" "1"
check "an event outside the matrix is wired on claude" "$(jq '[.hooks.SessionEnd[]?.hooks[]?]|length' "$UTD/settings.json")" "1"

check "leo_matrix_version reads the probed Claude Code version" "$(leo_matrix_version claude)" \
  "$(awk -F'|' '/^\| Claude Code CLI/ {gsub(/^[ \t]*`?|`?[ \t]*$/,"",$3); print $3; exit}' "$ROOT/docs/reference/hook-events.md")"
check "leo_matrix_version reads the probed Codex CLI version" "$(leo_matrix_version codex)" \
  "$(awk -F'|' '/^\| Codex CLI/ {gsub(/^[ \t]*`?|`?[ \t]*$/,"",$3); print $3; exit}' "$ROOT/docs/reference/hook-events.md")"

echo
echo "harness.sh — the STATUS WORD decides; the anchor only splits \`substitute\`"

# A row is free to cite whatever section proves it, and several shipped rows already cite
# the shared Findings heading in their notes. A gate that read the anchor as part of the
# WIRE decision refused rows that plainly say `available`, printed them back as
# "unavailable on ...", and left the git lock and the continuity hook declared NOWHERE —
# fail-closed, on the one surface that must never lose a hook, with every suite green
# (scripts/test-hook-matrix.sh only asserts an anchor resolves to SOME heading). Reachable
# without touching a renderer: author an `available` row citing the Findings section.
#
# The matrices below are AUTHORED, so what is under test is the writer's rule and not the
# shipped tsv — scripts/test-hook-matrix.sh pins that one against the captures, including
# the coupling this rule depends on.
XTD="$TD/matrix-anchor"; mkdir -p "$XTD"
cat > "$XTD/available-elsewhere.tsv" <<'TSV'
# probed: claude "2.1.259 (Claude Code)" codex "codex-cli 0.152.1"
run-continuity	Stop	claude	available	#what-this-decides-for-leopold	authored by the test: available, evidenced from the shared Findings section
git-lock	PreToolUse	claude	available	#findings	authored by the test: available, a different heading again
run-continuity	Stop	codex	available	#what-this-decides-for-leopold	authored by the test
git-lock	PreToolUse	codex	available	#findings	authored by the test
TSV
XCORE=("Stop||/x/stop-continuity.sh|15"
       "PreToolUse|Bash|Edit|Write|MultiEdit|NotebookEdit|/x/guard-irreversible.sh|5")
XJ="$( LEO_MATRIX_TSV="$XTD/available-elsewhere.tsv" \
       leo_wire_hooks_json "$XTD/settings.json" leopold "${XCORE[@]}" 2>&1 )"
check "an 'available' row citing another section still wires the continuity hook (json)" \
  "$(jq '[.hooks.Stop[]?.hooks[]?]|length' "$XTD/settings.json")" "1"
check "and the git lock (json)" \
  "$(jq '[.hooks.PreToolUse[]?.hooks[]?]|length' "$XTD/settings.json")" "1"
check "and calls nothing unavailable (json)" "$(printf '%s\n' "$XJ" | grep -c 'not wired')" "0"
XT="$( LEO_MATRIX_TSV="$XTD/available-elsewhere.tsv" \
       leo_wire_hooks_toml "$XTD/config.toml" leopold "${XCORE[@]}" 2>&1 )"
check "an 'available' row citing another section still wires the continuity hook (toml)" \
  "$(toml_hook_count "$XTD/config.toml" Stop)" "1"
check "and the git lock (toml)" "$(toml_hook_count "$XTD/config.toml" PreToolUse)" "1"
check "and calls nothing unavailable (toml)" "$(printf '%s\n' "$XT" | grep -c 'not wired')" "0"

# The anchor's ONE job: telling the two kinds of `substitute` apart. Citing this harness's
# own captured section means the event fires here with a weaker guarantee (wire it, the
# note carries the cost); citing anything else means the event is not on this harness at
# all and the bound is carried elsewhere (wire nothing).
cat > "$XTD/substitute-split.tsv" <<'TSV'
# probed: claude "2.1.259 (Claude Code)" codex "codex-cli 0.152.1"
weaker-here	PostToolUse	codex	substitute	#posttooluse-codex-cli	authored by the test: fires here, weaker guarantee
carried-elsewhere	TaskCompleted	codex	substitute	#what-this-decides-for-leopold	authored by the test: not on this harness at all
TSV
XS="$( LEO_MATRIX_TSV="$XTD/substitute-split.tsv" \
       leo_wire_hooks_toml "$XTD/split.toml" leopold-split \
         "PostToolUse|Bash|/x/verify-receipt.sh|5" "TaskCompleted||/x/done-gate.sh|5" 2>&1 )"
check "a 'substitute' citing this harness's own section is wired" \
  "$(toml_hook_count "$XTD/split.toml" PostToolUse)" "1"
check "a 'substitute' citing another section is not" \
  "$(grep -c '^\[\[hooks\.TaskCompleted\]\]' "$XTD/split.toml")" "0"
check "and only that one is named as unwired" \
  "$(printf '%s\n' "$XS" | grep -c 'not wired')" "1"

echo
echo "harness.sh — the settings.json prune takes out the refused (event, command), and nothing else"

# The JSON prune's removal set is EVENT-scoped. A command-only sweep walks every event key
# in the file, so refusing one event would delete that script's hook from every OTHER
# event — under any tag, including a live one — and then report the refused event as the
# only thing it had touched. The bounds this run is building share PreToolUse with the git
# lock and the persona guard, so the blast radius of that is the git lock itself.
PTD2="$TD/prune-scope"; mkdir -p "$PTD2"
cat > "$PTD2/refuse.tsv" <<'TSV'
# probed: claude "2.1.259 (Claude Code)" codex "codex-cli 0.152.1"
api-error-stop	StopFailure	claude	unavailable	#what-this-decides-for-leopold	authored by the test: pretend a later Claude Code dropped it
TSV
cat > "$PTD2/settings.json" <<'JSON'
{
  "permissions": { "allow": ["Bash(ls:*)"] },
  "hooks": {
    "PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "/x/shared.sh", "timeout": 5 } ] } ],
    "StopFailure": [ { "hooks": [ { "type": "command", "command": "/x/shared.sh", "timeout": 5 } ] },
                     { "hooks": [ { "type": "command", "command": "/opt/mine/also-here.sh" } ] } ],
    "Stop": [ { "hooks": [ { "type": "command", "command": "/opt/mine/my-stop.sh" } ] } ]
  }
}
JSON
POUT2="$( LEO_MATRIX_TSV="$PTD2/refuse.tsv" \
          leo_wire_hooks_json "$PTD2/settings.json" leopold-prune "StopFailure||/x/shared.sh|5" 2>&1 )"
check "the refused (StopFailure, /x/shared.sh) hook is gone" \
  "$(jq '[.hooks.StopFailure[]?.hooks[]?|select(.command=="/x/shared.sh")]|length' "$PTD2/settings.json")" "0"
check "the SAME command on another event survives" \
  "$(jq '[.hooks.PreToolUse[]?.hooks[]?|select(.command=="/x/shared.sh")]|length' "$PTD2/settings.json")" "1"
check "with its matcher and timeout intact" \
  "$(jq -r '.hooks.PreToolUse[0] | "\(.matcher) \(.hooks[0].timeout)"' "$PTD2/settings.json")" "Bash 5"
check "another hook on the refused event survives" \
  "$(jq '[.hooks.StopFailure[]?.hooks[]?|select(.command=="/opt/mine/also-here.sh")]|length' "$PTD2/settings.json")" "1"
check "so the event key stays" "$(jq '.hooks|has("StopFailure")' "$PTD2/settings.json")" "true"
check "the user's own unrelated event survives" \
  "$(jq '[.hooks.Stop[]?.hooks[]?]|length' "$PTD2/settings.json")" "1"
check "the user's permissions survive" "$(jq -r '.permissions.allow[0]' "$PTD2/settings.json")" "Bash(ls:*)"
check "and it names the event it actually removed" \
  "$(printf '%s\n' "$POUT2" | grep -c 'removed the hooks for StopFailure from')" "1"

# ...and a refusal for a pair that is NOT in the file removes nothing and REPORTS nothing.
# Claiming a removal that did not happen is the wrong-report-that-reads-as-success half of
# the same defect: it sends a reader looking for a hook that is still exactly where it was.
cat > "$PTD2/untouched.json" <<'JSON'
{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"/x/shared.sh","timeout":5}]}]}}
JSON
UB="$(cksum < "$PTD2/untouched.json")"; UM="$(ls -l "$PTD2/untouched.json" | tr -s ' ' | cut -d' ' -f6-8)"
UOUT2="$( LEO_MATRIX_TSV="$PTD2/refuse.tsv" \
          leo_wire_hooks_json "$PTD2/untouched.json" leopold-prune "StopFailure||/x/shared.sh|5" 2>&1 )"; urc=$?
check "a refusal whose hook is not in the file leaves it byte-identical" \
  "$(cksum < "$PTD2/untouched.json")" "$UB"
check "and does not rewrite it at all" \
  "$(ls -l "$PTD2/untouched.json" | tr -s ' ' | cut -d' ' -f6-8)" "$UM"
check "and takes no backup it did not need" \
  "$( [ -e "$PTD2/untouched.json.leopold-prune.bak" ] && echo yes || echo no )" "no"
check "and claims no removal"  "$(printf '%s\n' "$UOUT2" | grep -c 'removed the hooks')" "0"
check "while still saying what it refused" \
  "$(printf '%s\n' "$UOUT2" | grep -c 'StopFailure: unavailable on Claude')" "1"
check "and exits clean" "$urc" "0"

echo
echo "harness.sh — a matrix it cannot ASK fails OPEN, never into a refusal"

# The asymmetry the whole gate rests on: only "unavailable" may drop a hook. Every
# other outcome — no file, an unreadable file, a reader that blew up — means "I could
# not ask", and the answer to that is wire it and say so. Read the other way, a single
# `chmod 000` on hook-matrix.tsv would disarm the git lock on every install, silently.
RTD="$TD/matrix-unreadable"; mkdir -p "$RTD"
cp "$ROOT/hooks/hook-matrix.tsv" "$RTD/m.tsv"
chmod 000 "$RTD/m.tsv" 2>/dev/null || true
if [ -r "$RTD/m.tsv" ]; then
  # root ignores the mode bits; the case below still covers the same branch through awk
  ok "SKIPPED (running as root: chmod 000 does not make a file unreadable here)"
else
  check "an unreadable matrix resolves to no matrix at all" \
    "$( LEO_MATRIX_TSV="$RTD/m.tsv" leo_matrix_file )" ""
  ROUT="$( LEO_MATRIX_TSV="$RTD/m.tsv" \
           leo_wire_hooks_toml "$RTD/config.toml" leopold \
             "Stop||/x/stop-continuity.sh|15" \
             "PreToolUse|Bash|Edit|Write|MultiEdit|NotebookEdit|/x/guard-irreversible.sh|5" 2>&1 )"; rrc=$?
  check "an unreadable matrix still wires the git lock" \
    "$(toml_hook_count "$RTD/config.toml" PreToolUse)" "1"
  check "and the continuity hook"          "$(toml_hook_count "$RTD/config.toml" Stop)" "1"
  check "and refuses nothing"              "$(printf '%s\n' "$ROUT" | grep -c 'not wired')" "0"
  check "and says WHY it could not check"  "$(printf '%s\n' "$ROUT" | grep -c 'cannot be read')" "1"
  check "naming the consequence"           "$(printf '%s\n' "$ROUT" | grep -c 'UNCHECKED')" "1"
  check "and exits clean"                  "$rrc" "0"
fi
chmod 644 "$RTD/m.tsv" 2>/dev/null || true

# Same rule one layer down: the file is there and readable and the READER fails. awk is
# shadowed for the matrix query only (it is the sole call carrying `-v want=`), so the
# spec parser keeps working and the gate alone sees a broken reader.
awk() { case "$*" in *want=*) return 3 ;; *) command awk "$@" ;; esac; }
ATD2="$TD/matrix-awk-broken"; mkdir -p "$ATD2"
AOUT="$( LEO_MATRIX_TSV="$ROOT/hooks/hook-matrix.tsv" \
         leo_wire_hooks_toml "$ATD2/config.toml" leopold \
           "Stop||/x/stop-continuity.sh|15" \
           "StopFailure||/x/stop-failure.sh|5" 2>&1 )"
unset -f awk
check "a reader that blows up wires the hook anyway (Stop)" "$(toml_hook_count "$ATD2/config.toml" Stop)" "1"
check "and even the one the matrix WOULD have refused" \
  "$(toml_hook_count "$ATD2/config.toml" StopFailure)" "1"
check "and says the read failed, with awk's status" \
  "$(printf '%s\n' "$AOUT" | grep -c 'awk exited 3')" "1"
check "and states the rule out loud" \
  "$(printf '%s\n' "$AOUT" | grep -c 'is not')" "1"

# The escape hatch the PROBE uses. hooks/hook-matrix.tsv is derived from the probe's
# captures, so filtering the probe by it would make the instrument self-confirming: a
# newly shipped event could never be captured, because it would never be wired, because
# no row yet says it exists.
PTD="$TD/matrix-unchecked"; mkdir -p "$PTD"
POUT="$( LEO_WIRE_UNCHECKED=1 leo_wire_hooks_toml "$PTD/config.toml" probe \
           "StopFailure||/x/dump.sh|10" "TaskCompleted||/x/dump.sh|10" 2>&1 )"
check "LEO_WIRE_UNCHECKED=1 wires an event the matrix refuses" \
  "$(toml_hook_count "$PTD/config.toml" StopFailure)" "1"
check "and the second one"        "$(toml_hook_count "$PTD/config.toml" TaskCompleted)" "1"
check "and refuses nothing"       "$(printf '%s\n' "$POUT" | grep -c 'not wired')" "0"
check "and says the gate is off"  "$(printf '%s\n' "$POUT" | grep -c 'gate OFF')" "1"

# The probe must actually take that escape, and must check what landed rather than what
# it asked for — a short wire would publish a verbatim "not fired" for an event nobody
# ever hooked, as captured evidence, into the page the matrix is derived from.
check "the probe turns the gate off" \
  "$(grep -c '^export LEO_WIRE_UNCHECKED=1$' "$ROOT/scripts/probe-hook-events.sh")" "1"
# Derived, not a magic number: EVERY leo_wire_hooks_* call in the probe must be followed
# by its own landed-count assertion. Counting them against each other means a new wire
# (the ConfigChange reload twin was the third) cannot be added without one.
check "every wire in the probe asserts what landed" \
  "$(grep -cF 'LEO_WIRED_COUNT:-0}" = "${#specs[@]}"' "$ROOT/scripts/probe-hook-events.sh")" \
  "$(grep -cE '^[[:space:]]*leo_wire_hooks_(json|toml) ' "$ROOT/scripts/probe-hook-events.sh")"

echo
echo "harness.sh — the writers report what LANDED, not what they were asked for"

# A writer can legitimately exit 0 having declared nothing (every spec refused). An
# installer that prints "git lock wired" off its own argument list is the "no-op that
# reads as success" this project bans — on its core promise. So the count comes from
# the writer.
WTD="$TD/wired-count"; mkdir -p "$WTD"
leo_wire_hooks_toml "$WTD/config.toml" leopold \
  "Stop||/x/stop.sh|15" "PreToolUse|Bash|Edit|Write|MultiEdit|NotebookEdit|/x/guard.sh|5" >/dev/null 2>&1
check "a full codex wire counts 2"        "$LEO_WIRED_COUNT" "2"
check "and names the events, in order"    "$LEO_WIRED_EVENTS" "Stop PreToolUse"
check "and refuses nothing"               "$LEO_REFUSED_EVENTS" ""
leo_wire_hooks_json "$WTD/settings.json" leopold \
  "Stop||/x/stop.sh|15" "PreToolUse|Bash|Edit|Write|MultiEdit|NotebookEdit|/x/guard.sh|5" >/dev/null 2>&1
check "a full claude wire counts 2"       "$LEO_WIRED_COUNT" "2"
check "and names the events, in order"    "$LEO_WIRED_EVENTS" "Stop PreToolUse"

leo_wire_hooks_toml "$WTD/refused.toml" leopold-refused "StopFailure||/x/f.sh|5" >/dev/null 2>&1
check "an all-refused wire counts 0"      "$LEO_WIRED_COUNT" "0"
check "and names what it refused"         "$LEO_REFUSED_EVENTS" "StopFailure"
check "and declares no events"            "$LEO_WIRED_EVENTS" ""

leo_wire_hooks_toml "$WTD/partial.toml" leopold-partial \
  "Stop||/x/stop.sh|15" "StopFailure||/x/f.sh|5" >/dev/null 2>&1
check "a partial wire counts only what landed" "$LEO_WIRED_COUNT" "1"
check "naming the one that did"                "$LEO_WIRED_EVENTS" "Stop"
check "and the one that did not"               "$LEO_REFUSED_EVENTS" "StopFailure"

# A failed write reports 0, never the arguments it was handed.
printf 'this is not json {{{\n' > "$WTD/broken.json"
leo_wire_hooks_json "$WTD/broken.json" leopold-broken "Stop||/x/stop.sh|15" >/dev/null 2>&1
check "a write that could not land counts 0"   "$LEO_WIRED_COUNT" "0"

# Through the dispatcher, the count is the SUM across harnesses and the events carry
# the harness that took them — otherwise a caller reads the last harness's numbers as
# if they were the whole install's.
DTD3="$TD/dispatch-count"; mkdir -p "$DTD3/claude" "$DTD3/codex"
( export CLAUDE_HOME="$DTD3/claude" CODEX_HOME="$DTD3/codex" LEOPOLD_HARNESS=all
  leo_wire_hooks leopold-count "Stop||/x/stop.sh|15" "StopFailure||/x/f.sh|5" >/dev/null 2>&1
  printf '%s\n%s\n%s\n' "$LEO_WIRED_COUNT" "$LEO_WIRED_EVENTS" "$LEO_REFUSED_EVENTS" ) > "$DTD3/out.txt"
check "dispatcher: 3 of the 4 asked-for hooks landed (Codex has no StopFailure)" \
  "$(sed -n 1p "$DTD3/out.txt")" "3"
check "dispatcher: the events carry their harness" \
  "$(sed -n 2p "$DTD3/out.txt")" "claude:Stop StopFailure codex:Stop"
check "dispatcher: and so does the refusal" \
  "$(sed -n 3p "$DTD3/out.txt")" "codex:StopFailure"

echo
echo "harness.sh — an event that becomes refused loses the wiring it already had"

# The upgrade case. A Leopold from before this gate (or from before a row was
# corrected) wired an event this harness cannot fire; re-running the installer has to
# take it OUT. Returning early on an all-refused list leaves exactly the dead
# [[hooks.X]] table the gate exists to prevent.
STD="$TD/stale-block"; mkdir -p "$STD"
printf 'model = "gpt-5"\n' > "$STD/config.toml"
LEO_MATRIX_TSV="$STD/no-matrix.tsv" \
  leo_wire_hooks_toml "$STD/config.toml" leopold-stale "StopFailure||/x/f.sh|5" >/dev/null 2>&1
check "pre-gate: the dead table is there to begin with" \
  "$(grep -c '^\[\[hooks\.StopFailure\]\]' "$STD/config.toml")" "1"
SOUT="$(leo_wire_hooks_toml "$STD/config.toml" leopold-stale "StopFailure||/x/f.sh|5" 2>&1)"; src=$?
check "re-wiring with the matrix in play removes it" \
  "$(grep -c '^\[\[hooks\.StopFailure\]\]' "$STD/config.toml")" "0"
check "and the managed block goes with it" "$(grep -c 'leopold:leopold-stale' "$STD/config.toml")" "0"
check "and the user's own key survives"    "$(cat "$STD/config.toml")" 'model = "gpt-5"'
check "and it says so"  "$(printf '%s\n' "$SOUT" | grep -c 'removing the managed block')" "1"
check "and exits clean" "$src" "0"
check "config.toml still parses"           "$(toml_ok "$STD/config.toml" && echo yes || echo no)" "yes"

# The JSON twin. No event is unavailable on Claude Code today, so the row is authored
# here: this tests the WRITER's rule, not the shipped matrix.
JTD="$TD/stale-json"; mkdir -p "$JTD"
cat > "$JTD/fake-matrix.tsv" <<'TSV'
# probed: claude "2.1.259 (Claude Code)" codex "codex-cli 0.152.1"
api-error-stop	StopFailure	claude	unavailable	#what-this-decides-for-leopold	authored by the test: pretend a later Claude Code dropped it
TSV
printf '{"permissions":{"allow":["Bash(ls:*)"]},"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"/opt/mine/s.sh"}]}]}}\n' > "$JTD/settings.json"
LEO_MATRIX_TSV="$JTD/no-matrix.tsv" \
  leo_wire_hooks_json "$JTD/settings.json" leopold-stale "StopFailure||/x/f.sh|5" >/dev/null 2>&1
check "pre-gate: the dead hook is there to begin with" \
  "$(jq '[.hooks.StopFailure[]?.hooks[]?]|length' "$JTD/settings.json")" "1"
JOUT2="$( LEO_MATRIX_TSV="$JTD/fake-matrix.tsv" \
          leo_wire_hooks_json "$JTD/settings.json" leopold-stale "StopFailure||/x/f.sh|5" 2>&1 )"; jrc=$?
check "re-wiring with the matrix in play removes it" \
  "$(jq '[.hooks.StopFailure[]?.hooks[]?]|length' "$JTD/settings.json")" "0"
check "and the emptied event key goes too"  "$(jq '.hooks|has("StopFailure")' "$JTD/settings.json")" "false"
check "the user's own hook survives"       "$(jq '[.hooks.SessionStart[].hooks[]|select(.command=="/opt/mine/s.sh")]|length' "$JTD/settings.json")" "1"
check "the user's permissions survive"     "$(jq -r '.permissions.allow[0]' "$JTD/settings.json")" "Bash(ls:*)"
check "and it says so"  "$(printf '%s\n' "$JOUT2" | grep -c 'removed the hooks for StopFailure')" "1"
check "and exits clean" "$jrc" "0"
check "settings.json still parses"         "$(jq -e . "$JTD/settings.json" >/dev/null 2>&1 && echo yes || echo no)" "yes"

# ...and once there is nothing left to take out, the file is not touched again — same
# bytes, same mtime, and the backup of the pre-prune state is not overwritten.
JB="$(cksum < "$JTD/settings.json")"; JM="$(ls -l "$JTD/settings.json" | tr -s ' ' | cut -d' ' -f6-8)"
LEO_MATRIX_TSV="$JTD/fake-matrix.tsv" \
  leo_wire_hooks_json "$JTD/settings.json" leopold-stale "StopFailure||/x/f.sh|5" >/dev/null 2>&1
check "a second refusal leaves the file byte-identical" "$(cksum < "$JTD/settings.json")" "$JB"
check "and does not rewrite it at all" "$(ls -l "$JTD/settings.json" | tr -s ' ' | cut -d' ' -f6-8)" "$JM"
check "so the backup still holds the pre-prune version" \
  "$(jq '[.hooks.StopFailure[]?.hooks[]?]|length' "$JTD/settings.json.leopold-stale.bak")" "1"

echo
echo "hooks/hooks.json — the plugin manifest is pinned to the core spec list"

# The plugin path (.claude-plugin / .codex-plugin -> hooks/hooks.json) declares the
# same hooks the two installers wire, and nothing but this test keeps them together:
# a hook added to leo_core_hook_specs and forgotten in the manifest ships to every
# installed user and to no plugin user.
#
# Compared on EVENT + MATCHER + the hook script's basename. The manifest spells its
# command with ${CLAUDE_PLUGIN_ROOT} and the installers with an absolute asset-home
# path, so the path cannot be compared — which script runs on which event under which
# matcher is the whole contract, and it is comparable exactly.
specs_triples() { # specs on stdin
  local sp
  while IFS= read -r sp; do
    [ -n "$sp" ] || continue
    printf '%s\t%s\t%s\n' \
      "$(_leo_spec_field "$sp" 1)" "$(_leo_spec_field "$sp" 2)" \
      "$(basename "$(_leo_spec_field "$sp" 3)")"
  done | sort
}
manifest_triples() { # <hooks.json>
  jq -r '.hooks | to_entries[] | .key as $ev | .value[] | (.matcher // "") as $m
         | .hooks[] | [$ev, $m, (.command | capture("(?<f>[^/\"]+\\.sh)").f)] | @tsv' "$1" | sort
}
SPEC_T="$(leo_core_hook_specs /X/leopold | specs_triples)"
MAN_T="$(manifest_triples "$ROOT/hooks/hooks.json")"
check "the manifest declares the same event/matcher/script set as the spec list" "$MAN_T" "$SPEC_T"
check "and it is not empty" "$( [ -n "$MAN_T" ] && echo yes || echo no )" "yes"

# The mutation, run in-suite on both sides: a parity test that cannot fail is a comment.
jq 'del(.hooks.Stop)' "$ROOT/hooks/hooks.json" > "$TD/manifest-minus-stop.json"
check "dropping an event from hooks.json breaks parity" \
  "$( [ "$(manifest_triples "$TD/manifest-minus-stop.json")" = "$SPEC_T" ] && echo same || echo different )" "different"
check "dropping a spec from leo_core_hook_specs breaks parity" \
  "$( [ "$(leo_core_hook_specs /X/leopold | head -1 | specs_triples)" = "$MAN_T" ] && echo same || echo different )" "different"
# and changing only the matcher on one side is caught too
jq '.hooks.PreToolUse[0].matcher = "Bash"' "$ROOT/hooks/hooks.json" > "$TD/manifest-narrow.json"
check "narrowing a matcher in hooks.json breaks parity" \
  "$( [ "$(manifest_triples "$TD/manifest-narrow.json")" = "$SPEC_T" ] && echo same || echo different )" "different"

# settings.template.json is the third place the core hooks are spelled — the block
# install.sh prints for a machine with no jq. It carries the enhancer's entry too, so
# this is containment, not equality: every core spec must appear there, timeout and
# all, or the hand-paste path silently installs a different Leopold.
tpl_quad() { # <settings.template.json> -> EVENT MATCHER SCRIPT TIMEOUT per core hook
  jq -r '.hooks | to_entries[] | .key as $ev | .value[] | (.matcher // "") as $m
         | .hooks[] | select(.command | test("/leopold/hooks/"))
         | [$ev, $m, (.command | capture("(?<f>[^/\"]+\\.sh)").f), (.timeout // "" | tostring)] | @tsv' "$1" | sort
}
specs_quad() { # specs on stdin
  local sp
  while IFS= read -r sp; do
    [ -n "$sp" ] || continue
    printf '%s\t%s\t%s\t%s\n' \
      "$(_leo_spec_field "$sp" 1)" "$(_leo_spec_field "$sp" 2)" \
      "$(basename "$(_leo_spec_field "$sp" 3)")" "$(_leo_spec_field "$sp" 4)"
  done | sort
}
# The asset home passed here is irrelevant to the comparison — specs_quad keeps only
# the script's basename, exactly as tpl_quad does of the template's ~/.claude path.
CORE_Q="$(leo_core_hook_specs /X/leopold | specs_quad)"
check "the jq-less paste template spells the core hooks exactly as the spec list does" \
  "$(tpl_quad "$ROOT/settings.template.json")" "$CORE_Q"
jq '.hooks.Stop[0].hooks[0] |= del(.timeout)' "$ROOT/settings.template.json" > "$TD/template-untimed.json"
check "dropping a timeout from the template breaks that pin" \
  "$( [ "$(tpl_quad "$TD/template-untimed.json")" = "$CORE_Q" ] && echo same || echo different )" "different"

echo
echo "the docs are pinned to the same list (the blocks a reader copies by hand)"

# Four pages print the exact wiring the installers write — the settings.json block and
# the config.toml managed block. Nothing but this pinned them, and they drifted: the
# Codex block still showed matcher "Bash" for two releases after the writer stopped
# writing it, and the Claude block never grew the timeouts. mkdocs --strict cannot see
# that; a reader who pastes one gets a different Leopold. Compared on event, matcher,
# script basename and timeout — the paths differ on purpose (~/.claude vs /home/you).
doc_toml_quad() { # <doc.md> -> the managed block's hooks as EVENT MATCHER SCRIPT TIMEOUT
  python3 - "$1" <<'PY'
import re, sys, tomllib
src = open(sys.argv[1], encoding="utf-8").read()
rows = []
for block in re.findall(r"```toml\n(.*?)```", src, re.S):
    if "# >>> leopold (managed) >>>" not in block:
        continue
    for ev, entries in tomllib.loads(block).get("hooks", {}).items():
        for e in entries:
            for h in e.get("hooks", []):
                rows.append("\t".join([ev, e.get("matcher", ""),
                                       h.get("command", "").rsplit("/", 1)[-1],
                                       str(h.get("timeout", ""))]))
print("\n".join(sorted(rows)))
PY
}
doc_json_quad() { # <doc.md> -> the settings.json block's LEOPOLD hooks, same shape
  python3 - "$1" <<'PY'
import json, re, sys
src = open(sys.argv[1], encoding="utf-8").read()
rows = []
for block in re.findall(r"```json\n(.*?)```", src, re.S):
    try:
        d = json.loads(block)
    except Exception:
        continue
    hooks = d.get("hooks")
    if not isinstance(hooks, dict):
        continue
    for ev, entries in hooks.items():
        for e in entries:
            for h in e.get("hooks", []):
                cmd = h.get("command", "")
                if "/leopold/hooks/" not in cmd:
                    continue
                rows.append("\t".join([ev, e.get("matcher", ""),
                                       cmd.rsplit("/", 1)[-1], str(h.get("timeout", ""))]))
print("\n".join(sorted(rows)))
PY
}
# The config.toml block shows what the CODEX writer actually writes, and that is the core
# list minus every event the matrix refuses on Codex (`StopFailure` today: an API error
# ends a Codex run as a plain stop, with no failure hook to ride). The subset is derived
# through the writer's OWN gate, so the docs cannot drift from what the installer does in
# either direction — a block that documents a hook Codex cannot fire fails here just as
# loudly as one that drops a hook it can.
CORE_CODEX_Q="$(leo_core_hook_specs /X/leopold | while IFS= read -r _sp; do
  [ -n "$_sp" ] || continue
  _leo_event_wired_here codex "$(_leo_spec_field "$_sp" 1)" 2>/dev/null && printf '%s\n' "$_sp"
done | specs_quad)"
check "the Codex-facing subset drops exactly the events the matrix refuses there" \
  "$(printf '%s\n' "$CORE_Q" | wc -l | tr -d ' ')/$(printf '%s\n' "$CORE_CODEX_Q" | wc -l | tr -d ' ')" "18/10"
# The three the matrix refuses on Codex, and the reason each is refused: an API error ends
# a Codex run as a plain stop, a failing command there reports through PostToolUse like any
# other (there is no tool-failure event to ride), and Codex has no task events at all.
check "and the ones it drops are StopFailure, PostToolUseFailure, TaskCompleted, FileChanged and ConfigChange" \
  "$(printf '%s\n' "$CORE_CODEX_Q" | grep -c 'StopFailure\|PostToolUseFailure\|TaskCompleted\|FileChanged\|ConfigChange')" "0"
# ...while the OTHER half of the evidence gate stays: Codex has no task events, so the
# PLAN.md PreToolUse edit gate carries that whole bound there.
check "...while Codex DOES keep the PLAN.md half of the evidence gate" \
  "$(printf '%s\n' "$CORE_CODEX_Q" | grep -c 'done-gate.sh')" "1"
check "...while Codex DOES keep the PostToolUse half of the receipts (substitute, wired)" \
  "$(printf '%s\n' "$CORE_CODEX_Q" | grep -c '^PostToolUse\b')" "1"
for doc in docs/reference/hooks.md docs/reference/hooks.pt-BR.md \
           docs/concepts/harnesses.md docs/concepts/harnesses.pt-BR.md; do
  check "$doc prints the core spec list as its config.toml block" \
    "$(doc_toml_quad "$ROOT/$doc")" "$CORE_CODEX_Q"
done
# The mutation for the new half of the rule: a documented Codex block that declares a
# hook Codex cannot fire must fail the pin, or "derived subset" is just a filter that
# accepts anything.
python3 - "$ROOT/docs/reference/hooks.md" > "$TD/doc-codex-toofar.md" <<'PYEOF'
import re, sys
src = open(sys.argv[1], encoding="utf-8").read()
extra = ('[[hooks.StopFailure]]\n\n[[hooks.StopFailure.hooks]]\ntype = "command"\n'
         'command = "/home/you/.claude/leopold/hooks/stop-failure.sh"\ntimeout = 5\n')
sys.stdout.write(src.replace("# <<< leopold (managed) <<<", extra + "# <<< leopold (managed) <<<", 1))
PYEOF
check "documenting a Codex hook the matrix refuses breaks the pin" \
  "$( [ "$(doc_toml_quad "$TD/doc-codex-toofar.md")" = "$CORE_CODEX_Q" ] && echo same || echo different )" "different"
for doc in docs/reference/hooks.md docs/reference/hooks.pt-BR.md; do
  check "$doc prints the core spec list as its settings.json block" \
    "$(doc_json_quad "$ROOT/$doc")" "$CORE_Q"
done
# In-suite mutations: the exact two drifts this pass found, so the pin cannot rot back.
sed 's/^matcher = "Bash|Edit|Write|MultiEdit|NotebookEdit"$/matcher = "Bash"/' \
  "$ROOT/docs/reference/hooks.md" > "$TD/doc-narrow.md"
check "narrowing the documented Codex matcher breaks the pin" \
  "$( [ "$(doc_toml_quad "$TD/doc-narrow.md")" = "$CORE_Q" ] && echo same || echo different )" "different"
sed 's/hooks\/stop-continuity.sh", "timeout": 15/hooks\/stop-continuity.sh"/' \
  "$ROOT/docs/reference/hooks.md" > "$TD/doc-untimed.md"
check "dropping the documented Claude timeout breaks it too" \
  "$( [ "$(doc_json_quad "$TD/doc-untimed.md")" = "$CORE_Q" ] && echo same || echo different )" "different"

echo
echo "install.sh --harness claude — hermetic, three runs over an older install"

# The Claude twin of the Codex idempotency section: the REAL installer, three times,
# over a settings.json an OLDER install.sh already wired (no timeouts, the same hook
# paths) plus hooks the user added themselves. Sealed exactly like
# scripts/test-codex-install.sh — env -i, a stub PATH, HOME and CLAUDE_HOME in the
# temp dir — so nothing here reaches the network or the developer's real homes.
ATD="$TD/claude-install"
ASTUB="$ATD/bin"; ACLAUDE="$ATD/claude"; ALEO="$ACLAUDE/leopold"
mkdir -p "$ASTUB" "$ATD/home" "$ACLAUDE"
for t in bash sh env grep sed awk cat cut head tail sort tr wc cp mv rm mkdir rmdir \
         dirname basename mktemp ls printf jq python3 chmod cksum timeout diff find \
         git touch date stat sleep uname id readlink xargs; do
  p="$(type -P "$t" 2>/dev/null)" && [ -n "$p" ] && ln -sf "$p" "$ASTUB/$t"
done
printf '#!/usr/bin/env bash\nexit 1\n' > "$ASTUB/npm"            # no global install, no network
printf '#!/usr/bin/env bash\ncase "${1:-}" in --version) echo "serena 9.9.9" ;; *) exit 0 ;; esac\n' > "$ASTUB/serena"
printf '#!/usr/bin/env bash\nexit 0\n' > "$ASTUB/serena-hooks"
printf '#!/usr/bin/env bash\nexit 0\n' > "$ASTUB/uv"
chmod +x "$ASTUB/npm" "$ASTUB/serena" "$ASTUB/serena-hooks" "$ASTUB/uv"

ASET="$ACLAUDE/settings.json"
cat > "$ASET" <<JSON
{
  "permissions": { "allow": ["Bash(ls:*)"] },
  "hooks": {
    "Stop": [ { "hooks": [ { "type": "command", "command": "$ALEO/hooks/stop-continuity.sh" } ] } ],
    "PreToolUse": [
      { "matcher": "Bash|Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [ { "type": "command", "command": "$ALEO/hooks/guard-irreversible.sh" } ] },
      { "matcher": "Bash", "hooks": [ { "type": "command", "command": "/opt/mine/my-guard.sh" } ] }
    ],
    "SessionStart": [ { "hooks": [ { "type": "command", "command": "/opt/mine/my-session.sh" } ] } ]
  }
}
JSON
arc=0
a_out=""
for _ in 1 2 3; do
  a_out="$( env -i PATH="$ASTUB" HOME="$ATD/home" TERM=dumb \
      CLAUDE_HOME="$ACLAUDE" CODEX_HOME="$ATD/no-such-codex" LEOPOLD_NONINTERACTIVE=1 \
      timeout 300 bash "$ROOT/install.sh" --harness claude </dev/null 2>&1 )" || arc=1
done
check "install.sh --harness claude ran clean 3x" "$arc" "0"
check "settings.json still parses after 3 installs" "$(jq -e . "$ASET" >/dev/null 2>&1 && echo yes || echo no)" "yes"

# @scenario: each event has exactly one Leopold hook. Counted per event on the
# commands that point into the asset home's hooks/ dir, so the enhancer's and
# Serena's own hooks are not mistaken for the core ones.
# Counted per (event, SCRIPT), not per event: PreToolUse legitimately carries two Leopold
# hooks (the git lock, the subagent cap and the evidence gate), and a per-event count
# would have to be
# loosened to "at least one" to survive that — which stops noticing the duplicate entry a
# re-install used to leave behind. The pair is the invariant that actually matters.
# Keyed by (event, MATCHER, script), not by (event, script): one script is legitimately
# declared several times on one event under different matchers — the FileChanged detector
# needs a path-shaped entry to register each watch and a basename-shaped one to receive it
# (probed; hooks/file-watch.sh carries the table). The matcher is what makes those four
# entries four declarations instead of one duplicated four times, and the invariant still
# catches the duplicate entry a re-install used to leave behind.
leopold_wired_triples() {
  jq -r --arg p "$ALEO/hooks/" '
    .hooks | to_entries[] | .key as $ev | .value[]? | (.matcher // "") as $m
    | .hooks[]? | select(.command | startswith($p))
    | [$ev, $m, (.command | split("/") | last)] | @tsv' "$ASET" | sort
}
check "exactly one Leopold hook per event, matcher and script" \
  "$(leopold_wired_triples | uniq -d | wc -l | tr -d ' ')" "0"
# Compared against the spec list itself rather than a hand-typed string: the list is the
# one contract, and a hook added to it that never lands here has to fail somewhere.
check "and the event/matcher/script triples wired are exactly the core spec list" \
  "$(leopold_wired_triples)" "$(leo_core_hook_specs "$ALEO" | specs_triples)"
check "and it is not empty" "$( [ -n "$(leopold_wired_triples)" ] && echo yes || echo no )" "yes"
check "no event declares the same matcher and command twice" \
  "$(jq '[.hooks | to_entries[] | [ .value[]? | (.matcher // "") as $m | .hooks[]? | "\($m)|\(.command)" ] | (length - (unique|length))] | add' "$ASET")" "0"
# The one list is what landed: matcher and timeout included, upgrading the older
# entry in place rather than adding a second one next to it.
check "the git lock kept the core matcher" \
  "$(jq -r --arg p "$ALEO/hooks/guard-irreversible.sh" '.hooks.PreToolUse[] | select(.hooks[0].command == $p) | .matcher' "$ASET")" \
  "Bash|Edit|Write|MultiEdit|NotebookEdit"
check "the older Stop entry was re-timed to the spec's timeout" \
  "$(jq -r --arg p "$ALEO/hooks/stop-continuity.sh" '.hooks.Stop[].hooks[] | select(.command == $p) | .timeout' "$ASET")" "15"
check "and the git lock's too" \
  "$(jq -r --arg p "$ALEO/hooks/guard-irreversible.sh" '.hooks.PreToolUse[].hooks[] | select(.command == $p) | .timeout' "$ASET")" "5"

# @scenario: the user's other hooks are untouched.
check "the user's own PreToolUse hook survived" \
  "$(jq '[.hooks.PreToolUse[].hooks[] | select(.command == "/opt/mine/my-guard.sh")] | length' "$ASET")" "1"
check "with its own matcher"       "$(jq -r '.hooks.PreToolUse[] | select(.hooks[0].command == "/opt/mine/my-guard.sh") | .matcher' "$ASET")" "Bash"
check "the user's own event survived" \
  "$(jq '[.hooks.SessionStart[].hooks[] | select(.command == "/opt/mine/my-session.sh")] | length' "$ASET")" "1"
check "the user's permissions survived" "$(jq -r '.permissions.allow[0]' "$ASET")" "Bash(ls:*)"
check "a backup of the pre-install settings exists" "$( [ -f "$ASET.leopold.bak" ] && echo yes || echo no )" "yes"
check "the hooks it wired are the installed copies" \
  "$(cmp -s "$ALEO/hooks/stop-continuity.sh" "$ROOT/hooks/stop-continuity.sh" && echo same || echo different)" "same"
check "the matrix shipped into the asset home too" \
  "$( [ -f "$ALEO/hooks/hook-matrix.tsv" ] && echo yes || echo no )" "yes"
check "no Codex config was written by a Claude-only install" \
  "$( [ -e "$ATD/no-such-codex" ] && echo yes || echo no )" "no"
# The same honesty check on the Claude side, through the real installer. The matrix is
# authored here to refuse both core events on claude — no shipped row does — so what is
# under test is install.sh's report, not the matrix.
cat > "$ATD/refuse-all.tsv" <<'TSV'
# probed: claude "2.1.259 (Claude Code)" codex "codex-cli 0.152.1"
run-continuity	Stop	claude	unavailable	#what-this-decides-for-leopold	authored by the test
git-lock	PreToolUse	claude	unavailable	#what-this-decides-for-leopold	authored by the test
permission-policy	PermissionRequest	claude	unavailable	#what-this-decides-for-leopold	authored by the test
compact-checkpoint	PreCompact	claude	unavailable	#what-this-decides-for-leopold	authored by the test
compact-checkpoint	PostCompact	claude	unavailable	#what-this-decides-for-leopold	authored by the test
api-error-stop	StopFailure	claude	unavailable	#what-this-decides-for-leopold	authored by the test
subagent-accounting	SubagentStart	claude	unavailable	#what-this-decides-for-leopold	authored by the test
subagent-accounting	SubagentStop	claude	unavailable	#what-this-decides-for-leopold	authored by the test
subagent-cap	PreToolUse	claude	unavailable	#what-this-decides-for-leopold	authored by the test
verify-receipt	PostToolUse	claude	unavailable	#what-this-decides-for-leopold	authored by the test
verify-receipt	PostToolUseFailure	claude	unavailable	#what-this-decides-for-leopold	authored by the test
done-gate	PreToolUse	claude	unavailable	#what-this-decides-for-leopold	authored by the test
done-gate	TaskCompleted	claude	unavailable	#what-this-decides-for-leopold	authored by the test
file-watch	FileChanged	claude	unavailable	#what-this-decides-for-leopold	authored by the test
config-guard	ConfigChange	claude	unavailable	#what-this-decides-for-leopold	authored by the test
TSV
# Seeded with hooks of the USER's own on both core events. That is what separates
# "the event has an entry" from "Leopold's hook is there": the weak check this
# replaced would have reported both events green while not one Leopold hook existed.
mkdir -p "$ATD/claude-refused"
cat > "$ATD/claude-refused/settings.json" <<'JSON'
{
  "hooks": {
    "Stop": [ { "hooks": [ { "type": "command", "command": "/opt/mine/my-stop.sh" } ] } ],
    "PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "/opt/mine/my-guard.sh" } ] } ]
  }
}
JSON
r_out="$( env -i PATH="$ASTUB" HOME="$ATD/home" TERM=dumb \
              CLAUDE_HOME="$ATD/claude-refused" CODEX_HOME="$ATD/no-such-codex" \
              LEOPOLD_NONINTERACTIVE=1 LEO_MATRIX_TSV="$ATD/refuse-all.tsv" \
              timeout 300 bash "$ROOT/install.sh" --harness claude </dev/null 2>&1 )"
check "a fully refused Claude wire says NOT ONE hook was declared" \
  "$(printf '%s\n' "$r_out" | grep -c 'NOT ONE Leopold hook was declared')" "1"
check "and names the events it refused" \
  "$(printf '%s\n' "$r_out" | grep -c 'refused for Claude Code: Stop PreToolUse PermissionRequest PreCompact PostCompact StopFailure SubagentStart SubagentStop PreToolUse PostToolUse PostToolUseFailure PreToolUse TaskCompleted FileChanged FileChanged FileChanged FileChanged ConfigChange')" "1"
# Anchored: Serena's doctor prints a "hooks wired (4: ...)" line of its own.
check "and never claims a hook count it did not land" \
  "$(printf '%s\n' "$r_out" | grep -cE '^   [0-9]+ hooks wired \(')" "0"
check "and the end-of-install check agrees, per hook" \
  "$(printf '%s\n' "$r_out" | grep -c 'warn: not wired in settings.json: Stop PreToolUse PermissionRequest PreCompact PostCompact StopFailure SubagentStart SubagentStop PreToolUse PostToolUse PostToolUseFailure PreToolUse TaskCompleted FileChanged FileChanged FileChanged FileChanged ConfigChange')" "1"
check "and never reports the hooks as ok" \
  "$(printf '%s\n' "$r_out" | grep -c 'ok   18 Leopold hooks wired')" "0"
check "and settings.json holds no Leopold hook" \
  "$( [ -f "$ATD/claude-refused/settings.json" ] && jq '[.hooks[]?[]?.hooks[]?|select(.command|test("leopold/hooks/"))]|length' "$ATD/claude-refused/settings.json" || echo 0 )" "0"
check "while the user's own hooks on those very events survived" \
  "$(jq '[.hooks[]?[]?.hooks[]?|select(.command|startswith("/opt/mine/"))]|length' "$ATD/claude-refused/settings.json")" "2"
# The positive control is the three-install run above: same installer, real matrix.
check "the green run reports the count it landed" \
  "$(printf '%s\n' "$a_out" | grep -c 'ok   18 Leopold hooks wired in settings.json')" "1"

check "the real ~/.claude gained no new entries" "$(real_claude_fingerprint)" "$REAL_CLAUDE_BEFORE"
check "the real ~/.codex gained no new entries"  "$(real_home_fingerprint)"   "$REAL_BEFORE"

echo
if [ "$FAIL" -eq 0 ]; then
  printf '\033[32m%s passed, 0 failed\033[0m\n' "$PASS"
else
  printf '\033[31m%s passed, %s FAILED\033[0m\n' "$PASS" "$FAIL"
  exit 1
fi

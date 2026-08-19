#!/usr/bin/env bash
# Behavior tests for the shared harness wiring helper (extensions/lib/harness.sh)
# and for the Codex installer that now uses it.
#
# HERMETIC: every path is inside a temp dir. CLAUDE_HOME / CODEX_HOME / LEOPOLD_HOME
# are pointed at it, so this never reads or writes the developer's real ~/.claude
# or ~/.codex. A test that mutates your harness home is not a test.
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
check "exactly one PreToolUse hook"          "$(toml_hook_count "$ITD/codex/config.toml" PreToolUse)" "1"
check "exactly one Stop hook"                "$(toml_hook_count "$ITD/codex/config.toml" Stop)" "1"
check "the user's own config key survived"   "$(python3 -c 'import tomllib,sys;print(tomllib.load(open(sys.argv[1],"rb"))["model"])' "$ITD/codex/config.toml")" "gpt-5"
check "guard hook points at the asset home"  "$(grep -c "^command = \"$ITD/leo/hooks/guard-irreversible.sh\"$" "$ITD/codex/config.toml")" "1"
check "skills installed"                     "$( [ -f "$ITD/codex/skills/leopold-run/SKILL.md" ] && echo yes || echo no )" "yes"
check "the real ~/.codex gained no new entries"   "$(real_home_fingerprint)" "$REAL_BEFORE"
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
if [ "$FAIL" -eq 0 ]; then
  printf '\033[32m%s passed, 0 failed\033[0m\n' "$PASS"
else
  printf '\033[31m%s passed, %s FAILED\033[0m\n' "$PASS" "$FAIL"
  exit 1
fi

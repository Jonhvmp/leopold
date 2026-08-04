#!/usr/bin/env bash
# End-to-end test for the Codex CLI install path: `./install.sh --harness codex`.
#
# The other suites test the pieces (extensions/lib/harness.sh in test-harness-lib.sh,
# one extension each in test-serena-ext.sh / test-ovmem-ext.sh / test-gstack-ext.sh /
# test-enhance-ext.sh). This one tests the PRODUCT a Codex-only user actually gets:
# run the real installer, then assert the skills, BOTH hooks (wired AND working from
# the installed copy), all four extensions, idempotency over three installs, and that
# a broken config.toml is refused instead of clobbered.
#
# HERMETIC, and it proves it. Every run happens under `env -i` with PATH rebuilt from
# a stub dir and HOME / CLAUDE_HOME / CODEX_HOME / LEOPOLD_HOME inside a temp dir:
# nothing here reaches the network, installs a package, or writes into the developer's
# real ~/.claude or ~/.codex. The last section re-checks the real homes — entry names
# AND the mtime of the real ~/.codex/config.toml, the one file this installer would
# edit — so an escaped write fails the suite instead of being noticed months later.
#
# What is deliberately NOT installed here: ovmem (needs OpenViking + a provider key)
# and gstack (needs a git clone + Bun) are opt-in extensions the installer never runs
# unattended. Their install paths are covered hermetically in test-ovmem-ext.sh and
# test-gstack-ext.sh; what this suite asserts is that both ship in the Codex asset home
# and report status/doctor honestly per harness there, with no Claude path in sight.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  \033[32mok\033[0m   %s\n' "$*"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "$*"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want [$3], got [$2])"; fi; }
has()  { if printf '%s' "$2" | grep -q -- "$3"; then ok "$1"; else bad "$1"; fi; }
hasnt(){ if printf '%s' "$2" | grep -q -- "$3"; then bad "$1"; else ok "$1"; fi; }

# --- the escape detectors ----------------------------------------------------
# Names only for the directory listings: a live agent session writes into its own
# home the whole time this suite runs, so timestamps there would fail for reasons
# that have nothing to do with Leopold. An escaped write shows up as a NEW entry.
# config.toml is the one file the Codex installer edits, so that one is watched by
# mtime + size — the precise thing scenario 1 asks for.
real_fp()       { ls -A "$1" 2>/dev/null | sort | cksum; }
real_cfg_stamp(){ stat -c '%Y %s' "$HOME/.codex/config.toml" 2>/dev/null || \
                  stat -f '%m %z' "$HOME/.codex/config.toml" 2>/dev/null || echo "absent"; }
REAL_CODEX_BEFORE="$(real_fp "$HOME/.codex")"
REAL_CLAUDE_BEFORE="$(real_fp "$HOME/.claude")"
REAL_CFG_BEFORE="$(real_cfg_stamp)"
REAL_HOME="$HOME"

TD="$(mktemp -d)"
trap 'rm -rf "$TD"' EXIT
STUB="$TD/bin"
mkdir -p "$STUB" "$TD/home"

# --- the sealed PATH ---------------------------------------------------------
# `type -P` and not `command -v`: the latter answers with shell functions and
# builtins too, which would silently produce broken self-referential symlinks and
# turn every grep-based assertion inside the installer into a false negative.
for t in bash sh env grep sed awk cat cut head tail sort tr wc cp mv rm mkdir rmdir \
         dirname basename mktemp ls printf jq python3 chmod cksum timeout diff find \
         git touch date stat sleep uname id readlink xargs; do
  p="$(type -P "$t" 2>/dev/null)" && [ -n "$p" ] && ln -sf "$p" "$STUB/$t"
done
# npm fails: the installer must survive a machine with no working npm, and this
# suite must never run `npm i -g` (network + a global write outside the temp dir).
printf '#!/usr/bin/env bash\necho "npm stub: refusing (hermetic test)" >&2\nexit 1\n' > "$STUB/npm"
# serena + uv: present but inert, so the Serena extension takes its installed path
# without downloading anything.
printf '#!/usr/bin/env bash\ncase "${1:-}" in --version) echo "serena 9.9.9" ;; *) exit 0 ;; esac\n' > "$STUB/serena"
printf '#!/usr/bin/env bash\nexit 0\n' > "$STUB/serena-hooks"
printf '#!/usr/bin/env bash\nexit 0\n' > "$STUB/uv"
chmod +x "$STUB/npm" "$STUB/serena" "$STUB/serena-hooks" "$STUB/uv"
# No `claude` and no `codex` on this PATH on purpose: this is a machine that has
# never seen Claude Code. Anything that only works because a Claude binary happened
# to be around has to fail here.

CODEX="$TD/codex"
NOCLAUDE="$TD/no-such-claude"
CFG="$CODEX/config.toml"
LEO="$CODEX/leopold"

# Every invocation below runs in this environment and nowhere else.
sealed() { # <cmd...>
  env -i PATH="$STUB" HOME="$TD/home" TERM=dumb \
      CLAUDE_HOME="$NOCLAUDE" CODEX_HOME="$CODEX" \
      LEOPOLD_NONINTERACTIVE=1 "$@" 2>&1
}
install_codex() { sealed timeout 300 bash "$ROOT/install.sh" --harness codex </dev/null; }
ext() { # <extension> <subcommand>
  env -i PATH="$STUB" HOME="$TD/home" TERM=dumb \
      CLAUDE_HOME="$NOCLAUDE" CODEX_HOME="$CODEX" LEOPOLD_HARNESS=codex \
      timeout 120 bash "$LEO/extensions/$1/manage.sh" "$2" </dev/null 2>&1
}

toml_ok()  { python3 -c 'import sys,tomllib;tomllib.load(open(sys.argv[1],"rb"))' "$1" 2>/dev/null; }
toml_get() { python3 - "$1" "$2" <<'PY'
import sys, tomllib
d = tomllib.load(open(sys.argv[1], "rb"))
for k in sys.argv[2].split("."):
    d = d[int(k)] if isinstance(d, list) else d[k]
print(d)
PY
}
# How many hooks are declared for an event, optionally only those whose command
# matches a substring. Serena declares PreToolUse hooks of its own, so "is the git
# lock wired exactly once" has to be asked about the command, not about the event.
hook_count() { # <event> [command-substring]
  python3 - "$CFG" "$1" "${2:-}" <<'PY'
import sys, tomllib
d = tomllib.load(open(sys.argv[1], "rb"))
want = sys.argv[3]
print(sum(1
          for entry in d.get("hooks", {}).get(sys.argv[2], [])
          for h in entry.get("hooks", [])
          if want in h.get("command", "")))
PY
}
# The command Codex would actually run for an event, found by substring — the block
# order in config.toml is not part of the contract, the wiring is.
hook_cmd() { # <event> <command-substring>
  python3 - "$CFG" "$1" "$2" <<'PY'
import sys, tomllib
d = tomllib.load(open(sys.argv[1], "rb"))
for entry in d.get("hooks", {}).get(sys.argv[2], []):
    for h in entry.get("hooks", []):
        if sys.argv[3] in h.get("command", ""):
            print(h["command"]); raise SystemExit
print("")
PY
}
perm() { printf '%s' "$1" | jq -r '.hookSpecificOutput.permissionDecision // "allow"' 2>/dev/null || echo allow; }
dec()  { printf '%s' "$1" | jq -r '.decision // "none"' 2>/dev/null || echo none; }

echo "codex install — a machine with no ~/.claude, no claude and no codex on PATH"

mkdir -p "$CODEX"
printf 'model = "gpt-5-codex"\n\n[tui]\ntheme = "dark"\n' > "$CFG"
PRE_CFG="$(cat "$CFG")"
out="$(install_codex)"; rc=$?
check "install.sh --harness codex exits clean" "$rc" "0"
hasnt "the install never claims a Claude home" "$out" "$NOCLAUDE"
check "no Claude home was created" "$( [ -e "$NOCLAUDE" ] && echo yes || echo no )" "no"
check "assets landed under the Codex home" "$( [ -d "$LEO" ] && echo yes || echo no )" "yes"

echo
echo "  skills"
missing=0; total=0
for d in "$ROOT"/skills/*/; do
  total=$((total+1))
  [ -f "$CODEX/skills/$(basename "$d")/SKILL.md" ] || missing=$((missing+1))
done
check "every repo skill is installed for Codex ($total)" "$missing" "0"
check "and none of them landed in a Claude skills dir" \
  "$( [ -e "$NOCLAUDE/skills" ] && echo yes || echo no )" "no"

echo
echo "  both hooks: wired"
check "config.toml still parses as TOML"    "$(toml_ok "$CFG" && echo yes || echo no)" "yes"
check "exactly one managed leopold block"   "$(grep -c '^# >>> leopold (managed) >>>$' "$CFG")" "1"
check "one PreToolUse git lock"             "$(hook_count PreToolUse guard-irreversible.sh)" "1"
check "one Stop hook"                       "$(hook_count Stop stop-continuity.sh)" "1"
GUARD="$(hook_cmd PreToolUse guard-irreversible.sh)"
STOP="$(hook_cmd Stop stop-continuity.sh)"
check "the git lock points into the Codex asset home" "$GUARD" "$LEO/hooks/guard-irreversible.sh"
check "the continuity hook does too"                  "$STOP"  "$LEO/hooks/stop-continuity.sh"
check "the guard is matched on Bash" \
  "$(python3 -c '
import sys, tomllib
d = tomllib.load(open(sys.argv[1], "rb"))
print(next(e.get("matcher", "") for e in d["hooks"]["PreToolUse"]
           if any("guard-irreversible.sh" in h.get("command", "") for h in e.get("hooks", []))))
' "$CFG")" "Bash"
check "the guard hook is executable"        "$( [ -x "$GUARD" ] && echo yes || echo no )" "yes"
check "the continuity hook is executable"   "$( [ -x "$STOP" ] && echo yes || echo no )" "yes"
check "the installed guard is the repo's, byte for byte" \
  "$(cmp -s "$GUARD" "$ROOT/hooks/guard-irreversible.sh" && echo same || echo different)" "same"
check "the installed continuity hook too" \
  "$(cmp -s "$STOP" "$ROOT/hooks/stop-continuity.sh" && echo same || echo different)" "same"
check "the user's own config keys survived" "$(toml_get "$CFG" 'tui.theme')" "dark"
check "and the model they chose"            "$(toml_get "$CFG" model)" "gpt-5-codex"
check "a backup of the pre-install config exists" "$( [ -f "$CFG.leopold.bak" ] && echo yes || echo no )" "yes"
# The promise behind every write: whatever we did, the file the user had is one
# `cp` away.
check "the backup is byte-identical to the config as found" \
  "$(printf '%s\n' "$PRE_CFG" | diff -q - "$CFG.leopold.bak" >/dev/null && echo same || echo different)" "same"
check "nothing in config.toml points at a Claude path" "$(grep -c '\.claude' "$CFG")" "0"

echo
echo "  both hooks: working, driven from the INSTALLED copy exactly as Codex drives them"
# Wiring a hook proves nothing if the file it points at cannot run. These call the
# command string read out of config.toml above, with the payloads codex-cli 0.146.0
# sends (same keys as Claude Code's — that is why one script serves both).
PROJ="$TD/proj"; mkdir -p "$PROJ/.leopold"
echo '{"active":true,"iteration":1,"max_iterations":50}' > "$PROJ/.leopold/state.json"
printf '# Plan\n- [ ] an open item\n' > "$PROJ/.leopold/PLAN.md"

g_out="$(sealed bash "$GUARD" <<< "$(printf '{"cwd":"%s","tool_name":"Bash","tool_input":{"command":"git commit -m x"}}' "$PROJ")")"
check "the installed git lock DENIES git commit" "$(perm "$g_out")" "deny"
g_out="$(sealed bash "$GUARD" <<< "$(printf '{"cwd":"%s","tool_name":"Bash","tool_input":{"command":"git push origin main"}}' "$PROJ")")"
check "the installed git lock DENIES git push"   "$(perm "$g_out")" "deny"
g_out="$(sealed bash "$GUARD" <<< "$(printf '{"cwd":"%s","tool_name":"Bash","tool_input":{"command":"git add -A"}}' "$PROJ")")"
# Allow is the empty reply — the hook says nothing and the harness proceeds.
check "and lets git add through"                 "$g_out" ""

s_out="$(sealed bash "$STOP" <<< "$(printf '{"cwd":"%s","transcript_path":"%s","stop_hook_active":false}' "$PROJ" "$TD/none.jsonl")")"
check "the installed continuity hook blocks the stop while work remains" "$(dec "$s_out")" "block"
printf '# Plan\n- [x] an open item\n' > "$PROJ/.leopold/PLAN.md"
s_out="$(sealed bash "$STOP" <<< "$(printf '{"cwd":"%s","transcript_path":"%s","stop_hook_active":false}' "$PROJ" "$TD/none.jsonl")")"
check "and lets it stop once the plan is complete" "$s_out" ""
echo '{"active":false}' > "$PROJ/.leopold/state.json"
s_out="$(sealed bash "$STOP" <<< "$(printf '{"cwd":"%s"}' "$PROJ")")"
check "and is inert when no run is active" "$s_out" ""

echo
echo "  extension: enhance (installed by install.sh, wired OFF)"
check "the engine is vendored into the Codex home" "$( [ -f "$CODEX/enhance/enhance.py" ] && echo yes || echo no )" "yes"
check "one UserPromptSubmit hook wired"            "$(hook_count UserPromptSubmit)" "1"
check "one managed enhance block"                  "$(grep -c '^# >>> leopold:enhance (managed) >>>$' "$CFG")" "1"
e_status="$(ext enhance status)"
has   "status names the harness"                   "$e_status" "Codex CLI"
has   "status reports the hook as wired"           "$e_status" "hook wired"
e_doc="$(ext enhance doctor)"
has   "doctor names the harness"                   "$e_doc" "Codex CLI:"
has   "doctor reports 1/1 wired"                   "$e_doc" "1/1 wired"
has   "doctor states the Codex hook-trust gate"    "$e_doc" "inert until you approve it once"
hasnt "doctor reports no missing engine"           "$e_doc" "engine:   missing"
hasnt "doctor never points at a Claude path"       "$e_doc" "\.claude"

echo
echo "  extension: serena (installed by install.sh)"
check "four Serena hooks in config.toml"  "$(grep -c 'serena-hooks ' "$CFG")" "4"
check "wired with --client=codex"         "$(grep -c 'client=codex' "$CFG")" "4"
check "no claude-code client leaked in"   "$(grep -c 'client=claude-code' "$CFG")" "0"
s_status="$(ext serena status)"
has   "status names the harness"          "$s_status" "Codex CLI"
has   "status reports 4/4 hooks"          "$s_status" "hooks 4/4"
s_doc="$(ext serena doctor)"
has   "doctor names the harness"          "$s_doc" "Codex CLI:"
has   "doctor reports 4/4 hooks"          "$s_doc" "hooks:  4/4"
hasnt "doctor never points at a Claude path" "$s_doc" "\.claude"

echo
echo "  extension: ovmem (opt-in — ships, reports per harness, never lies)"
check "the extension shipped into the Codex asset home" \
  "$( [ -f "$LEO/extensions/ovmem/manage.sh" ] && [ -f "$LEO/extensions/ovmem/install.sh" ] && echo yes || echo no )" "yes"
check "its engine payload shipped too" "$( [ -f "$LEO/extensions/ovmem/payload/ovmem.py" ] && echo yes || echo no )" "yes"
ext ovmem detect >/dev/null 2>&1
check "detect reports it as not installed" "$?" "1"
o_status="$(ext ovmem status)"
check "status is one line (the menu renders it inline)" "$(printf '%s\n' "$o_status" | wc -l)" "1"
o_doc="$(ext ovmem doctor)"
has   "doctor names the harness"                 "$o_doc" "Codex CLI:"
has   "doctor states 0/4 hooks rather than nothing" "$o_doc" "hooks:   0/4"
has   "doctor names the Codex config it reads"   "$o_doc" "$CFG"
has   "doctor states the Codex SessionEnd cap"   "$o_doc" "caps SessionEnd at 3s"
hasnt "doctor never points at a Claude path"     "$o_doc" "\.claude"

echo
echo "  extension: gstack (opt-in — ships, reports per harness, never lies)"
check "the extension shipped into the Codex asset home" \
  "$( [ -f "$LEO/extensions/gstack/manage.sh" ] && echo yes || echo no )" "yes"
ext gstack detect >/dev/null 2>&1
check "detect reports no checkout" "$?" "1"
g_status="$(ext gstack status)"
check "status is one line" "$(printf '%s\n' "$g_status" | wc -l)" "1"
has   "status names the harness" "$g_status" "Codex CLI"
g_doc="$(ext gstack doctor)"
has   "doctor names the harness"                    "$g_doc" "Codex CLI:"
has   "doctor points at the Codex skills root"      "$g_doc" "$CODEX/skills"
hasnt "doctor never points at a Claude path"        "$g_doc" "\.claude"

echo
echo "codex install — idempotent (install three times, assert one of everything)"

install_codex >/dev/null; rc2=$?
cp "$CFG" "$TD/after-second.toml"
out3="$(install_codex)"; rc3=$?
check "the 2nd install exits clean" "$rc2" "0"
check "the 3rd install exits clean" "$rc3" "0"
# Byte-identical, not merely equivalent. Lifting a managed block out of the middle
# of the file used to leave its blank lines behind, so every re-install grew
# config.toml by two empty lines — a file that never stops growing is not idempotent.
check "config.toml is byte-identical after the 2nd and 3rd install" \
  "$(diff -q "$TD/after-second.toml" "$CFG" >/dev/null && echo same || echo changed)" "same"
check "and it never grew a run of blank lines" \
  "$(awk 'BEGIN{n=0;m=0} /^[[:space:]]*$/{n++; if(n>m)m=n; next} {n=0} END{print m}' "$CFG")" "1"
check "still valid TOML"                    "$(toml_ok "$CFG" && echo yes || echo no)" "yes"
check "still one PreToolUse git lock"       "$(hook_count PreToolUse guard-irreversible.sh)" "1"
check "still one Stop hook"                 "$(hook_count Stop stop-continuity.sh)" "1"
check "still one UserPromptSubmit hook"     "$(hook_count UserPromptSubmit enhance.py)" "1"
check "still one managed leopold block"     "$(grep -c '^# >>> leopold (managed) >>>$' "$CFG")" "1"
check "still one managed enhance block"     "$(grep -c '^# >>> leopold:enhance (managed) >>>$' "$CFG")" "1"
check "still one managed serena block"      "$(grep -c '^# >>> leopold:serena (managed) >>>$' "$CFG")" "1"
check "still exactly four Serena hooks"     "$(grep -c 'serena-hooks ' "$CFG")" "4"
check "the user's own config keys are still there" "$(toml_get "$CFG" 'tui.theme')" "dark"
check "the install verified itself green"   "$(printf '%s' "$out3" | grep -c 'git lock wired into')" "1"

check "the backup of the 3rd install still parses" "$(toml_ok "$CFG.leopold.bak" && echo yes || echo no)" "yes"

echo
echo "codex install — a corrupted config.toml is refused, not clobbered"
# Scenario: the target config cannot be parsed (hand-edited, half-written, whatever).
# The installer must leave it EXACTLY as found, say so, and still install the half it
# can (skills). A config the harness cannot read is the one outcome that is worse than
# not installing at all.
BROKEN='model = "gpt-5"
this is = not [valid toml
[[hooks.PreToolUse'
printf '%s\n' "$BROKEN" > "$CFG"
BROKEN_SUM="$(cksum < "$CFG")"
rm -rf "$CODEX/skills/leopold-run"
b_out="$(install_codex)"; b_rc=$?
check "the installer still exits clean"          "$b_rc" "0"
check "the broken config is byte-identical to what it found" "$(cksum < "$CFG")" "$BROKEN_SUM"
check "no managed block was appended to it"      "$(grep -c 'leopold (managed)' "$CFG")" "0"
has   "the refusal is stated, not silent"        "$b_out" "would not parse as TOML"
has   "and the block is printed for manual use"  "$b_out" "hooks.PreToolUse"
has   "the verification reports the hooks as unwired" "$b_out" "git lock not wired"
check "the skills half still installed"          "$( [ -f "$CODEX/skills/leopold-run/SKILL.md" ] && echo yes || echo no )" "yes"
# and the backup taken before the refused write still holds the broken file the user
# owns — never a Leopold-mangled version of it
check "the backup matches the config it was taken from" \
  "$(cksum < "$CFG.leopold.bak")" "$BROKEN_SUM"

echo
echo "codex install — a config that breaks DURING the write is rolled back from the backup"
# The section above covers the refusal that happens BEFORE anything lands. This one
# covers the other half of the contract — the landed file is re-validated, and if it
# does not parse the backup is copied back. That branch cannot be reached by feeding
# the installer bad input (the pre-write check catches it first), so it is driven
# directly: shadow the validator so the merged temp file passes and the LANDED file
# fails, which is exactly the state the branch exists for.
cat > "$TD/rollback.sh" <<'RB'
set -uo pipefail
. "$ROOT/extensions/lib/harness.sh"
printf 'model = "gpt-5-codex"\n\n[tui]\ntheme = "dark"\n' > "$TARGET"
ORIG="$(cksum < "$TARGET")"
# passes for the merged temp file, fails for the file once it has landed
_leo_toml_validate() { [ "$1" = "$TARGET" ] && return 1; return 0; }
out="$(leo_wire_hooks_toml "$TARGET" leopold "Stop||/x/stop.sh|15" 2>&1)"; rc=$?
echo "RC=$rc"
echo "SAME=$( [ "$(cksum < "$TARGET")" = "$ORIG" ] && echo yes || echo no )"
echo "BAK=$( [ -f "$TARGET.leopold.bak" ] && echo yes || echo no )"
echo "OUT=$out"
RB
ROLLBACK="$(env -i PATH="$STUB" HOME="$TD/home" TERM=dumb \
  CLAUDE_HOME="$NOCLAUDE" CODEX_HOME="$CODEX" ROOT="$ROOT" TARGET="$TD/rollback.toml" \
  timeout 60 bash "$TD/rollback.sh" </dev/null 2>&1)"
check "a write that lands broken exits non-zero"     "$(printf '%s\n' "$ROLLBACK" | grep '^RC=' | cut -d= -f2)" "1"
check "and the config is restored byte for byte"     "$(printf '%s\n' "$ROLLBACK" | grep '^SAME=' | cut -d= -f2)" "yes"
check "the backup it restored from is still on disk" "$(printf '%s\n' "$ROLLBACK" | grep '^BAK=' | cut -d= -f2)" "yes"
has   "the rollback is announced, not silent"        "$ROLLBACK" "restored from"

echo
echo "codex install — LEOPOLD_HOME moves the asset home, and the wiring follows"

ALT="$TD/alt-home"
printf 'model = "gpt-5"\n' > "$CFG"
env -i PATH="$STUB" HOME="$TD/home" TERM=dumb CLAUDE_HOME="$NOCLAUDE" CODEX_HOME="$CODEX" \
    LEOPOLD_HOME="$ALT" LEOPOLD_NONINTERACTIVE=1 \
    timeout 300 bash "$ROOT/install.sh" --harness codex </dev/null >/dev/null 2>&1
check "the hooks were installed under LEOPOLD_HOME" \
  "$( [ -x "$ALT/hooks/guard-irreversible.sh" ] && echo yes || echo no )" "yes"
check "and config.toml points there"  "$(toml_get "$CFG" 'hooks.PreToolUse.0.hooks.0.command')" "$ALT/hooks/guard-irreversible.sh"
check "config.toml still parses"      "$(toml_ok "$CFG" && echo yes || echo no)" "yes"

echo
echo "codex install — nothing escaped the temp dirs"
HOME="$REAL_HOME"
check "the real ~/.codex gained no new entries"  "$(real_fp "$HOME/.codex")"  "$REAL_CODEX_BEFORE"
check "the real ~/.claude gained no new entries" "$(real_fp "$HOME/.claude")" "$REAL_CLAUDE_BEFORE"
check "the real ~/.codex/config.toml was never touched (mtime + size)" "$(real_cfg_stamp)" "$REAL_CFG_BEFORE"

echo
if [ "$FAIL" -eq 0 ]; then
  printf '\033[32m%s passed, 0 failed\033[0m\n' "$PASS"
else
  printf '\033[31m%s passed, %s FAILED\033[0m\n' "$PASS" "$FAIL"
  exit 1
fi

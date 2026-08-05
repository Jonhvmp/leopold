#!/usr/bin/env bash
# Behavior tests for the gstack extension's harness port (extensions/gstack/manage.sh).
#
# HERMETIC. HOME, CLAUDE_HOME and CODEX_HOME all point inside a temp dir (so the
# checkout resolves there too), PATH is rebuilt from scratch, and `git` is a stub
# that "clones" a local
# fixture. Nothing here reaches the network, needs Bun, or writes into the developer's
# real ~/.claude, ~/.codex or ~/.gstack.
#
# The fixture's ./setup is a faithful model of the ONLY thing this extension depends
# on in gstack's real setup — where it puts skills — read out of garrytan/gstack's
# `setup` line by line:
#   --host claude : dirname(<repo>) when the checkout sits in a `skills/` dir,
#                   else it symlinks the checkout into $HOME/.claude/skills and
#                   installs there.
#   --host codex  : always $HOME/.codex/skills, and it MIGRATES a checkout that
#                   lives at $HOME/.codex/skills/gstack out to ~/.gstack/repos/gstack.
#   both are built from $HOME, never from CLAUDE_HOME/CODEX_HOME — which is exactly
#   why manage.sh has to mirror into the resolved skills root.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANAGE="$ROOT/extensions/gstack/manage.sh"

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  \033[32mok\033[0m   %s\n' "$*"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "$*"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want [$3], got [$2])"; fi; }
has()  { if printf '%s' "$2" | grep -q -- "$3"; then ok "$1"; else bad "$1"; fi; }
hasnt(){ if printf '%s' "$2" | grep -q -- "$3"; then bad "$1"; else ok "$1"; fi; }
isdir(){ if [ -d "$2" ]; then ok "$1"; else bad "$1 ($2 missing)"; fi; }
nodir(){ if [ -e "$2" ]; then bad "$1 ($2 exists)"; else ok "$1"; fi; }

# Names only, like the other extension suites: a live agent session writing its own
# state must not fail the run. An escaped write shows up as a NEW entry.
real_fp() { ls -A "$1" 2>/dev/null | sort | cksum; }
CLAUDE_BEFORE="$(real_fp "$HOME/.claude")"
CODEX_BEFORE="$(real_fp "$HOME/.codex")"
GSTACK_BEFORE="$(real_fp "$HOME/.gstack")"
REAL_HOME="$HOME"

TD="$(mktemp -d)"
trap 'rm -rf "$TD"' EXIT
STUB="$TD/bin"; FIX="$TD/fixture"
mkdir -p "$STUB" "$FIX"

# --- the gstack fixture -------------------------------------------------------
for s in spec qa ship; do
  mkdir -p "$FIX/$s"
  printf -- '---\nname: %s\n---\nfixture skill\n' "$s" > "$FIX/$s/SKILL.md"
done
printf -- '---\nname: gstack\n---\nfixture root skill\n' > "$FIX/SKILL.md"
cat > "$FIX/setup" <<'EOF'
#!/usr/bin/env bash
set -e
REPO_DIR="$(cd "$(dirname "$0")" && pwd -P)"
HOST=claude
while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --host=*) HOST="${1#--host=}"; shift ;;
    *) shift ;;
  esac
done
[ -n "${FIXTURE_SETUP_FAIL:-}" ] && { echo "fixture setup: forced failure" >&2; exit 1; }
echo "$HOST" >> "${FIXTURE_SETUP_LOG:-/dev/null}"
link_into() {
  d="$1"; mkdir -p "$d"
  for s in spec qa ship; do
    rm -rf "$d/$s"; mkdir -p "$d/$s"
    ln -snf "$REPO_DIR/$s/SKILL.md" "$d/$s/SKILL.md"
  done
}
case "$HOST" in
  claude)
    parent="$(dirname "$REPO_DIR")"
    if [ "$(basename "$parent")" = "skills" ]; then
      link_into "$parent"
    else
      mkdir -p "$HOME/.claude/skills"
      ln -snf "$REPO_DIR" "$HOME/.claude/skills/gstack"
      link_into "$HOME/.claude/skills"
    fi ;;
  codex)
    CODEX_SKILLS="$HOME/.codex/skills"
    if [ "$REPO_DIR" = "$CODEX_SKILLS/gstack" ]; then
      mkdir -p "$HOME/.gstack/repos"
      mv "$REPO_DIR" "$HOME/.gstack/repos/gstack"
      REPO_DIR="$HOME/.gstack/repos/gstack"
    fi
    mkdir -p "$CODEX_SKILLS"
    ln -snf "$REPO_DIR" "$CODEX_SKILLS/gstack"
    link_into "$CODEX_SKILLS" ;;
  *) echo "fixture setup: unknown host $HOST" >&2; exit 1 ;;
esac
EOF
chmod +x "$FIX/setup"

# --- stubs --------------------------------------------------------------------
cat > "$STUB/git" <<EOF
#!/usr/bin/env bash
case "\${1:-}" in
  clone)
    for a in "\$@"; do dest="\$a"; done
    mkdir -p "\$dest"
    cp -R "$FIX/." "\$dest/"
    mkdir -p "\$dest/.git" && echo fixture > "\$dest/.git/HEAD"
    ;;
  rev-parse) echo fixtur1 ;;
  pull) : ;;
  *) : ;;
esac
EOF
cat > "$STUB/bun" <<'EOF'
#!/usr/bin/env bash
echo "1.0.0-fixture"
EOF
chmod +x "$STUB"/*
for t in bash sh env grep sed awk cat cut head tail sort tr wc cp mv rm mkdir dirname basename \
         mktemp ls printf jq python3 chmod cksum timeout diff readlink ln find; do
  p="$(command -v "$t" 2>/dev/null)" && ln -sf "$p" "$STUB/$t"
done

# Every invocation below runs in this sealed environment.
run() { # <home> <claude-home> <codex-home> <harness> <cmd...>
  local home="$1" ch="$2" xh="$3" harness="$4"; shift 4
  env -i PATH="$STUB" HOME="$home" \
    CLAUDE_HOME="$ch" CODEX_HOME="$xh" LEOPOLD_HARNESS="$harness" \
    FIXTURE_SETUP_LOG="${FIXTURE_SETUP_LOG:-/dev/null}" \
    bash "$MANAGE" "$@" 2>&1
}

echo "gstack extension — harness port"

# =============================================================================
echo
echo "1. Codex-only machine (no ~/.claude anywhere), CODEX_HOME overridden"
# =============================================================================
H1="$TD/h1"; CH1="$TD/h1-claude"; XH1="$TD/h1-codex"
mkdir -p "$H1"
OUT="$(run "$H1" "$CH1" "$XH1" codex install)"
isdir "codex skills root created"                 "$XH1/skills"
isdir "gstack skills resolve under Codex skills"  "$XH1/skills/spec"
isdir "  ... all of them"                         "$XH1/skills/ship"
check "SKILL.md resolves to the checkout" \
      "$(readlink "$XH1/skills/spec/SKILL.md" | sed "s|$H1|<home>|")" "<home>/.gstack/repos/gstack/spec/SKILL.md"
nodir "nothing written to CLAUDE_HOME"            "$CH1"
nodir "nothing written to \$HOME/.claude"         "$H1/.claude"
has   "reports the harness by name"               "$OUT" "Codex CLI"
has   "says where it mirrored from"               "$OUT" "mirrored"
hasnt "never names Claude Code"                   "$OUT" "Claude Code"

OUT="$(run "$H1" "$CH1" "$XH1" codex status)"
has   "status names Codex CLI"                    "$OUT" "Codex CLI"
has   "status counts skills"                      "$OUT" "skills"
hasnt "status shows no zero count"                "$OUT" ": 0 skills"
OUT="$(run "$H1" "$CH1" "$XH1" codex doctor)"
has   "doctor names Codex CLI"                    "$OUT" "Codex CLI"
has   "doctor points at the Codex skills root"    "$OUT" "$XH1/skills"
run "$H1" "$CH1" "$XH1" codex detect && ok "detect true after install" || bad "detect true after install"

# idempotency: three installs, one checkout, same skill count
BEFORE="$(ls -A "$XH1/skills" | sort)"
run "$H1" "$CH1" "$XH1" codex install >/dev/null
run "$H1" "$CH1" "$XH1" codex install >/dev/null
check "install x3 leaves the same skills"         "$(ls -A "$XH1/skills" | sort)" "$BEFORE"
check "exactly one checkout"                      "$(find "$H1" -maxdepth 4 -name .git -type d | wc -l | tr -d ' ')" "1"

# =============================================================================
echo
echo "2. Codex with no CODEX_HOME override — gstack's native path, no mirror"
# =============================================================================
H2="$TD/h2"; mkdir -p "$H2"
OUT="$(run "$H2" "$TD/h2-claude" "$H2/.codex" codex install)"
isdir "skills land in \$HOME/.codex/skills"       "$H2/.codex/skills/spec"
hasnt "no mirror step needed"                     "$OUT" "mirrored"
has   "reports the count"                         "$OUT" "gstack skills in $H2/.codex/skills"

# =============================================================================
echo
echo "3. Claude-only machine — the historical layout is unchanged"
# =============================================================================
H3="$TD/h3"; CH3="$TD/h3-claude"; mkdir -p "$H3" "$CH3"
OUT="$(run "$H3" "$CH3" "$TD/h3-codex" claude install)"
isdir "checkout stays at CLAUDE_HOME/skills/gstack" "$CH3/skills/gstack"
isdir "skills installed next to it"                 "$CH3/skills/spec"
hasnt "no mirror for the Claude layout"             "$OUT" "mirrored"
nodir "nothing written to CODEX_HOME"               "$TD/h3-codex"
has   "reports Claude Code"                         "$OUT" "Claude Code"
hasnt "never names Codex"                           "$OUT" "Codex CLI"

# =============================================================================
echo
echo "4. Both harnesses — every one installed, every one reported"
# =============================================================================
H4="$TD/h4"; CH4="$TD/h4-claude"; XH4="$TD/h4-codex"; mkdir -p "$H4"
export FIXTURE_SETUP_LOG="$TD/h4-setup.log"; : > "$FIXTURE_SETUP_LOG"
OUT="$(run "$H4" "$CH4" "$XH4" all install)"
check "setup ran once per harness"                "$(sort "$FIXTURE_SETUP_LOG" | tr '\n' ' ')" "claude codex "
isdir "Claude Code got its skills"                "$CH4/skills/spec"
isdir "Codex CLI got its skills"                  "$XH4/skills/spec"
has   "install reports Claude Code"               "$OUT" "Claude Code"
has   "install reports Codex CLI"                 "$OUT" "Codex CLI"

OUT="$(run "$H4" "$CH4" "$XH4" all status)"
has   "status reports Claude Code"                "$OUT" "Claude Code:"
has   "status reports Codex CLI"                  "$OUT" "Codex CLI:"
has   "status carries the checkout revision"      "$OUT" "fixtur1"
hasnt "status has no zeroed harness"              "$OUT" ": 0 skills"
check "status is one line (the menu renders it inline)" "$(printf '%s' "$OUT" | wc -l | tr -d ' ')" "0"

OUT="$(run "$H4" "$CH4" "$XH4" all doctor)"
has   "doctor lists the Claude skills root"       "$OUT" "$CH4/skills"
has   "doctor lists the Codex skills root"        "$OUT" "$XH4/skills"

# remove clears both harnesses and the checkout
OUT="$(run "$H4" "$CH4" "$XH4" all remove)"
nodir "removed Claude Code's skills"              "$CH4/skills/spec"
nodir "removed Codex CLI's skills"                "$XH4/skills/spec"
nodir "removed the checkout"                      "$CH4/skills/gstack"
has   "remove reports Claude Code"                "$OUT" "Claude Code:"
has   "remove reports Codex CLI"                  "$OUT" "Codex CLI:"
run "$H4" "$CH4" "$XH4" all detect && bad "detect false after remove" || ok "detect false after remove"
unset FIXTURE_SETUP_LOG

# =============================================================================
echo
echo "5. A harness that fails to install is reported, never passed off as fine"
# =============================================================================
H5="$TD/h5"; CH5="$TD/h5-claude"; XH5="$TD/h5-codex"; mkdir -p "$H5"
OUT="$(env -i PATH="$STUB" HOME="$H5" CLAUDE_HOME="$CH5" CODEX_HOME="$XH5" \
        LEOPOLD_HARNESS=all FIXTURE_SETUP_FAIL=1 bash "$MANAGE" install 2>&1)"; RC=$?
check "install exits non-zero when a harness fails" "$RC" "1"
has   "says gstack setup failed"                    "$OUT" "gstack setup failed"
has   "names Claude Code in the failure"            "$OUT" "Claude Code: gstack setup failed"
has   "names Codex CLI in the failure"              "$OUT" "Codex CLI: gstack setup failed"

# =============================================================================
echo
echo "6. A leftover skill dir pointing at a checkout that is gone is not 'installed'"
# =============================================================================
H6="$TD/h6"; XH6="$TD/h6-codex"; mkdir -p "$H6" "$XH6/skills/spec"
ln -snf "$TD/deleted-checkout/spec/SKILL.md" "$XH6/skills/spec/SKILL.md"
run "$H6" "$TD/h6-claude" "$XH6" codex detect && bad "detect false on a dangling skill" || ok "detect false on a dangling skill"
has "status counts it as zero" "$(run "$H6" "$TD/h6-claude" "$XH6" codex status)" "Codex CLI: 0 skills"

# =============================================================================
echo
echo "8. Issue #48 — partial coverage must not read as \"gstack detected\""
# =============================================================================
# The exact reproduction: gstack installed under Claude Code only, then both
# harnesses targeted. `detect` says yes (it asks "is gstack on this machine"), and
# install.sh used to print "gstack detected" and skip setup — leaving Codex with
# nothing. `detect-all` asks the question the installer actually needs.
H8="$TD/h8"; CH8="$TD/h8-claude"; XH8="$TD/h8-codex"
mkdir -p "$H8" "$CH8" "$XH8"
run "$H8" "$CH8" "$XH8" claude install >/dev/null 2>&1

check "Claude sees the skills"  "$(run "$H8" "$CH8" "$XH8" claude status | grep -o 'Claude Code: [0-9]* skills')" "Claude Code: 4 skills"
check "Codex sees none"         "$(run "$H8" "$CH8" "$XH8" codex  status | grep -o 'Codex CLI: [0-9]* skills')"   "Codex CLI: 0 skills"

# Targeting BOTH is where the two questions diverge.
run "$H8" "$CH8" "$XH8" all detect >/dev/null 2>&1 \
  && ok "detect still says gstack is on the machine" \
  || bad "detect should still succeed — it answers a different question"
run "$H8" "$CH8" "$XH8" all detect-all >/dev/null 2>&1 \
  && bad "detect-all must FAIL while Codex has no gstack" \
  || ok "detect-all fails on partial coverage"
check "missing names the uncovered harness" "$(run "$H8" "$CH8" "$XH8" all missing | paste -sd, -)" "Codex CLI"

# And the repair the installer now performs is idempotent and covers both.
run "$H8" "$CH8" "$XH8" all install >/dev/null 2>&1
run "$H8" "$CH8" "$XH8" all detect-all >/dev/null 2>&1 \
  && ok "after the repair, detect-all passes" \
  || bad "the repair did not cover every harness"
check "missing is empty once repaired" "$(run "$H8" "$CH8" "$XH8" all missing | paste -sd, -)" ""
check "Codex now sees the skills" "$(run "$H8" "$CH8" "$XH8" codex status | grep -o 'Codex CLI: [0-9]* skills')" "Codex CLI: 4 skills"

# A checkout that no harness links to covers nobody — detect-all must not be fooled
# by the clone existing on disk.
H9="$TD/h9"; CH9="$TD/h9-claude"; XH9="$TD/h9-codex"
mkdir -p "$H9" "$CH9" "$XH9" "$H9/.gstack/repos/gstack/.git"
run "$H9" "$CH9" "$XH9" all detect-all >/dev/null 2>&1 \
  && bad "detect-all must not pass on a checkout no harness can see" \
  || ok "a checkout alone does not count as coverage"

# =============================================================================
echo
echo "7. The developer's real homes were never touched"
# =============================================================================
check "HOME unchanged"        "$HOME" "$REAL_HOME"
check "the real ~/.claude untouched"   "$(real_fp "$HOME/.claude")"  "$CLAUDE_BEFORE"
check "the real ~/.codex untouched"    "$(real_fp "$HOME/.codex")"   "$CODEX_BEFORE"
check "the real ~/.gstack untouched"   "$(real_fp "$HOME/.gstack")"  "$GSTACK_BEFORE"

echo
if [ "$FAIL" -eq 0 ]; then printf '\033[32mall %d checks passed\033[0m\n' "$PASS"; exit 0
else printf '\033[31m%d/%d checks failed\033[0m\n' "$FAIL" "$((PASS+FAIL))"; exit 1; fi

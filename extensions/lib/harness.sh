#!/usr/bin/env bash
# Leopold — shared harness wiring helper.
#
# Leopold runs on more than one agent harness, and every harness wants the same
# hook declared in a different file format: Claude Code reads JSON out of
# ~/.claude/settings.json, Codex CLI reads TOML out of ~/.codex/config.toml.
# The format-specific writer lives HERE and only here. Four extensions plus the
# two installers call it; nobody pastes a TOML writer into their own install.sh.
# That duplication is exactly how the two harnesses silently drift apart.
#
# Contract for every writer (the one scripts/install-codex.sh proved in the field):
#   1. back the target up before touching it            (<file>.<tag>.bak)
#   2. write into a temp file, never in place
#   3. idempotent — wiring the same hook N times leaves exactly one entry
#   4. VALIDATE the result before it lands
#   5. on invalid output: leave the original alone, print the block the user can
#      paste by hand, return non-zero. Never leave a config the harness cannot read.
#
# Usage:
#   . "$(dirname "${BASH_SOURCE[0]}")/../lib/harness.sh"
#   leo_wire_hooks leopold-enhance "UserPromptSubmit||python3 $DIR/enhance.py --event user-prompt|30"
#
# A hook spec is a single pipe-delimited string:  EVENT|MATCHER|COMMAND|TIMEOUT
# MATCHER and TIMEOUT may be empty. EVENT, COMMAND and TIMEOUT must not contain a
# literal "|" (hook commands are an interpreter plus a path plus flags — they
# never do). MATCHER MAY contain "|" — both harnesses read matchers as regex, so
# alternation ("mcp__.*|WebFetch") is a legitimate matcher; the parser anchors
# EVENT at the front and COMMAND|TIMEOUT at the back and gives MATCHER the rest.

# ---- homes ------------------------------------------------------------------

leo_claude_home() { printf '%s\n' "${CLAUDE_HOME:-$HOME/.claude}"; }
leo_codex_home()  { printf '%s\n' "${CODEX_HOME:-$HOME/.codex}"; }
leo_settings_file() { printf '%s\n' "$(leo_claude_home)/settings.json"; }
leo_config_file()   { printf '%s\n' "$(leo_codex_home)/config.toml"; }

# The asset home: hooks, templates, extensions. Stays under ~/.claude whenever
# Claude Code is in play so existing installs keep working without a migration;
# a Codex-only machine gets its own. Mirrors install.sh — keep the two in step.
leo_asset_home() {
  if [ -n "${LEOPOLD_HOME:-}" ]; then printf '%s\n' "$LEOPOLD_HOME"; return; fi
  case " $(leo_harness_targets) " in
    *" claude "*) printf '%s\n' "$(leo_claude_home)/leopold" ;;
    *)            printf '%s\n' "$(leo_codex_home)/leopold" ;;
  esac
}

# An extension's data home: its engine plus whatever state it keeps.
#
# ONE directory for the whole machine, deliberately independent of which harness
# is being wired. These payloads hold user-level state — the enhancer's on/off
# switch and learned profile, ovmem's committed-transcript offsets and access log —
# and that state is about the USER, not about the agent they happened to open. A
# per-harness dir would give one person two contradictory answers and two
# half-learned profiles.
#
# Resolution order (mirrored EXACTLY by payload/enhance.py and payload/ovmem.py —
# keep the three in step), where <claude> is CLAUDE_HOME or ~/.claude and <codex>
# is CODEX_HOME or ~/.codex:
#   1. LEOPOLD_HOME/<name>   the documented asset-home override
#   2. an existing install   <claude>/<name>, else <codex>/<name>
#   3. an existing home      <claude>, else <codex>
#   4. <claude>/<name>       the historical default, so a fresh Claude box is unchanged
# Claude first at every step: an existing ~/.claude install must never be migrated.
# Each caller layers its own explicit override (LEOPOLD_ENHANCE_DIR, LEOPOLD_OVMEM_DIR)
# on top, for installers and hermetic tests.
_leo_data_dir() { # <name>
  local n="${1:?_leo_data_dir: name}"
  if [ -n "${LEOPOLD_HOME:-}" ]; then printf '%s\n' "$LEOPOLD_HOME/$n"; return; fi
  local c x; c="$(leo_claude_home)"; x="$(leo_codex_home)"
  if [ -d "$c/$n" ]; then printf '%s\n' "$c/$n"; return; fi
  if [ -d "$x/$n" ]; then printf '%s\n' "$x/$n"; return; fi
  if [ -d "$c" ]; then printf '%s\n' "$c/$n"; return; fi
  if [ -d "$x" ]; then printf '%s\n' "$x/$n"; return; fi
  printf '%s\n' "$c/$n"
}

# The prompt enhancer's data home: engine, state.json, learned profile, ledger.
leo_enhance_dir() {
  if [ -n "${LEOPOLD_ENHANCE_DIR:-}" ]; then printf '%s\n' "$LEOPOLD_ENHANCE_DIR"; return; fi
  _leo_data_dir enhance
}

# ovmem's data home: engine, cleanup, dashboard, per-session commit offsets.
leo_ovmem_dir() {
  if [ -n "${LEOPOLD_OVMEM_DIR:-}" ]; then printf '%s\n' "$LEOPOLD_OVMEM_DIR"; return; fi
  _leo_data_dir ovmem
}

# ---- harness resolution -----------------------------------------------------

# Which harnesses to wire, honoring LEOPOLD_HARNESS (auto|claude|codex|all).
# "auto" takes whatever is actually on this machine; if neither is, Claude Code
# is assumed so a fresh box still ends in a usable state.
leo_harness_targets() {
  local want="${LEOPOLD_HARNESS:-auto}" claude=0 codex=0
  case "$want" in
    claude|claude-code) claude=1 ;;
    codex|openai)       codex=1 ;;
    all|both)           claude=1; codex=1 ;;
    auto)
      if command -v claude >/dev/null 2>&1 || [ -d "$(leo_claude_home)" ]; then claude=1; fi
      if command -v codex  >/dev/null 2>&1 || [ -d "$(leo_codex_home)"  ]; then codex=1;  fi
      if [ "$claude" = 0 ] && [ "$codex" = 0 ]; then claude=1; fi
      ;;
    *) echo "harness.sh: unknown LEOPOLD_HARNESS \"$want\" (use: auto, claude, codex, all)" >&2; return 2 ;;
  esac
  local out=""
  if [ "$claude" = 1 ]; then out="claude"; fi
  if [ "$codex"  = 1 ]; then out="${out:+$out }codex"; fi
  printf '%s\n' "$out"
}

leo_has_harness() { case " $(leo_harness_targets) " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

# Human label for a harness id — one spelling, used by every script that reports.
leo_harness_label() {
  case "$1" in claude) printf 'Claude Code\n' ;; codex) printf 'Codex CLI\n' ;; *) printf '%s\n' "$1" ;; esac
}

# ---- skills ------------------------------------------------------------------

# Where a harness discovers skills. Same SKILL.md format on both, different root:
# Claude Code reads <claude>/skills, Codex CLI reads <codex>/skills (verified on
# codex-cli 0.146.0 — install.sh and scripts/install-codex.sh already ship Leopold's
# own skills to exactly these two paths). One writer for the path so an extension
# never has to spell a harness home itself.
leo_skills_dir() { # <harness>
  case "$1" in
    claude) printf '%s\n' "$(leo_claude_home)/skills" ;;
    codex)  printf '%s\n' "$(leo_codex_home)/skills" ;;
    *) return 1 ;;
  esac
}

# ---- project memory file ----------------------------------------------------

# The per-project memory file each harness actually reads. Claude Code reads
# CLAUDE.md; Codex CLI reads AGENTS.md and does NOT read CLAUDE.md — verified on
# codex-cli 0.146.0 by dropping both files in a temp project and running
# `codex debug prompt-input`: only the AGENTS.md text reaches the model. Both
# harnesses generate their own file with the same `/init` command.
leo_memory_file() { # <harness>
  case "$1" in claude) printf 'CLAUDE.md\n' ;; codex) printf 'AGENTS.md\n' ;; *) return 1 ;; esac
}

# Every memory file wanted on this machine, in harness order. Two harnesses means
# two files: neither reads the other's, so writing only one silently half-informs
# the agent the user happens to open.
leo_memory_files() {
  local h out=""
  for h in $(leo_harness_targets); do out="${out:+$out }$(leo_memory_file "$h")"; done
  printf '%s\n' "$out"
}

# ---- dispatcher -------------------------------------------------------------

# leo_wire_hooks <tag> <spec>...
# Writes the same hooks into every resolved harness, in that harness's format.
# Returns non-zero if ANY target failed (and says which) — a half-wired install
# that reports success is the one failure mode this cannot have.
leo_wire_hooks() {
  local tag="${1:?leo_wire_hooks: tag}"; shift
  local rc=0 h
  for h in $(leo_harness_targets); do
    case "$h" in
      claude) leo_wire_hooks_json "$(leo_settings_file)" "$tag" "$@" || rc=1 ;;
      codex)  leo_wire_hooks_toml "$(leo_config_file)"   "$tag" "$@" || rc=1 ;;
    esac
  done
  return $rc
}

# ---- internals --------------------------------------------------------------

# Field extraction honoring the format comment up top: EVENT is everything before
# the first "|", COMMAND and TIMEOUT are the last two fields, and MATCHER is the
# whole middle rejoined — so a regex-alternation matcher ("mcp__.*|WebFetch")
# survives the pipe delimiter. A plain 4-field spec parses exactly as before.
_leo_spec_field() { # <spec> <1-based index: 1 EVENT, 2 MATCHER, 3 COMMAND, 4 TIMEOUT>
  printf '%s' "$1" | awk -F'|' -v i="$2" '{
    if (i == 1)      printf "%s", $1
    else if (i == 3) printf "%s", $(NF-1)
    else if (i == 4) printf "%s", $NF
    else { m = ""; for (f = 2; f <= NF-2; f++) m = m (f > 2 ? "|" : "") $f; printf "%s", m }
  }'
}

_leo_say()  { printf '   %s\n' "$*"; }
_leo_warn() { printf '   warn: %s\n' "$*" >&2; }

# ---- JSON (Claude Code settings.json) ---------------------------------------

# Renders the hooks as a settings.json fragment, for the manual-paste path.
leo_hooks_json_block() {
  local spec ev m cmd t
  echo '{'
  echo '  "hooks": {'
  local first=1
  for spec in "$@"; do
    ev="$(_leo_spec_field "$spec" 1)"; m="$(_leo_spec_field "$spec" 2)"
    cmd="$(_leo_spec_field "$spec" 3)"; t="$(_leo_spec_field "$spec" 4)"
    if [ "$first" != 1 ]; then echo ','; fi
    first=0
    printf '    "%s": [{%s"hooks": [{"type": "command", "command": "%s"%s}]}]' \
      "$ev" "${m:+\"matcher\": \"$m\", }" "$cmd" "${t:+, \"timeout\": $t}"
  done
  echo
  echo '  }'
  echo '}'
}

# leo_wire_hooks_json <settings.json> <tag> <spec>...
leo_wire_hooks_json() {
  local file="${1:?}" tag="${2:?}"; shift 2
  if ! command -v jq >/dev/null 2>&1; then
    _leo_warn "jq not found — add this to $file by hand:"
    leo_hooks_json_block "$@" | sed 's/^/     /'
    return 1
  fi

  mkdir -p "$(dirname "$file")"
  [ -f "$file" ] || echo '{}' > "$file"
  local bak="$file.$tag.bak"
  cp "$file" "$bak"

  local tmp cur spec ev m cmd t
  tmp="$(mktemp)"; cur="$(mktemp)"
  cp "$file" "$cur"

  for spec in "$@"; do
    ev="$(_leo_spec_field "$spec" 1)"; m="$(_leo_spec_field "$spec" 2)"
    cmd="$(_leo_spec_field "$spec" 3)"; t="$(_leo_spec_field "$spec" 4)"
    if ! jq --arg ev "$ev" --arg m "$m" --arg cmd "$cmd" --arg t "$t" '
      .hooks //= {} | .hooks[$ev] //= []
      # add only when this exact command is not already declared for the event
      | (if any(.hooks[$ev][]?.hooks[]?; .command == $cmd) then .
         else .hooks[$ev] += [
           (if $m == "" then {} else {matcher: $m} end)
           + {hooks: [ {type: "command", command: $cmd}
                       + (if $t == "" then {} else {timeout: ($t | tonumber)} end) ]}
         ] end)
      # keep an already-wired entry in step with the timeout we ship now
      | .hooks[$ev] |= map(.hooks |= map(
          if .command == $cmd and $t != "" then .timeout = ($t | tonumber) else . end))
    ' "$cur" > "$tmp" 2>/dev/null; then
      _leo_warn "the merged $file would not be valid JSON — leaving your settings untouched."
      _leo_warn "add this by hand:"
      leo_hooks_json_block "$@" | sed 's/^/     /'
      rm -f "$tmp" "$cur"
      return 1
    fi
    mv "$tmp" "$cur"; tmp="$(mktemp)"
  done

  if ! jq -e . "$cur" >/dev/null 2>&1; then
    _leo_warn "the merged $file would not be valid JSON — leaving your settings untouched."
    leo_hooks_json_block "$@" | sed 's/^/     /'
    rm -f "$tmp" "$cur"
    return 1
  fi

  mv "$cur" "$file"; rm -f "$tmp"
  # Paranoia: if anything downstream corrupted the landed file, put the backup back.
  if ! jq -e . "$file" >/dev/null 2>&1; then
    cp "$bak" "$file"
    _leo_warn "$file did not survive the write — restored from $bak"
    return 1
  fi
  _leo_say "hooks -> $file (backup at $bak)"
}

# ---- TOML (Codex CLI config.toml) -------------------------------------------

# TOML basic strings: only backslash and double quote need escaping for the
# values we write (absolute paths and flags).
_leo_toml_str() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

# The managed block is marker-delimited so a re-install replaces it EXACTLY and a
# hand-written config is never reformatted. TOML has no merge tool we can rely on
# being present, so we edit text and then validate.
# Tag "leopold" keeps the original markers: existing installs must be replaced,
# not shadowed by a second block.
_leo_toml_begin() { if [ "$1" = leopold ]; then echo "# >>> leopold (managed) >>>"; else echo "# >>> leopold:$1 (managed) >>>"; fi; }
_leo_toml_end()   { if [ "$1" = leopold ]; then echo "# <<< leopold (managed) <<<"; else echo "# <<< leopold:$1 (managed) <<<"; fi; }

# leo_hooks_toml_block <tag> <spec>...
# Set LEO_TOML_COMMENT to prepend explanatory "# ..." lines inside the block.
leo_hooks_toml_block() {
  local tag="${1:?}"; shift
  local spec ev m cmd t
  _leo_toml_begin "$tag"
  if [ -n "${LEO_TOML_COMMENT:-}" ]; then printf '%s\n\n' "$LEO_TOML_COMMENT"; fi
  for spec in "$@"; do
    ev="$(_leo_spec_field "$spec" 1)"; m="$(_leo_spec_field "$spec" 2)"
    cmd="$(_leo_spec_field "$spec" 3)"; t="$(_leo_spec_field "$spec" 4)"
    echo "[[hooks.$ev]]"
    if [ -n "$m" ]; then echo "matcher = \"$(_leo_toml_str "$m")\""; fi
    echo ""
    echo "[[hooks.$ev.hooks]]"
    echo "type = \"command\""
    echo "command = \"$(_leo_toml_str "$cmd")\""
    if [ -n "$t" ]; then echo "timeout = $t"; fi
    echo ""
  done
  _leo_toml_end "$tag"
}

# Can we actually parse TOML on this machine? macOS without the Xcode CLT ships no
# python3 at all, and Python < 3.11 has no tomllib — on those boxes every write below
# lands unvalidated, so nothing here may DEPEND on validation to stay correct.
_leo_toml_can_validate() {
  command -v python3 >/dev/null 2>&1 || return 1
  python3 -c 'import tomllib' >/dev/null 2>&1
}

# Say it once, out loud, when we are about to write TOML we cannot check. A silent
# unvalidated write is exactly the kind of "looks like success" this must not do.
_leo_toml_note_no_validation() { # <file>
  _leo_toml_can_validate && return 0
  [ -n "${LEO_TOML_NOVALIDATE_SAID:-}" ] && return 0
  LEO_TOML_NOVALIDATE_SAID=1
  _leo_warn "no python3 with tomllib here — writing $1 without a TOML syntax check."
  _leo_warn "Leopold's own edits stay idempotent without it (marker- and header-matched),"
  _leo_warn "and a backup is written next to the file before every change."
}

_leo_toml_validate() { # <file> -> 0 ok, 1 broken, 0 (skipped) when no tomllib
  command -v python3 >/dev/null 2>&1 || return 0
  python3 - "$1" <<'PY'
import sys
try:
    import tomllib
except ModuleNotFoundError:      # Python < 3.11: skip validation rather than fail the install
    sys.exit(0)
with open(sys.argv[1], "rb") as fh:
    tomllib.load(fh)
PY
}

# leo_wire_hooks_toml <config.toml> <tag> <spec>...
leo_wire_hooks_toml() {
  local file="${1:?}" tag="${2:?}"; shift 2
  local begin end
  begin="$(_leo_toml_begin "$tag")"; end="$(_leo_toml_end "$tag")"

  mkdir -p "$(dirname "$file")"
  [ -f "$file" ] || : > "$file"
  _leo_toml_note_no_validation "$file"
  local bak="$file.$tag.bak"
  cp "$file" "$bak"

  local tmp; tmp="$(mktemp)"
  # Drop any previous block for this tag — that is what makes a re-install idempotent.
  #
  # The block's own leading blank line goes with it. Every block is appended with one
  # blank line in front, so lifting one out of the MIDDLE of the file used to leave
  # that blank behind while the fresh copy brought a new one: config.toml grew by an
  # empty line on every single re-install, forever. Blank lines anywhere else —
  # including inside a multi-line TOML string — are buffered and re-emitted exactly
  # as found, so this only ever touches the gap the removed block leaves.
  awk -v b="$begin" -v e="$end" '
    function flush(  i) { for (i = 1; i <= nb; i++) print ""; nb = 0 }
    $0 == b          { nb = 0; skip = 1; next }   # drop the blank(s) that led into it
    $0 == e          { skip = 0; next }
    skip             { next }
    /^[[:space:]]*$/ { nb++; next }
    { flush(); print }
    END { flush() }
  ' "$file" > "$tmp"

  # Trim trailing blank lines, then append the fresh block.
  awk 'BEGIN{n=0} {lines[NR]=$0}
       END{last=NR; while (last>0 && lines[last] ~ /^[[:space:]]*$/) last--;
           for(i=1;i<=last;i++) print lines[i]}' "$tmp" > "$tmp.trim" && mv "$tmp.trim" "$tmp"

  {
    if [ -s "$tmp" ]; then echo ""; fi
    leo_hooks_toml_block "$tag" "$@"
  } >> "$tmp"

  if ! _leo_toml_validate "$tmp" 2>/dev/null; then
    _leo_warn "the merged $file would not parse as TOML — leaving your config untouched."
    _leo_warn "add this to $file by hand:"
    leo_hooks_toml_block "$tag" "$@" | sed 's/^/     /'
    rm -f "$tmp"
    return 1
  fi

  mv "$tmp" "$file"
  if ! _leo_toml_validate "$file" 2>/dev/null; then
    cp "$bak" "$file"
    _leo_warn "$file did not survive the write — restored from $bak"
    return 1
  fi
  _leo_say "hooks -> $file (backup at $bak)"
}

# ---- project permissions / trust --------------------------------------------
#
# The per-project "stop asking me about routine work" knob. Each harness spells it
# differently and both spellings live HERE, next to the hook writers, for the same
# reason: two copies of the same wiring is how the harnesses drift apart.
#   Claude Code  <project>/.claude/settings.json  -> .permissions.allow[]
#   Codex CLI    ~/.codex/config.toml             -> [projects."<path>"] trust_level
# Same contract as the hook writers: back up, write to a temp file, idempotent,
# validate, roll back rather than leave something the harness cannot read.

# The allowlist Leopold seeds for routine dev work. The git lock still denies
# commit/push during a run, so being generous here is safe.
leo_project_allow_json() {
  cat <<'JSON'
[
  "Read(*)","Grep(*)","Glob(*)",
  "Bash(git status:*)","Bash(git diff:*)","Bash(git log:*)","Bash(git add:*)","Bash(git show:*)","Bash(git branch:*)","Bash(git fetch:*)",
  "Bash(ls:*)","Bash(cat:*)","Bash(rg:*)","Bash(find:*)","Bash(tree:*)","Bash(pwd)","Bash(echo:*)",
  "Bash(npm run:*)","Bash(npm test:*)","Bash(npm ci:*)","Bash(npm install:*)","Bash(pnpm:*)","Bash(yarn:*)","Bash(npx:*)",
  "Bash(node:*)","Bash(tsc:*)","Bash(make:*)","Bash(python3:*)","Bash(pytest:*)","Bash(cargo:*)","Bash(go:*)"
]
JSON
}

# leo_seed_permissions_json <project-dir>
# Merges the allowlist into <project>/.claude/settings.json. Merge, never clobber.
leo_seed_permissions_json() {
  local proj="${1:?leo_seed_permissions_json: project dir}"
  local file="$proj/.claude/settings.json"
  if ! command -v jq >/dev/null 2>&1; then
    _leo_warn "jq not found — skipping the Claude Code allowlist in $file"
    return 1
  fi
  mkdir -p "$proj/.claude"
  [ -f "$file" ] || echo '{}' > "$file"
  local bak="$file.leopold.bak" tmp
  cp "$file" "$bak"
  tmp="$(mktemp)"
  if ! jq --argjson add "$(leo_project_allow_json)" '
        .permissions = (.permissions // {})
        | .permissions.allow = ((.permissions.allow // []) + $add | unique)
      ' "$file" > "$tmp" 2>/dev/null; then
    _leo_warn "could not merge the allowlist into $file — leaving it untouched"
    rm -f "$tmp"; return 1
  fi
  mv "$tmp" "$file"
  if ! jq -e . "$file" >/dev/null 2>&1; then
    cp "$bak" "$file"
    _leo_warn "$file did not survive the write — restored from $bak"
    return 1
  fi
  _leo_say "permissions -> $file ($(jq '.permissions.allow | length' "$file") allow rules, backup at $bak)"
}

# _leo_toml_project_trust <config.toml> <project-path> -> the project's current
# trust_level, or nothing when it has no entry.
_leo_toml_project_trust() {
  command -v python3 >/dev/null 2>&1 || return 0
  python3 - "$1" "$2" <<'PY' 2>/dev/null
import sys
try:
    import tomllib
except ModuleNotFoundError:      # Python < 3.11: treat as "unknown", the caller appends
    sys.exit(0)
try:
    with open(sys.argv[1], "rb") as fh:
        d = tomllib.load(fh)
except Exception:
    sys.exit(0)
p = d.get("projects", {}).get(sys.argv[2])
if isinstance(p, dict) and p.get("trust_level"):
    print(p["trust_level"])
PY
}

# _leo_toml_has_project_table <config.toml> <project-path> -> 0 when the file already
# declares [projects."<path>"].
#
# This is the idempotency guard that does NOT need python3. TOML forbids declaring the
# same table twice, so appending a second [projects."<path>"] header makes Codex unable
# to parse its own config — and on a box without tomllib the validate-and-roll-back net
# is not there to catch it. The literal header is an exact test: the closing `"]` means
# a longer path can never contain a shorter one's header as a substring.
_leo_toml_has_project_table() {
  [ -f "$1" ] || return 1
  grep -qF -- "[projects.\"$(_leo_toml_str "$2")\"]" "$1"
}

# leo_trust_project_toml <config.toml> <project-path>
# Marks the project trusted for Codex, in the exact shape Codex writes itself:
#   [projects."/abs/path"]
#   trust_level = "trusted"
# Idempotent (an existing entry is left alone) and it never rewrites a trust level
# the user already chose — overriding somebody's own decision is not ours to make.
leo_trust_project_toml() {
  local file="${1:?}" proj="${2:?}" cur
  mkdir -p "$(dirname "$file")"
  [ -f "$file" ] || : > "$file"

  if ! _leo_toml_validate "$file" 2>/dev/null; then
    _leo_warn "$file does not parse as TOML — not touching it. Add this by hand:"
    printf '     [projects."%s"]\n     trust_level = "trusted"\n' "$(_leo_toml_str "$proj")" >&2
    return 1
  fi

  cur="$(_leo_toml_project_trust "$file" "$proj")"
  if [ "$cur" = "trusted" ]; then
    _leo_say "project already trusted in $file"
    return 0
  fi
  if [ -n "$cur" ]; then
    _leo_warn "$file already sets trust_level = \"$cur\" here — leaving your choice alone"
    return 0
  fi

  # No trust level came back: either the project genuinely has no entry, or tomllib is
  # not installed and _leo_toml_project_trust could not tell us. The table header is the
  # authority either way — appending a second [projects."<path>"] is what breaks the file.
  if _leo_toml_has_project_table "$file" "$proj"; then
    _leo_say "project already has a [projects.\"...\"] entry in $file — leaving it alone"
    _leo_say "(if Codex still asks about this project, add trust_level = \"trusted\" under it)"
    return 0
  fi

  _leo_toml_note_no_validation "$file"

  # Its own backup name: the hook writer owns "<file>.leopold.bak", and `leopold up`
  # calls both in one breath — sharing the name would throw away the pre-install copy.
  local bak="$file.leopold-trust.bak" tmp
  cp "$file" "$bak"
  tmp="$(mktemp)"
  cp "$file" "$tmp"
  {
    if [ -s "$tmp" ]; then echo ""; fi
    printf '[projects."%s"]\n' "$(_leo_toml_str "$proj")"
    printf 'trust_level = "trusted"\n'
  } >> "$tmp"

  if ! _leo_toml_validate "$tmp" 2>/dev/null; then
    _leo_warn "the merged $file would not parse as TOML — leaving your config untouched. Add by hand:"
    printf '     [projects."%s"]\n     trust_level = "trusted"\n' "$(_leo_toml_str "$proj")" >&2
    rm -f "$tmp"; return 1
  fi
  mv "$tmp" "$file"
  if ! _leo_toml_validate "$file" 2>/dev/null; then
    cp "$bak" "$file"
    _leo_warn "$file did not survive the write — restored from $bak"
    return 1
  fi
  _leo_say "project trust -> $file (backup at $bak)"
}

# leo_seed_project_permissions <project-dir>
# The dispatcher: seeds whatever each harness on this machine needs, in its own
# format. Non-zero if ANY target failed, and it says which.
leo_seed_project_permissions() {
  local proj="${1:?}" rc=0 h
  for h in $(leo_harness_targets); do
    case "$h" in
      claude) leo_seed_permissions_json "$proj" || rc=1 ;;
      codex)  leo_trust_project_toml "$(leo_config_file)" "$proj" || rc=1 ;;
    esac
  done
  return $rc
}

# ---- unwiring ---------------------------------------------------------------
#
# The mirror of the writers above, and here for the same reason: an extension
# that can install into two harnesses must be able to REMOVE itself from two
# harnesses, and the moment each one hand-rolls that we are back to two copies
# of the format knowledge drifting apart.

# leo_unwire_hooks_json <settings.json> <tag> <command-regex>
# Drops every hook whose command matches the regex, then prunes the entries and
# events left empty. Same contract as the writer: back up, temp file, validate,
# roll back rather than land something Claude Code cannot read.
leo_unwire_hooks_json() {
  local file="${1:?}" tag="${2:?}" re="${3:?}"
  [ -f "$file" ] || return 0
  command -v jq >/dev/null 2>&1 || { _leo_warn "jq not found — remove the hooks matching /$re/ from $file by hand."; return 1; }

  local bak="$file.$tag.bak" tmp
  cp "$file" "$bak"
  tmp="$(mktemp)"
  if ! jq --arg re "$re" '
    if .hooks then .hooks |= ( to_entries
      | map(.value |= ( map(.hooks |= map(select((.command // "") | test($re) | not)))
                        | map(select((.hooks | length) > 0)) ))
      | map(select((.value | length) > 0))
      | from_entries ) else . end
  ' "$file" > "$tmp" 2>/dev/null || ! jq -e . "$tmp" >/dev/null 2>&1; then
    _leo_warn "unwiring would not produce valid JSON — leaving $file untouched."
    rm -f "$tmp"; return 1
  fi
  mv "$tmp" "$file"
  _leo_say "hooks removed from $file (backup at $bak)"
}

# leo_unwire_hooks_toml <config.toml> <tag>
# Deletes the tag's managed block. Nothing else in the file is touched, which is
# exactly why the writer delimits it with markers in the first place.
leo_unwire_hooks_toml() {
  local file="${1:?}" tag="${2:?}" begin end bak tmp
  [ -f "$file" ] || return 0
  begin="$(_leo_toml_begin "$tag")"; end="$(_leo_toml_end "$tag")"
  grep -qF "$begin" "$file" 2>/dev/null || return 0

  bak="$file.$tag.bak"
  cp "$file" "$bak"
  tmp="$(mktemp)"
  awk -v b="$begin" -v e="$end" '
    $0 == b { skip = 1; next }
    $0 == e { skip = 0; next }
    !skip   { print }
  ' "$file" > "$tmp"
  if ! _leo_toml_validate "$tmp" 2>/dev/null; then
    _leo_warn "unwiring would not produce valid TOML — leaving $file untouched."
    rm -f "$tmp"; return 1
  fi
  mv "$tmp" "$file"
  _leo_say "hooks removed from $file (backup at $bak)"
}

# ---- persona guard ----------------------------------------------------------
#
# The persona module's hook-level navigation bound (hooks/persona-guard.sh):
# while a persona run is active, MCP navigation is checked against the active
# flow's domain allowlist AT THE HOOK, on both harnesses — verified live against
# claude 2.1.235 and codex-cli 0.147.0 (docs/reference/persona-guard-hooks.md:
# PreToolUse fires for `mcp__<server>__<tool>` calls with the same payload and
# deny contract on both). The conductor wires this at persona-run start and
# unwires it at run end, so the hook exists in a harness config ONLY while a
# run is active; the hook itself additionally no-ops without an active
# `.leopold/persona/ACTIVE.json`, so a stale wire can never bound a normal
# session. Spelled here, next to the other writers, because the wire/unwire
# pair IS format knowledge — an extension or the driver calling anything more
# specific than these two functions is how the harnesses drift.

LEO_PERSONA_GUARD_TAG="leopold-persona-guard"

# The matcher routes BOTH navigation surfaces the hook judges: MCP tool calls
# (`mcp__<server>__<tool>`) and the built-in WebFetch — the alternation was part
# of the live verification (docs/reference/persona-guard-hooks.md, the deny
# probe ran with `mcp__.*|WebFetch`). A matcher that names only `mcp__.*` would
# leave the hook's WebFetch branch reachable by no production wiring: an
# off-allowlist WebFetch during an active run would sail past the hook layer.
leo_wire_persona_guard() { # <absolute path to persona-guard.sh>
  local hook="${1:?leo_wire_persona_guard: hook path}"
  leo_wire_hooks "$LEO_PERSONA_GUARD_TAG" "PreToolUse|mcp__.*|WebFetch|bash $hook|5"
}

leo_unwire_persona_guard() {
  local rc=0 h
  for h in $(leo_harness_targets); do
    case "$h" in
      claude) leo_unwire_hooks_json "$(leo_settings_file)" "$LEO_PERSONA_GUARD_TAG" 'persona-guard\.sh' || rc=1 ;;
      codex)  leo_unwire_hooks_toml "$(leo_config_file)"   "$LEO_PERSONA_GUARD_TAG" || rc=1 ;;
    esac
  done
  return $rc
}

# ---- MCP servers ------------------------------------------------------------
#
# Both harnesses ship an MCP registry and both drive it from their own CLI, with
# different flags: Claude Code needs an explicit `--scope user`, Codex is global
# by default and writes [mcp_servers.<name>] into config.toml (verified against
# codex-cli 0.146.0, CODEX_HOME honored). One place knows that difference.

# Is the harness's own CLI available to talk to its registry?
leo_mcp_cli() { # <harness>
  case "$1" in
    claude) command -v claude >/dev/null 2>&1 && printf 'claude\n' ;;
    codex)  command -v codex  >/dev/null 2>&1 && printf 'codex\n'  ;;
    *) return 1 ;;
  esac
}

# leo_mcp_present <harness> <name> — 0 when registered.
# `codex mcp get <missing>` and `claude mcp get <missing>` both exit non-zero.
leo_mcp_present() {
  local cli; cli="$(leo_mcp_cli "$1")" || return 1
  [ -n "$cli" ] || return 1
  "$cli" mcp get "$2" >/dev/null 2>&1
}

# leo_mcp_add <harness> <name> <command> [args...]
# Idempotent by construction: `claude mcp add` errors on a duplicate, so the
# caller checks leo_mcp_present first; `codex mcp add` replaces the entry in
# place. Both are safe to call after that check.
leo_mcp_add() {
  local h="${1:?}" name="${2:?}"; shift 2
  local cli; cli="$(leo_mcp_cli "$h")" || return 1
  [ -n "$cli" ] || return 1
  case "$h" in
    claude) claude mcp add --scope user "$name" -- "$@" >/dev/null 2>&1 ;;
    codex)  codex  mcp add "$name" -- "$@" >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
}

# The exact command a user would run by hand — printed whenever the CLI is not
# on PATH, so "couldn't register it" is never a dead end.
leo_mcp_add_cmd() { # <harness> <name> <command> [args...]
  local h="${1:?}" name="${2:?}"; shift 2
  case "$h" in
    claude) printf 'claude mcp add --scope user %s -- %s\n' "$name" "$*" ;;
    codex)  printf 'codex mcp add %s -- %s\n' "$name" "$*" ;;
    *) return 1 ;;
  esac
}

leo_mcp_remove() { # <harness> <name>
  local cli; cli="$(leo_mcp_cli "$1")" || return 1
  [ -n "$cli" ] || return 1
  case "$1" in
    claude) claude mcp remove "$2" -s user >/dev/null 2>&1 ;;
    codex)  codex  mcp remove "$2"        >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
}

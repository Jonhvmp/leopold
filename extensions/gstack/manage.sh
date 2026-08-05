#!/usr/bin/env bash
# gstack extension - install/manage the gstack skill suite that Leopold conducts.
# gstack is a separate MIT project by Garry Tan: https://github.com/garrytan/gstack
#
# HARNESS PARITY. gstack's skills are plain SKILL.md dirs, and both harnesses Leopold
# runs on discover them the same way — Claude Code under <claude>/skills, Codex CLI
# under <codex>/skills. So this extension installs into EVERY harness resolved on this
# machine and reports each one separately. A Codex-only box gets gstack where Codex
# looks for it, and never a single byte under ~/.claude.
#
# Verified against gstack @ garrytan/gstack (setup, read line by line) — we drive its
# own installer rather than reimplementing it, so upgrades keep working:
#   - `./setup --host claude|codex` installs for exactly one harness; re-running is
#     idempotent (symlinks are refreshed with `ln -snf`, dirs with `mkdir -p`).
#   - the Claude host installs into dirname(<repo>) when the clone sits inside a
#     `skills/` dir, and falls back to $HOME/.claude/skills otherwise.
#   - the Codex host always writes $HOME/.codex/skills, and REFUSES a clone that
#     lives inside that dir — it migrates it to ~/.gstack/repos/gstack to avoid
#     duplicate skill discovery. That is why a Codex-only install clones there.
#   - both paths are built from $HOME, not from CLAUDE_HOME/CODEX_HOME. When those
#     are overridden (tests, split homes) we mirror what setup produced into the
#     resolved skills root and SAY so — an override must not silently install
#     nothing where the harness is actually looking.
#   - non-interactive setup defaults to flat skill names (/spec, /qa) and saves the
#     choice, so the second host's run does not prompt again.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$HERE/../lib/harness.sh"
[ -f "$LIB" ] || { echo "gstack/manage.sh: missing $LIB — reinstall Leopold." >&2; exit 1; }
# shellcheck source=../lib/harness.sh
. "$LIB"

REPO="https://github.com/garrytan/gstack.git"
# gstack's own home for a checkout that must not live inside a skills dir (its
# `migrate_direct_codex_install` target). Reusing it keeps us aligned with the
# upstream tool instead of inventing a second location it knows nothing about.
MIGRATED_REPO="$HOME/.gstack/repos/gstack"

say()  { printf '\033[36m->\033[0m %s\n' "$*"; }
ok()   { printf '   \033[32mok\033[0m   %s\n' "$*"; }
warn() { printf '   \033[33mwarn\033[0m %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

# ---- where things live -------------------------------------------------------

# The gstack checkout. Any existing clone wins (never move a working install);
# otherwise Claude Code's skills dir when Claude is in play — the historical
# location, so nothing changes for an existing install — and gstack's own
# out-of-skills home on a Codex-only machine.
gstack_repo() {
  if [ -n "${LEOPOLD_GSTACK_DIR:-}" ]; then printf '%s\n' "$LEOPOLD_GSTACK_DIR"; return; fi
  local c x
  c="$(leo_skills_dir claude)/gstack"
  x="$(leo_skills_dir codex)/gstack"
  if [ -d "$c/.git" ]; then printf '%s\n' "$c"; return; fi
  if [ -d "$MIGRATED_REPO/.git" ]; then printf '%s\n' "$MIGRATED_REPO"; return; fi
  if [ -d "$x/.git" ]; then printf '%s\n' "$x"; return; fi
  if leo_has_harness claude; then printf '%s\n' "$c"; else printf '%s\n' "$MIGRATED_REPO"; fi
}

# Where gstack's own setup writes for a harness, as opposed to where THIS machine's
# harness home says the skills belong. The two differ only when CLAUDE_HOME/CODEX_HOME
# is overridden; see the header.
native_skills_dir() { # <harness> <repo>
  case "$1" in
    claude)
      if [ "$(basename "$(dirname "$2")")" = "skills" ]; then dirname "$2"
      else printf '%s\n' "$HOME/.claude/skills"; fi ;;
    codex) printf '%s\n' "$HOME/.codex/skills" ;;
  esac
}

# Does this skills-dir entry belong to gstack? Answered by where it POINTS, not by
# its name: gstack renames its skills (flat /spec vs namespaced /gstack-spec) from
# saved config, so a hardcoded name list would miss half of them on one machine and
# all of them on another. The name check is only the fallback for gstack's Windows
# copy mode, where there is no symlink to follow.
entry_is_gstack() { # <entry> <repo-real-path>
  local e="$1" root="$2" t=""
  if [ -L "$e" ]; then t="$(readlink "$e")"
  elif [ -L "$e/SKILL.md" ]; then t="$(readlink "$e/SKILL.md")"
  fi
  case "$t" in "$root"|"$root"/*) return 0 ;; esac
  case "$(basename "$e")" in gstack|gstack-*) [ -e "$e/SKILL.md" ] || [ -L "$e" ] ;; *) return 1 ;; esac
}

# How many gstack skills a directory holds.
count_gstack() { # <skills-dir> <repo-real-path>
  local d="$1" root="$2" e n=0
  [ -d "$d" ] || { echo 0; return; }
  for e in "$d"/*; do
    { [ -e "$e" ] || [ -L "$e" ]; } || continue
    entry_is_gstack "$e" "$root" && n=$((n+1))
  done
  echo "$n"
}

repo_real() { # <repo> -> resolved path, or the literal path when it does not exist yet
  [ -d "$1" ] && (cd "$1" && pwd -P) || printf '%s\n' "$1"
}

harness_count() { # <harness> -> gstack skills visible to that harness
  count_gstack "$(leo_skills_dir "$1")" "$(repo_real "$(gstack_repo)")"
}

# ---- install -----------------------------------------------------------------

# Copy what setup produced into the skills root this machine actually resolves.
# Symlinks are preserved (they are absolute, into the checkout, so they stay valid).
mirror_skills() { # <from> <to> <repo-real> -> count on stdout
  local from="$1" to="$2" root="$3" e n=0
  [ -d "$from" ] || { echo 0; return; }
  mkdir -p "$to"
  for e in "$from"/*; do
    { [ -e "$e" ] || [ -L "$e" ]; } || continue
    entry_is_gstack "$e" "$root" || continue
    rm -rf "${to:?}/$(basename "$e")"
    cp -RP "$e" "$to/" || continue
    n=$((n+1))
  done
  echo "$n"
}

setup_for() { # <harness>
  local h="$1" label repo root native want n
  label="$(leo_harness_label "$h")"
  repo="$(gstack_repo)"
  say "$label: running gstack setup (--host $h)"
  if ! ( cd "$repo" && ./setup --host "$h" ); then
    warn "$label: gstack setup failed — no skills installed for this harness"
    return 1
  fi
  # setup may have migrated the checkout out of the Codex skills dir; re-resolve.
  repo="$(gstack_repo)"; root="$(repo_real "$repo")"
  native="$(native_skills_dir "$h" "$repo")"
  want="$(leo_skills_dir "$h")"
  if [ "$native" != "$want" ]; then
    n="$(mirror_skills "$native" "$want" "$root")"
    say "$label: gstack installs into $native; mirrored $n skills into $want"
  fi
  n="$(count_gstack "$want" "$root")"
  if [ "$n" -gt 0 ]; then
    ok "$label: $n gstack skills in $want"
  else
    warn "$label: no gstack skills landed in $want"
    return 1
  fi
}

do_install() { # install|update
  local mode="${1:-install}" repo h failed=0 targets
  targets="$(leo_harness_targets)"
  repo="$(gstack_repo)"

  if [ -d "$repo/.git" ]; then
    if [ "$mode" = update ]; then
      say "pulling gstack in $repo"
      ( cd "$repo" && git pull --ff-only -q ) || { warn "git pull failed — keeping the current checkout"; }
    else
      ok "gstack checkout already at $repo"
    fi
  elif [ "$mode" = update ]; then
    echo "gstack is not installed as a git clone; nothing to update. Run install."
    return 0
  else
    have bun || warn "gstack needs Bun v1.0+ (https://bun.sh) — its setup will fail without it."
    say "cloning gstack into $repo (shows progress; a few seconds)"
    mkdir -p "$(dirname "$repo")"
    git clone --progress --single-branch --depth 1 "$REPO" "$repo" \
      || { warn "clone failed"; return 1; }
  fi

  for h in $targets; do
    setup_for "$h" || failed=1
  done
  echo
  if [ "$failed" = 0 ]; then
    ok "gstack ready on: $(for h in $targets; do printf '%s ' "$(leo_harness_label "$h")"; done)"
  else
    warn "gstack is not complete on every harness — see the warnings above (bun installed?)"
    return 1
  fi
}

do_remove() {
  local repo root h label want native n d e
  repo="$(gstack_repo)"; root="$(repo_real "$repo")"
  for h in $(leo_harness_targets); do
    label="$(leo_harness_label "$h")"
    want="$(leo_skills_dir "$h")"; native="$(native_skills_dir "$h" "$repo")"
    n=0
    for d in "$want" "$native"; do
      [ -d "$d" ] || continue
      for e in "$d"/*; do
        { [ -e "$e" ] || [ -L "$e" ]; } || continue
        [ "$e" = "$repo" ] && continue          # the checkout itself goes last
        entry_is_gstack "$e" "$root" || continue
        rm -rf "$e"; n=$((n+1))
      done
      [ "$native" = "$want" ] && break
    done
    echo "$label: removed $n gstack skills"
  done
  if [ -d "$repo" ]; then rm -rf "${repo:?}"; echo "removed $repo"; else echo "no gstack checkout to remove."; fi
}

# ---- commands ----------------------------------------------------------------

case "${1:-}" in
  detect)
    # installed if the checkout exists, or if any resolved harness already sees its skills
    if [ -d "$(gstack_repo)" ]; then exit 0; fi
    for h in $(leo_harness_targets); do [ "$(harness_count "$h")" -gt 0 ] && exit 0; done
    exit 1
    ;;

  detect-all)
    # Is gstack usable from EVERY resolved harness? `detect` answers "is gstack on this
    # machine at all", which is the right question for the menu but the wrong one for
    # the installer: a checkout linked into Codex only makes `detect` succeed while
    # Claude sees nothing, and the installer then skips setup and calls it detected.
    # Deliberately ignores the checkout — a clone nobody's skills dir points at covers
    # no harness.
    for h in $(leo_harness_targets); do [ "$(harness_count "$h")" -gt 0 ] || exit 1; done
    exit 0
    ;;

  missing)
    # The resolved harnesses that cannot see gstack, one label per line (empty = none).
    # Lets a caller name them instead of reporting a vague "incomplete".
    for h in $(leo_harness_targets); do
      [ "$(harness_count "$h")" -gt 0 ] || leo_harness_label "$h"
    done
    ;;

  status)
    # One line (the menu renders it inline), but never one harness's truth passed off
    # as the machine's: every resolved harness gets its own segment.
    repo="$(gstack_repo)"
    if [ -d "$repo/.git" ]; then printf '%s' "$(cd "$repo" && git rev-parse --short HEAD 2>/dev/null || echo present)"
    elif [ -d "$repo" ]; then printf 'present'
    else printf 'no checkout'; fi
    for h in $(leo_harness_targets); do
      printf ' · %s: %s skills' "$(leo_harness_label "$h")" "$(harness_count "$h")"
    done
    echo
    ;;

  install) do_install install ;;
  update)  do_install update ;;
  remove)  do_remove ;;

  doctor)
    repo="$(gstack_repo)"; root="$(repo_real "$repo")"
    echo "repo: $([ -d "$repo" ] && echo "$repo" || echo "missing ($repo)")"
    echo "bun:  $(have bun && bun --version 2>/dev/null || echo "not found (needed for setup)")"
    for h in $(leo_harness_targets); do
      want="$(leo_skills_dir "$h")"; n="$(count_gstack "$want" "$root")"
      echo "$(leo_harness_label "$h"):"
      if [ "$n" -gt 0 ]; then
        echo "  skills: $n in $want"
      else
        echo "  skills: none in $want — run: bash $HERE/manage.sh install"
      fi
    done
    ;;

  *)
    echo "usage: manage.sh {detect|status|install|update|remove|doctor}" >&2
    exit 2
    ;;
esac

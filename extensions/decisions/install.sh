#!/usr/bin/env bash
# decisions installer — the OPTIONAL typed-judgement seam.
#
# WHAT IT INSTALLS, and where. Three files into ONE machine-wide directory
# (leo_decisions_dir): the shell seam the hooks call, and the two DERIVED files it needs —
# the catalog schema and the provider templates, both generated from the driver's own
# TypeScript and pinned to it by tests, so nothing here is a second hand-written copy.
#
# WHAT IT DOES NOT INSTALL. No hooks. This extension wires nothing into settings.json or
# config.toml: the consumers that use it are the driver (which imports the seam directly) and
# hooks that are already wired by the core installer. There is therefore no `settings.write`
# capability on it, and removing it cannot leave a broken harness config behind.
#
# CONFIGURATION IS PER PROJECT. Which provider is active, and its descriptor, go in
# `<project>/.leopold/decisions/config.json` — because what a project asks a model is a property
# of that project, not of this machine. Run from a project directory (as `make menu` does) and
# the installer offers to seed it.
#
# THE KEY IS NEVER WRITTEN. The descriptor names an environment variable (`auth_env`); the value
# lives in your shell, is read at call time, and touches no file this script creates.
#
# Headless: LEOPOLD_DECISIONS_PROVIDER=jev ./install.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$HERE/../lib/harness.sh"
[ -f "$LIB" ] || { echo "decisions/install.sh: missing $LIB — reinstall Leopold." >&2; exit 1; }
# shellcheck source=../lib/harness.sh
. "$LIB"

DEC_DIR="$(leo_decisions_dir)"
say() { printf '\033[1;36m[decisions]\033[0m %s\n' "$*"; }

command -v jq >/dev/null 2>&1 || { say "jq is required (the seam is curl + jq) — install it and re-run"; exit 1; }
command -v curl >/dev/null 2>&1 || { say "curl is required — install it and re-run"; exit 1; }

# The two derived files live with the driver in a checkout, and beside this script in an
# installed asset tree. Look in both, and say which was used.
find_asset() { # <basename>
  local n="$1"
  for c in "$HERE/payload/$n" "$HERE/../../packages/driver/src/decisions/$n" "$(leo_asset_home)/packages/driver/src/decisions/$n"; do
    [ -f "$c" ] && { printf '%s\n' "$c"; return 0; }
  done
  return 1
}

SCHEMA_SRC="$(find_asset catalog.schema.json)" || { say "cannot find catalog.schema.json — regenerate it: (cd packages/driver && node --import tsx scripts/gen-decisions-assets.mjs)"; exit 1; }
PROVIDERS_SRC="$(find_asset providers.json)"   || { say "cannot find providers.json — regenerate it: (cd packages/driver && node --import tsx scripts/gen-decisions-assets.mjs)"; exit 1; }

mkdir -p "$DEC_DIR"
install -m 0755 "$HERE/payload/decisions.sh" "$DEC_DIR/decisions.sh"
install -m 0644 "$SCHEMA_SRC"    "$DEC_DIR/catalog.schema.json"
install -m 0644 "$PROVIDERS_SRC" "$DEC_DIR/providers.json"
[ -f "$HERE/payload/RUNTIME.md" ] && install -m 0644 "$HERE/payload/RUNTIME.md" "$DEC_DIR/README.md"
say "payload installed in $DEC_DIR"

# ---- per-project configuration -------------------------------------------------------------
PROJECT_LEO="${LEOPOLD_PROJECT_DIR:-$PWD}/.leopold"
if [ ! -d "$PROJECT_LEO" ]; then
  say "no .leopold/ here — run this from a project (or /leopold-brief first) to choose a provider"
  exit 0
fi

CONFIG="$PROJECT_LEO/decisions/config.json"
CHOICES="$(jq -r '.providers | keys_unsorted | join(" ")' "$DEC_DIR/providers.json")"

PICK="${LEOPOLD_DECISIONS_PROVIDER:-}"
if [ -z "$PICK" ]; then
  if [ -t 0 ] || [ -r /dev/tty ]; then
    say "providers: $CHOICES"
    printf '  active provider (empty = leave unconfigured): ' >&2
    read -r PICK < /dev/tty || PICK=""
  fi
fi
[ -n "$PICK" ] || { say "left unconfigured — every consumer keeps its deterministic path"; exit 0; }

jq -e --arg p "$PICK" '.providers | has($p)' "$DEC_DIR/providers.json" >/dev/null 2>&1 || {
  say "unknown provider \"$PICK\" — choose one of: $CHOICES"
  exit 1
}

mkdir -p "$(dirname "$CONFIG")"
if [ -f "$CONFIG" ]; then
  # UPDATE, never clobber: keep every descriptor the project already had, and switch the
  # active one. A re-run must not discard an operator's edited endpoint or timeout.
  TMP="$(mktemp)"
  jq -S --arg p "$PICK" --slurpfile t "$DEC_DIR/providers.json" '
    .provider = $p
    | .version = ($t[0].version)
    | .providers = ((.providers // {}) | if has($p) then . else . + { ($p): $t[0].providers[$p] } end)' \
    "$CONFIG" > "$TMP" && mv "$TMP" "$CONFIG"
  say "active provider set to $PICK in $CONFIG (existing descriptors kept)"
else
  jq -S -n --arg p "$PICK" --slurpfile t "$DEC_DIR/providers.json" '
    { version: $t[0].version, provider: $p, providers: { ($p): $t[0].providers[$p] } }' > "$CONFIG"
  say "wrote $CONFIG"
fi

AUTH_ENV="$(jq -r --arg p "$PICK" '.providers[$p].auth_env' "$DEC_DIR/providers.json")"
MODEL="$(jq -r --arg p "$PICK" '.providers[$p].model // ""' "$DEC_DIR/providers.json")"
[ -n "$MODEL" ] || say "note: \"$PICK\" ships no default model — pin one in $CONFIG before it can answer"
if [ -z "$(eval printf '%s' "\${$AUTH_ENV:-}")" ]; then
  say "note: $AUTH_ENV is not set in this shell — the seam will fall back until it is"
else
  say "$AUTH_ENV is set (its value is never written anywhere)"
fi

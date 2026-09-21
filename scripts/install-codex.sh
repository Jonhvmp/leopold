#!/usr/bin/env bash
# Leopold installer — Codex CLI side.
#
# Codex reimplemented Claude Code's hook contract, field for field. PreToolUse
# carries the same `tool_name` / `tool_input` / `cwd` keys (its shell tool is even
# reported as "Bash") and honors the same
# {"hookSpecificOutput":{"permissionDecision":"deny",…}} reply; Stop carries `cwd`,
# `transcript_path` and `stop_hook_active` and honors {"decision":"block","reason":…}.
# So EVERY one of Leopold's hooks — the git lock, the autonomous continuity engine and
# the permission policy — is the same script here. This installer only has to put the
# skills where Codex looks and declare the hooks in TOML instead of JSON. What the
# permission policy costs on Codex (the deny half is honored, the allow half is not) is
# the matrix's business, not this installer's: hooks/hook-matrix.tsv carries it.
#
# The one thing that differs: Codex holds a config-declared hook untrusted until you
# approve it once. Until then the hooks are inert in interactive sessions. Headless
# workers started by `leopold run --provider codex` arm themselves.
#
# Usage: install-codex.sh <source-tree> <leopold-asset-home>
set -euo pipefail

SRC="${1:?usage: install-codex.sh <source-tree> <leopold-asset-home>}"
LEO_HOME="${2:?usage: install-codex.sh <source-tree> <leopold-asset-home>}"
CODEX="${CODEX_HOME:-$HOME/.codex}"
SKILLS="$CODEX/skills"
CONFIG="$CODEX/config.toml"
GUARD="$LEO_HOME/hooks/guard-irreversible.sh"
STOP="$LEO_HOME/hooks/stop-continuity.sh"

# The TOML/JSON writers live in ONE place (extensions/lib/harness.sh) so this
# installer and the four extensions cannot drift apart.
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/extensions/lib/harness.sh"
[ -f "$LIB" ] || { echo "install-codex.sh: missing $LIB" >&2; exit 1; }
# shellcheck source=../extensions/lib/harness.sh
. "$LIB"

echo "-> installing Leopold into Codex ($CODEX)"
mkdir -p "$SKILLS"

for d in "$SRC"/skills/*/; do
  name="$(basename "$d")"
  rm -rf "${SKILLS:?}/$name"
  cp -R "$d" "$SKILLS/$name"
done
echo "   skills -> $SKILLS"

if [ ! -f "$GUARD" ] || [ ! -f "$STOP" ]; then
  echo "   warn: hooks not found under $LEO_HOME/hooks — skipping the hook wiring."
  exit 0
fi
chmod +x "$GUARD" "$STOP" "$LEO_HOME/hooks/permission-policy.sh" 2>/dev/null || true

# --- wire the core hooks into config.toml ----------------------------------
# One managed, marker-delimited block: idempotent, backed up, validated, and
# rolled back rather than left unparseable. See extensions/lib/harness.sh.
# shellcheck disable=SC2034  # read by leo_wire_hooks_toml (extensions/lib/harness.sh)
LEO_TOML_COMMENT="# Leopold. Every hook here is a no-op unless a Leopold run is active in the
# project (.leopold/state.json), so they are safe to leave installed. Re-run the
# Leopold installer to update; anything you edit between the markers gets replaced.
#
# 1. Git lock: denies git commit / git push during an autonomous run.
# 2. Continuity: blocks the stop and re-injects the next plan item until the
#    plan is done or a stop condition fires.
# 3. Permission policy: answers a permission prompt for the session conducting
#    the run, repeating the git lock's deny verbatim. On Codex only the deny half
#    is honored (--approve-for-me), which is the half that carries the git lock."

# The specs are leo_core_hook_specs' — the SAME list install.sh hands to the JSON
# writer — read line by line so an asset home with a space in its path survives.
CORE_SPECS=()
while IFS= read -r spec; do
  if [ -n "$spec" ]; then CORE_SPECS+=("$spec"); fi
done < <(leo_core_hook_specs "$LEO_HOME")

if ! leo_wire_hooks_toml "$CONFIG" leopold "${CORE_SPECS[@]}"; then
  echo "   warn: could not wire the hooks — Codex skills are installed, hooks are not."
  echo "         Paste the block above into $CONFIG and re-run: leopold doctor"
  exit 0
fi

# Report what LANDED, never what was asked for. The writer exits 0 in two cases that
# are not "all wired": every spec refused by hooks/hook-matrix.tsv (a refusal is an
# answer, not a failure), and a partially refused list. Announcing the git lock from
# the argument list instead of from the writer's own count is exactly the "no-op that
# reads as success" this project bans — on its core promise, no less.
if [ "${LEO_WIRED_COUNT:-0}" -eq 0 ]; then
  echo "   warn: NOT ONE Leopold hook was declared in $CONFIG — the git lock is NOT armed here."
  echo "         refused for Codex: ${LEO_REFUSED_EVENTS:-(none — see the warnings above)}"
  echo "         re-run the Leopold installer, then check: leopold doctor"
  exit 0
fi
echo "   $LEO_WIRED_COUNT hooks -> $CONFIG  ($LEO_WIRED_EVENTS)"
if [ -n "${LEO_REFUSED_EVENTS:-}" ]; then
  echo "   not wired here (Codex does not fire them): $LEO_REFUSED_EVENTS"
fi

# --- native agent roles: the driver's review lenses ---------------------------
# Codex has a role system Claude Code does not, so Leopold uses it: one role file per
# review lens under $CODEX_HOME/agents/, spawnable in any Codex session with
# spawn_agent(agent_type="leopold-lens-<lens>"). The writer, the lens list and what the
# probe proved about roles all live in extensions/lib/harness.sh — this installer only
# calls it and reports what landed.
LENS_SPECS=()
while IFS= read -r spec; do
  if [ -n "$spec" ]; then LENS_SPECS+=("$spec"); fi
done < <(leo_review_lens_specs)

if leo_write_codex_agent_roles "$CODEX" "${LENS_SPECS[@]}"; then
  echo "   ${LEO_ROLES_TOTAL:-0} review-lens roles -> $CODEX/agents  (${LEO_ROLES_WRITTEN:-0} written, $(( ${LEO_ROLES_TOTAL:-0} - ${LEO_ROLES_WRITTEN:-0} )) already current)"
  echo "   spawn one in a Codex session: spawn_agent(agent_type=\"leopold-lens-correctness\")"
  echo "   note: \`codex exec\` cannot run AS a role (probed) — headless lenses stay read-only via --sandbox"
else
  echo "   warn: the review-lens roles were not fully installed — see above, then re-run: leopold doctor"
fi

# --- trust ------------------------------------------------------------------
# Codex will not run a config-declared hook until you have trusted it once. That
# gate is deliberate and Leopold does not try to forge it: open Codex once and
# approve the Leopold hooks. Headless runs started by `leopold run --provider codex`
# pass --dangerously-bypass-hook-trust for their own workers, so the lock holds
# there from the first turn.
cat <<EOF

   One manual step: Codex holds new hooks untrusted until you approve them.
   Open Codex once in any project and accept the Leopold hooks — after that the
   git lock, autonomous continuity and the permission policy are live in
   interactive sessions too.
EOF

# decisions — typed, calibrated judgements, optional by construction

A capability that lets code ask a model a **typed** question — `choice`, `score`, `noul` —
and get back a decision with a probability distribution, instead of prose to parse.

**It is optional and it is meant to stay optional.** The core never calls a provider.
Every consumer keeps the deterministic path it already had, and that path is what runs
when the extension is absent, the key is missing, the network fails, or the answer's
confidence is below its floor. "Refine, never replace" is enforced by the compiler: the
seam's entry point takes the deterministic fallback as a **required** argument.

## Providers

| name | wire shape | calibrated | key |
| --- | --- | --- | --- |
| `jev` | System One (`api.typesafe.ai`), pinned `jev-1.13.0` | yes, trained | `TYPESAFE_API_KEY` |
| `openrouter` | chat-completions | **no** | `OPENROUTER_API_KEY` |
| `vercel` | chat-completions (AI Gateway) | **no** | `AI_GATEWAY_API_KEY` |
| `generic` | System One, any wire-compatible endpoint | operator-declared | yours |
| `none` | — | — | — |

`none` is always present and is the floor.

**Calibration is load-bearing, not a label.** A calibrated provider's probabilities are
optimised against outcomes; an uncalibrated one's are a concentration measure over tokens.
So a threshold fitted for one may never be reused for the other, and the catalog loader
refuses it by name. An uncalibrated provider must carry a catalog whose `thresholds_for`
names it.

## Layout

```
<machine>/decisions/          the tool
  decisions.sh                the shell seam (curl + jq, System One shape only)
  catalog.schema.json         GENERATED from the driver's constants
  providers.json              GENERATED from the driver's descriptors

<project>/.leopold/decisions/ what this project asks
  config.json                 the active provider and its descriptor
  <name>.json                 a question catalog, one per consumer
```

## manage.sh

`detect` (cheap, offline) · `status` (one line) · `install` / `update` (idempotent; also the
provider-switch path, which keeps descriptors you edited) · `remove` (takes back the payload,
**leaves your catalogs**) · `doctor`.

## The key

Never written, never printed, never logged, never an argv word. `curl` receives it through a
header file, because `ps` shows argv to every user on the machine. `status` and `doctor`
report whether the variable is set — never its value, which
`scripts/test-decisions-install.sh` proves by exporting a canary and searching every surface.

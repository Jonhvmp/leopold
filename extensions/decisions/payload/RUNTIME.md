# decisions — installed payload

Three files, installed machine-wide:

| file | what it is |
| --- | --- |
| `decisions.sh` | the shell seam: `curl` + `jq`, System One wire shape only |
| `catalog.schema.json` | the catalog schema, GENERATED from the driver's own constants |
| `providers.json` | the provider templates the installer offers, GENERATED from the driver's descriptors |

Both generated files are pinned to their TypeScript sources by tests
(`packages/driver/test/decisions-contract.test.ts`); regenerate with
`node --import tsx scripts/gen-decisions-assets.mjs` in `packages/driver`.

## What lives here, and what lives in your project

This directory is a TOOL and is machine-wide. What your project **asks** — the question
catalogs and the bars it acts on — lives in `.leopold/decisions/` inside the project,
because that is a property of the project, not of the machine:

```
.leopold/decisions/
  config.json      which provider is active, and its descriptor
  routing.json     a question catalog (one per consumer)
```

## The key

Read from the environment variable the active provider's descriptor names (`auth_env`),
at call time. It is never written to disk, never printed, never logged, and never passed
as a command-line argument — `curl` receives it through a header file, because `ps` shows
argv to every user on the machine.

## Absent means today's behaviour

Remove this extension and every consumer falls back to the deterministic path it already
had. Your catalogs are left where they are.

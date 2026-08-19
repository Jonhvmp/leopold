# Roadmap

```mermaid
flowchart LR
    V01["v0.1 · in-session engine<br/><small>shipped</small>"] --> DRV["SDK driver<br/><small>shipped · alpha</small>"]
    DRV --> FAN["parallel waves<br/><small>shipped</small>"]
    FAN --> DASH["live dashboard<br/><small>shipped</small>"]
    DASH --> WF["dynamic-workflow engine<br/><small>shipped</small>"]
    WF --> ENH["prompt enhancer<br/><small>shipped · v0.11</small>"]
    ENH --> E2E["headless runtime E2E"]
    E2E --> SBX["sandboxed workers"]
    classDef done fill:#2a9d8f,stroke:#1b6b5f,color:#fff;
    class V01,DRV,FAN,DASH,WF,ENH done;
```

## Shipped

- [x] In-session engine: `/leopold-brief`, `/leopold-run`, `/leopold-status`,
      `/leopold-stop`
- [x] Stop hook (continuity) and PreToolUse hook (git lock), behavior-tested +
      red-teamed
- [x] Brief artifact templates and `install.sh` with idempotent settings merge
- [x] SDK driver (alpha): persistent conductor + fresh workers, conductor/worker
      status protocol, charter-grounded decisions, git-locked `canUseTool`,
      notifications — uses your Claude Code auth, no API key
- [x] `leopold doctor`, toolchain manager (`leopold menu`), `leopold up` (Phase 0)
- [x] **Parallel waves** — `run --parallel N`: dependency-aware scheduler, one
      worktree per item, staged-patch replay onto the main tree
- [x] **Live dashboard** — `leopold watch`: SSE event stream, cost meters, the
      decision log, and the native dynamic-workflow **phase tree**
- [x] **Dynamic-workflow engine** — `/leopold-workflow` (brief compiled into a
      workflow), `leopold workflow` (the compiler as tested code; `--run`
      experimental headless runtime), `/leopold-learn` (the self-improving
      charter + `learn_on_finish`), `/leopold-triage` (quarantined backlog
      triage), plan-by-tournament in the brief
- [x] **Quality panels in the driver** — diverse-lens review panel, root-cause
      hypothesis panel on retries, opt-in smart routing
- [x] **Hardcore CI** — CLI smoke of the built binary, shellcheck gate,
      macOS + Ubuntu matrix, npm provenance, Dependabot, CodeQL
- [x] **Persona testing (0.20–0.21)** — synthetic customers: evidence-grounded
      contract skills, `/leopold-persona`, and the driver-conducted harness
      (`leopold persona run` — journal-before-act, in-code bounds, the
      persona-guard hook proven live on both harnesses)
- [x] **Prompt enhancer (v0.11)** — global `UserPromptSubmit` hook: weak prompts
      get a charter-aware structured interpretation from Haiku on the user's own
      account (off by default, fail-open, anchor veto), `/leopold-enhance` with a
      ledger-mining learn loop that proposes prompt-profile rules

## Next

- [ ] Scheduled persona cadence (Claude Code scheduled tasks + Codex automations),
      gated on live verification of both schedulers
- [ ] End-to-end exercise of the experimental `workflow --run` query shim (a
      manual `workflow_dispatch` CI job with a real key — it spends tokens)
- [ ] Worker watchdog for turns that end without a status block
- [ ] Toolchain manager: acceptance-test the ovmem installer on a clean Linux
      box + macOS
- [ ] ovmem extension: fully-local Ollama/GGUF provider profile (no API key)
- [ ] gstack playbook router as first-class config
- [ ] Sandboxed workers (E2B / Daytona) for isolated parallel execution

Have an idea? Open an issue or a discussion on
[GitHub](https://github.com/Jonhvmp/leopold).

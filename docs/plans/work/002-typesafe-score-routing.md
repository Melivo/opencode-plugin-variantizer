# TypeSafe Score Routing

> Replace Choice routing with ordered Score routing, remove injected machine-context noise, and keep the visible OpenCode variant in sync.

**Status**: Completed
**Created**: 2026-09-17
**Owner**: orchestrate/session-20260917-221603

## Goal

Use TypeSafe Score for the ordered OpenAI reasoning-effort spectrum, always apply the highest-probability valid level without a confidence threshold, and preserve useful recent conversation while stripping only known injected orientation blocks.

## Context

The current six-way Choice frequently returns low confidence because adjacent reasoning efforts overlap and large injected Gortex orientation blocks can dominate short user requests. Official OpenAI documentation defines `none`, `low`, `medium`, `high`, `xhigh`, and `max`; TypeSafe documents Score for ordered descriptive levels.

## Constraints

- Keep `recent-messages`; do not switch to prompt-only.
- Strip only explicitly delimited known machine blocks and preserve surrounding user text.
- Choose argmax probabilities; lower effort wins exact ties.
- Keep deterministic fallback only for technical and invalid-response failures.
- Preserve privacy, Secret Service credentials, manual-first policy, runtime catalog validation, notifications and the single default plugin entry.
- Synchronize the actually applied variant into the OpenCode TUI through supported APIs; UI synchronization failures must not affect routing.
- No build, package, publish or live external API calls.

## Tasks

| # | Task | Agent | Priority | Status | Dependencies |
|---|------|-------|----------|--------|--------------|
| 1 | Implement Score routing and context filter | backend | 1 | DONE | - |
| 2 | Synchronize user documentation | docs | 2 | DONE | 1 |
| 3 | REFINE implementation | refactor | 2 | DONE | 1 |
| 4 | Independent final QA | qa | 3 | DONE | 1, 2, 3 |

## Done When

- [x] Score replaces Choice across runtime and SDK contracts.
- [x] Highest-probability level is always selected without a confidence gate; ties prefer lower effort.
- [x] Gortex Session Orientation blocks are removed without losing surrounding user content.
- [x] Recent user/assistant context remains enabled and bounded.
- [x] Technical fallbacks, privacy, credentials, notifications and manual policy remain correct.
- [x] The OpenCode UI reflects the actually applied variant best-effort without making routing depend on TUI availability.
- [x] Documentation is current.
- [x] Full tests and typecheck pass.

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-09-17 | Use Score with argmax probabilities | Reasoning effort is ordered; user explicitly rejected confidence gating. |
| 2026-09-17 | Keep recent-messages and filter known injected blocks | Preserve conversational context while removing machine noise. |
| 2026-09-17 | Treat missing `oma-coordination` as stale workflow reference | Installed `orchestrate` skill and shared protocols are present and define the active rules. |
| 2026-09-17 | Synchronize via `variant.cycle` | OpenCode 1.18.31 has separate request and TUI variant state; direct `tui.command.execute` publication is the supported synchronization surface. The legacy execute-command alias endpoint is a false-positive no-op for `variant.cycle`. |

## Progress Notes

- [2026-09-17] Plan created for session-20260917-221603.
- [2026-09-17] Scope extended to synchronize the applied variant into the OpenCode TUI after the stale-visible-variant bug was reconfirmed.
- [2026-09-18] Final independent QA passed with no findings; AC1-AC10, 66 test executions and TypeScript typecheck passed.

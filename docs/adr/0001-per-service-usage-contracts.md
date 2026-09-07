# ADR 0001: Per-service Usage Contracts

- Status: accepted
- Date: 2026-08-29

## Context

A service's row rules were scattered along module axes: parse rules in `usageTextParsers.ts`, row-shape rules in `usageFetcher.ts`, validity in `usageIntegrity.ts` / `usageFreshness.ts`, units in `usageNormalizer.ts`, display gates in `shared/`. Answering "what is a valid Cursor row?" required 10+ files across two processes. Qwen's clone-weekly invariant existed in three slightly different formulations. Every postmortem in `docs/qwen-usage.md` / `docs/cursor-usage.md` was some version of "a rule for service X lived in the wrong place, in three places, or only in the docs."

## Decision

One contract module per service under `src/main/serviceContracts/` (`cursor`, `qwen`, `grok`, `chatgpt`; all other services use a shared no-op default). Pipeline modules (`usageFetcher`, `refreshCoordinator`, `usageIntegrity`, `usageFreshness`, `usageNormalizer`) consult `getServiceContract(serviceId)` instead of branching on service ids. Rules both processes need live in `shared/` (`cursorUsage.ts`, `qwenUsage.ts`); `isQwenCloneWeeklyWindow` is the single canonical clone formulation.

## Consequences

- Adding a service's row rules = one new contract module; the pipeline stays generic.
- Contract methods are the test surface for row validity; existing smokes keep their import paths (integrity/freshness/normalizer re-export/delegate).
- The contract interface is intentionally all-optional; resist adding speculative members — add a method only when a second service needs the same hook.

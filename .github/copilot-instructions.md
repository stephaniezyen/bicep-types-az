# Copilot instructions for bicep-types-az

This repository tracks Bicep type and Resource Provider (RP) issues found during Bicep usage of Azure resource types. It is **not** the source of generation for those types — its job is issue tracking and triage.

## Hard rules

1. **Do not modify files under `generated/`.** That directory is sourced from elsewhere; hand edits will be overwritten.
2. **Authoritative source for "does this type/property exist?"** is the generated type definitions in the upstream repo [`Azure/bicep-types-az`](https://github.com/Azure/bicep-types-az) on `main`, under `generated/**/types.md`. This is what the triage engine verifies against — do not substitute the public `learn.microsoft.com` templates, which lag the generated types.

## How issue triage works in this repo

Issue triage is fully automated and **heuristic** — there is no LLM in the loop.

- **Workflow:** `.github/workflows/triage.yml` runs on issue `opened` / `edited` / `reopened`. It is a thin loader: it checks out the repo and uses `actions/github-script` to dynamic-import the engine and call `run({ github, context, core })`.
- **Engine:** `.github/scripts/triage.mjs` is the **single source of truth** for all triage logic. It:
  - classifies issues by regex/proximity heuristics into `missing property`, `type issue`, `type unavailable`, and `bug` buckets (respecting the issue-template "Issue Type" selection when present);
  - extracts the resource provider(s), resource type(s), API version, and candidate property name(s);
  - **verifies** named properties against the upstream `Azure/bicep-types-az` generated `types.md` for the relevant type/version (relabeling `missing property` → `property found` when the property actually exists);
  - applies/removes labels, normalizes issue titles, flags possible duplicates, and posts a single idempotent bot comment (marker `<!-- auto-triage-bot:v3 -->`).
- **Tests / CI:** the pure heuristics are exported from `triage.mjs` and unit-tested in `.github/scripts/triage.test.mjs` (`node --test`). `.github/workflows/triage-ci.yml` syntax-checks and smoke-tests the engine on any PR that touches it, so a broken export can't reach the live triage workflow.

To change triage behavior, **edit `.github/scripts/triage.mjs`** and add/adjust tests in `.github/scripts/triage.test.mjs`.

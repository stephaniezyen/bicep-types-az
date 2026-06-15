# Copilot instructions for bicep-types-az

This repository tracks Bicep type and Resource Provider (RP) issues found during Bicep usage of Azure resource types. It is **not** the source of generation for those types — its job is issue tracking and triage.

## Hard rules

1. **Do not modify files under `generated/`.** That directory is sourced from elsewhere; hand edits will be overwritten.
2. **Authoritative source for "does this type/property exist in Azure?"** is the public Azure template reference at `https://learn.microsoft.com/en-us/azure/templates`. Do not rely on this repo's `generated/` folder for that question.

## How issue triage works in this repo

Issue triage is fully automated by `.github/workflows/triage-on-open.yml` (per new issue) and `.github/workflows/triage-sweep.yml` (manual sweep). Both call a GitHub Models LLM with `.github/triage-playbook.md` as the system prompt, and a small orchestrator script at `.github/scripts/triage.mjs` applies the LLM's decisions. To change triage behavior, **edit `.github/triage-playbook.md`** — no code changes needed.

# Copilot instructions for bicep-types-az

This repository tracks Bicep type and Resource Provider (RP) issues found during Bicep usage of Azure resource types. It is **not** the source of generation for those types — its job is issue tracking and triage.

## Hard rules for every Copilot interaction in this repo

1. **Do not modify files under `generated/`.** That directory is sourced from elsewhere; hand edits will be overwritten and create noise.
2. **Authoritative source for "does this type/property exist in Azure?"** is the public Azure template reference at `https://learn.microsoft.com/en-us/azure/templates`. Do not rely on this repo's `generated/` folder for that question.
3. **When you are assigned to an issue, your task is triage** — apply labels and (only when the playbook tells you to) post a single comment. Read and follow `.github/triage-playbook.md` strictly. Do not improvise categories, do not invent labels, do not modify code, and do not open a PR.

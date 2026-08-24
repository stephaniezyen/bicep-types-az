# Auto-triage bot

This folder contains the automated issue-triage bot for this repository. It
reads every new or edited issue, works out what the issue is about, applies
labels, tidies the title, and (when useful) leaves a single comment. It does
this with **plain heuristics — no LLM and no external dependencies.**

- **`triage.mjs`** — the engine. All logic lives here (single source of truth).
- **`triage.test.mjs`** — unit tests for the pure heuristics (`node --test`).
- **`package.json`** — declares the module type and the `check`/`test` scripts.

The engine is run by [`.github/workflows/triage.yml`](../workflows/triage.yml),
which loads `triage.mjs` and calls `run({ github, context, core })` using the
`actions/github-script` toolkit.

---

## The problem it solves

This repo receives a high volume of issues about Bicep type definitions —
missing properties, wrong property types, resource types that aren't available
yet, and so on. Sorting them by hand is slow and inconsistent: issues sit
unlabeled, duplicates pile up, and it's hard to tell at a glance whether a
report is a genuine type-definition defect or an Azure service/deployment
problem that lives in a different repo.

## Why heuristics (and not an LLM)

The bot deliberately uses deterministic rules instead of a language model:

- **Predictable & auditable** — the same issue always produces the same result,
  and every decision can be traced to a specific rule.
- **No cost, no secrets, no rate-limited API** — it runs entirely inside GitHub
  Actions with the built-in token.
- **Verifiable against the real schema** — for "missing property" claims it
  checks the actual generated `types.md` in
  [`Azure/bicep-types-az`](https://github.com/Azure/bicep-types-az), which is
  the source of truth, rather than guessing.

("Heuristics" just means a set of practical rules-of-thumb — keyword proximity,
regex patterns, the issue-template fields the reporter filled in — that
together make a good-enough classification.)

---

## When it runs

On the `issues` event for **`opened`**, **`edited`**, and **`reopened`**. Each
issue is processed independently.

## What it does, step by step

1. **Reads the issue** title and body, plus the structured
   `### Issue Type` / `### Resource Type` / `### Api Version` fields from the
   issue template when present. The reporter's template selection is trusted
   over loose text guesses.

2. **Finds the resource provider and type** — e.g. `Microsoft.Storage` and
   `Microsoft.Storage/storageAccounts`. Matching is case-sensitive so domain
   names like `learn.microsoft.com` are ignored.

3. **Classifies the issue** into one or more categories (see the label table
   below), combining the template selection with keyword/proximity heuristics.

4. **Extracts the property name(s)** the issue is about, when it's a
   missing-property or type report. Candidate names are pulled from prose and
   error messages, then filtered against a stopword list so English words and
   pasted JSON error-envelope keys (`message`, `code`, `target`, …) aren't
   mistaken for real properties.

5. **Verifies missing-property claims against the real schema.** For a claim
   like "`X` is missing on `Microsoft.Y/z`", the bot downloads the generated
   `types.md` for that type and checks whether the property actually exists:
   - If it exists **at the reporter's API version** → labels `property found`.
   - If it's absent there but exists **in a newer version** → labels
     `available in newer version` and comments with the exact version to use.
   - Otherwise → keeps `missing property`.

6. **Applies labels** (creating any that don't exist yet) and **removes stale
   labels** it previously applied when a category no longer fits.

7. **Normalizes the title** into a consistent, searchable format for
   missing-property/type issues, or restores the reporter's original title if a
   previous run had genericized it.

8. **Detects likely duplicates** (same resource type + property, within the
   same category) and flags them with `possible-duplicate` — it never
   auto-closes.

9. **Comments — at most once per issue.** The bot maintains a single comment
   (identified by a hidden marker) and updates it in place, so issues never get
   spammed. On the first triage it posts a short acknowledgement summarizing
   what it detected; on later runs it only comments if it has something
   actionable to say (e.g. the newer-version hint or a duplicate list), and it
   deletes its comment if nothing applies anymore.

---

## Labels the bot uses

Besides a resource-provider label (e.g. `Microsoft.Storage`), issues get one or
more content labels:

| Label | Meaning |
|---|---|
| `missing property` | A property (or whole type) the schema doesn't expose at the reporter's version |
| `property found` | The property *does* exist at the reporter's version (verified against `types.md`) |
| `available in newer version` | Missing at the reporter's version, but present in a newer API version |
| `type issue` | A property's type/shape is wrong or a type is unavailable |
| `inaccurate description` | The type is fine but a property's description/docs are wrong or confusing |
| `read-only/write-only` | A property is marked with the wrong mutability |
| `idempotency issue` | Re-deploying the same template recreates/changes the resource |
| `deployment issue` | The resource fails to deploy, gives a confusing deploy error, or a property has no effect at deploy time |
| `bug` | A runtime/deployment defect rather than a schema problem |
| `possible-duplicate` | Looks like an existing issue (flagged for maintainer review, never auto-closed) |

`idempotency issue` takes precedence over the generic `deployment issue`.

---

## Guardrails & design notes

- **Idempotent.** Re-running on the same issue converges to the same labels,
  title, and single comment — safe to re-trigger by editing an issue.
- **Never destructive.** It doesn't close issues; the strongest duplicate action
  is a label + comment for a human to review.
- **Self-loop protection.** It skips its own bot-generated edits (except on
  open/reopen) and avoids mining its own previously-generated titles.
- **Resilient network calls.** Schema fetches use retry-with-backoff and respect
  GitHub rate limits.

## Working on the bot

From this directory:

```bash
npm run check   # node --check triage.mjs  (syntax)
npm run test    # node --test              (unit tests for the heuristics)
```

Both run automatically in CI
([`.github/workflows/triage-ci.yml`](../workflows/triage-ci.yml)) whenever the
triage scripts change, so a broken export can't reach the live workflow.

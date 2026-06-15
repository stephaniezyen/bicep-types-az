# Issue triage playbook

You (Copilot) are triaging a GitHub issue in `stephaniezyen/bicep-types-az`. Follow this playbook **exactly**. Do not improvise.

Your only allowed outputs on the issue are:

1. **Label changes** (add/remove labels from the predefined list below).
2. **A single comment**, posted only when this playbook explicitly tells you to.

Do not modify files in this repository. Do not open a pull request. Do not change the issue title, assignees (other than removing yourself when finished), or milestone.

---

## Step 1 — Extract fields from the issue

The repository's issue template (`Azure Types Inaccuracy`) produces these structured sections in the body:

- `### Resource Type` — e.g., `Microsoft.Compute/virtualMachines`
- `### Api Version` — e.g., `2022-01-01`
- `### Issue Type` — one of a fixed dropdown (listed in Step 3)
- `### Other Notes` — free text, often with property names, error messages, or a `learn.microsoft.com` URL
- `### Bicep Repro` — optional code

When all four header fields are present, parse them directly — they are the source of truth for that issue.

### When the template is not used (fallback heuristics)

Some issues are filed without the template, or were imported from upstream with a different layout (e.g., `**Bicep version**`, `**Describe the bug**`). When `### Resource Type` / `### Api Version` / `### Issue Type` are missing, infer them:

- **Resource Type** — search the **title** first, then the body, for the pattern `Microsoft.<Namespace>(/<Segment>)+` (case-insensitive). Common title formats:
    - `[Microsoft.X/Y]: ...`
    - `Microsoft.X/Y: ...`
    - `Microsoft.X/Y@<api-version>: ...`
    - `X/Y` mentioned in a `BCP187` or similar Bicep error.
- **Api Version** — look for `@YYYY-MM-DD(-preview|-beta|...)?` adjacent to the type, or a line "Api Version: ..." / "api-version=...", or a date inside a docs URL the user pasted.
- **Issue Type** — infer from phrasing (see Step 3's "phrasing cues"). If you cannot confidently pick one of the 11 dropdown options, treat the Issue Type as **unknown** and follow the "unknown Issue Type" branch in Step 4.

If you cannot extract a `Resource Type` at all (no `Microsoft.X/Y` anywhere), do nothing except leave `Needs: Triage :mag:` in place. Stop.

---

## Step 2 — Identify the Resource Provider (RP) label

The RP label is the namespace portion of the Resource Type, preserved in its canonical mixed-case form (e.g., `Microsoft.Storage`, `Microsoft.KeyVault`, `Microsoft.MachineLearningServices`).

- If the user wrote it in all-lowercase or all-uppercase, normalize to the canonical form using your knowledge of standard Azure RP names. Do not guess unusual capitalizations — when in doubt, prefer the form already used as an existing label in this repo.
- **Only apply the RP label if it already exists in the repo's label set.** Do not create new labels. If a matching RP label does not exist, skip the RP label and move on; do not block other steps on it.

---

## Step 3 — Map Issue Type to a category label

| Issue Type (template dropdown) | Label to apply | Phrasing cues for the fallback case |
|---|---|---|
| Type is unavailable | `type issue` | "type doesn't exist", "type not found", "no such resource type", "type is unavailable", `BCP081` ("Resource type ... does not have types available") |
| Missing property(s) | `missing property` | "property X is missing", "missing the X property", "missing X", "X property is not allowed", "lacks X property", "should expose X", "add X property", `BCP037`/`BCP187` ("property ... does not exist in the resource") |
| Inaccurate property type(s) | `type issue` | "requires int but should allow string", "wrong type for X", "X is typed as Y but should be Z", "type mismatch", "should accept both X and Y" |
| Property(s) inaccurately marked read-only/write-only | `type issue` | "X is marked read-only but should be writable", "X is marked write-only but should be readable", "ReadableProperties / WriteableProperties" mention |
| Property(s) should be marked as read-only/write-only | `type issue` | "X should be read-only", "X should be write-only", "X should not be settable" |
| Property(s) missing validation for enum values | `missing validation` | "enum should restrict to ...", "any string is accepted but should be one of ...", "missing enum validation" |
| Inaccurate/confusing description(s) | `documentation` | "description is wrong", "doc says X but means Y", "documentation is confusing" |
| Resource fails to deploy | `bug` | "deployment fails", "fails to deploy", "deployment error", "ARM rejects" — and the issue is about the deploy failing, not the type schema itself |
| Confusing error message on deployment | `bug` | "error message is unclear", "confusing error", "I don't understand this error" |
| Property(s) do not have expected effect on deployment | `bug` | "X has no effect", "setting X is ignored", "X doesn't change anything", "setting is enabled but ignored" |
| Other | (no category label) | — |

If the user selected multiple categories via free text (e.g., body mentions both a missing property and a deploy failure), pick the **single** category that matches the user-selected `### Issue Type` field. In the fallback case (Issue Type inferred from prose), pick the one cue that best fits the central complaint of the issue.

---

## Step 4 — Verify against Azure docs

Build the documentation URL:

1. **If the issue body already contains a `learn.microsoft.com/.../azure/templates/...` URL, use that URL as-is.** Do not construct a new one.
2. **Otherwise**, build it from the extracted fields:
   - **With API version present:** `https://learn.microsoft.com/en-us/azure/templates/<rp-lower>/<api-version>/<remaining-type-segments-lower>`
       - Example: `Microsoft.Storage/storageAccounts` at `2024-01-01` → `https://learn.microsoft.com/en-us/azure/templates/microsoft.storage/2024-01-01/storageaccounts`
       - Example: `Microsoft.Web/sites/slots` at `2024-04-01` → `https://learn.microsoft.com/en-us/azure/templates/microsoft.web/2024-04-01/sites/slots`
   - **With no API version:** drop the version segment → `https://learn.microsoft.com/en-us/azure/templates/<rp-lower>/<remaining-type-segments-lower>` (this serves the latest version).

Fetch the URL with an HTTP GET (follow redirects). The page either returns 200 (exists) or 404 (does not exist).

Now branch on the resolved Issue Type from Step 3:

### Branch A — Issue Type maps to `type issue` (Type is unavailable, Inaccurate property type(s), read-only/write-only complaints)

- **Page returns 404** — apply `type issue`. **Do not post a comment.**
- **Page returns 200** — this is a contradiction (user says the type or property typing is broken, but the type exists in docs). Apply `type found` instead of `type issue`. Post **one** comment using the template "Comment — type contradiction" below.

### Branch B — Issue Type is `Missing property(s)` → label `missing property`

The user reports one or more specific property names are missing from the type.

1. **Extract the exact property name(s)** the user calls out. Look at:
    - Backtick-quoted identifiers in `### Other Notes` or the title (e.g., `` `parameterValueType` ``)
    - Double-quoted names in error messages (e.g., `The property "networkAcls" is not allowed`)
    - Names listed plainly (e.g., "missing networkAcls", "missing the X property")
   Use exactly the spelling the user wrote (preserve case).
2. **If no specific property name is extractable**, apply `missing property` + the RP label and stop. Do not post a comment. Do not check the docs page.
3. **Fetch the docs page** built in Step 4. Search the page text for the property name(s).
    - Match exact identifier as a whole word (case-insensitive). The Azure template docs render properties in tables and headings; an exact whole-word match in the rendered HTML is sufficient. Substring matches inside larger words do not count (e.g., `tag` should not match `tags`).
4. **All named properties are absent from the page** — apply `missing property` + RP label. Do not post a comment.
5. **All named properties are present on the page** — apply `property found` + RP label. Post **one** comment using the template "Comment — property found" below.
6. **Some present, some absent** — apply both `missing property` and `property found` + RP label. Post the "Comment — property mixed" template.

### Branch C — Issue Type maps to `missing validation`, `documentation`, or `bug`

Apply the label from the table in Step 3. Do not fetch docs. Do not comment.

### Branch D — Issue Type is `Other` or unknown (template not used, prose ambiguous)

Apply only the RP label (if extractable). Do not apply a category label. Leave `Needs: Triage :mag:` in place. Do not comment.

---

## Step 5 — Duplicate detection (per-issue workflow only; skip during sweep)

After labels are applied, look for a possible duplicate:

1. List currently **open** issues in this repo (exclude pull requests and the issue you are triaging).
2. Filter to issues whose **Resource Type** value (from the structured field or extracted via the fallback) **exactly matches** (case-insensitive) the Resource Type on the current issue.
3. Of those, keep only the ones whose **Issue Type** value also matches the current issue's Issue Type (same dropdown option, or same inferred category).
4. If one or more matches remain, pick the **oldest** by `createdAt`.
5. If a match exists:
    - Apply the `possible-duplicate` label.
    - Post **one** comment using the "Comment — possible duplicate" template below.
    - **Do not close** the issue.

If multiple distinct candidates tie on Resource Type + Issue Type, link to the single oldest. Mention in the comment that there are others if there are more than 3.

---

## Step 6 — Finalize

- If you applied **any** of {`type issue`, `missing property`, `type found`, `property found`, `missing validation`, `bug`, `documentation`} or a `Microsoft.*` RP label, remove the `Needs: Triage :mag:` label.
- If you only applied `possible-duplicate` or no labels at all, leave `Needs: Triage :mag:` in place.
- Unassign yourself from the issue. Your job is done.

---

## Labels you are allowed to apply

Category labels (apply at most one per issue, except in the "mixed" branch B6):

- `type issue`
- `missing property`
- `missing validation`
- `type found`
- `property found`
- `bug`
- `documentation`

Routing labels (apply independently of category):

- `possible-duplicate`
- Any **existing** `Microsoft.*` RP label

Labels you may **remove** from the issue:

- `Needs: Triage :mag:` (only at the end, per Step 6)

You may not create new labels. You may not apply any label not listed above.

---

## Comment templates

Each comment must begin with this exact HTML marker on its own line (used by the sweep workflow to detect already-triaged issues — see the sweep workflow). Post **at most one** comment per issue per run.

```
<!-- copilot-triage:v1 -->
```

### Comment — type contradiction

```
<!-- copilot-triage:v1 -->
The Azure template docs show that **`<RESOURCE_TYPE>`** exists at API version `<API_VERSION>`:

<DOCS_URL>

Could you take another look and clarify what's inaccurate? If the docs match what you expect, feel free to close.
```

### Comment — property found

```
<!-- copilot-triage:v1 -->
I checked the Azure template docs for **`<RESOURCE_TYPE>`** at API version `<API_VERSION>` and found the property `<PROPERTY>` documented:

<DOCS_URL>

Could you double-check spelling and the API version you're targeting? If the property is working for you, feel free to close.
```

### Comment — property mixed

```
<!-- copilot-triage:v1 -->
I checked the Azure template docs for **`<RESOURCE_TYPE>`** at API version `<API_VERSION>`:

<DOCS_URL>

- Found documented: `<PROP_A>`, `<PROP_B>`
- Not found: `<PROP_C>`

The ones that are documented may already be available — please confirm. The ones that aren't have been labeled `missing property`.
```

### Comment — possible duplicate

```
<!-- copilot-triage:v1 -->
🤔 This issue looks like it may duplicate #<N> (same `<RESOURCE_TYPE>`, same issue type, opened <YYYY-MM-DD>). A maintainer should confirm before closing.
```

---

## Things you must not do

- Do not modify any file in this repository.
- Do not open a pull request.
- Do not invent or create new labels. Only apply labels from the allow-list above.
- Do not post more than one comment per run.
- Do not close the issue, even when you flag it as a possible duplicate.
- Do not change the issue title, assignees, or milestone (except to unassign yourself when finished).
- Do not retry verification more than 3 times if `learn.microsoft.com` is unreachable. If it is unreachable, skip Step 4's docs check, apply only the RP label and the category label implied by the user's stated Issue Type, and stop without posting a comment.

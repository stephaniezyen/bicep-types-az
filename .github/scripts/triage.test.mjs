import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  run,
  classify,
  ISSUE_CATEGORIES,
  MANAGED_LABELS,
  extractAllMissingProperties,
  canonicalizeProperties,
  isPlausiblePropertyName,
  extractApiVersion,
  normalizeNs,
  pageHasWord,
  scopeToResourceType,
  compareTypeVersions,
} from './triage.mjs';

// These tests exercise the pure heuristics directly (they need no live GitHub
// context). They guard both the "module loads / exports run()" breakage the
// old smoke tests caught AND the actual classification behavior.

// --- module shape -----------------------------------------------------------

test('exports run() as a single-arg function', () => {
  assert.equal(typeof run, 'function');
  assert.equal(run.length, 1, 'run should declare one destructured toolkit arg');
});

// --- classify() -------------------------------------------------------------

test('classifies an explicit missing-property report', () => {
  const title = 'networkAcls property is missing on Microsoft.Storage/storageAccounts';
  const cls = classify(`${title}\n\n`, { title, body: '' });
  assert.equal(cls.hasMissingPropertyLanguage, true);
  assert.ok(cls.propertyNames.map(p => p.toLowerCase()).includes('networkacls'));
  assert.ok(cls.types.includes('Microsoft.Storage/storageAccounts'));
});

test('classifies a type-unavailable report', () => {
  const body = 'For Microsoft.Foo/bars the type is not available in Bicep yet.';
  const cls = classify(body, { title: 'type unavailable', body });
  assert.equal(cls.hasTypeUnavailableLanguage, true);
});

test('honors the issue-template "Issue Type" selection over prose', () => {
  const body = '### Issue Type\n\nMissing property(s)\n\n### Resource Type\n\nMicrosoft.Storage/storageAccounts';
  const cls = classify(body, { title: '[Microsoft.Storage/storageAccounts]: x', body });
  assert.equal(cls.templateIssueType, 'missing-property');
  assert.equal(cls.hasMissingPropertyLanguage, true);
});

test('does not flag missing-property on plain prose with no signal', () => {
  const body = 'Thanks for the great work on bicep types, everything works as expected.';
  const cls = classify(body, { title: 'kudos', body });
  assert.equal(cls.hasMissingPropertyLanguage, false);
});

// --- description-issue category (fix: #783) ---------------------------------

test('classifies the template "Inaccurate/confusing description(s)" selection', () => {
  const body = '### Resource Type\n\nMicrosoft.Insights/webtests\n\n### Issue Type\n\nInaccurate/confusing description(s)\n\n### Other Notes\n\nThe description for field ExpectedHttpStatusCode is incomplete.';
  const title = '[Microsoft.Insights/webtests]: Missing property';
  const cls = classify(`${title}\n\n${body}`, { title, body, miningTitle: title });
  assert.equal(cls.templateIssueType, 'description-issue');
  assert.equal(cls.hasDescriptionIssueLanguage, true);
  assert.equal(cls.hasMissingPropertyLanguage, false, 'must not double-count as missing property');
  assert.equal(cls.hasTypeIssueLanguage, false, 'must not leak into the type-issue bucket');
});

test('detects a description issue from prose when no template is used', () => {
  const body = 'The description of the accessTier property is confusing and does not explain the default.';
  const cls = classify(body, { title: 'docs', body });
  assert.equal(cls.hasDescriptionIssueLanguage, true);
});

// --- ARM/JSON error-envelope keys are not mined as properties (fix: #435) ---

test('does not mine JSON error-envelope keys (message/code) as properties', () => {
  const body = [
    '### Resource Type', '', 'Microsoft.Storage/storageAccounts', '',
    '### Other Notes', '',
    'Deployment failed with:',
    '```json',
    '{ "code": "MissingRequiredAccountProperty",',
    '  "message": "Account property accessTier is required for the request." }',
    '```',
  ].join('\n');
  const title = '[Microsoft.Storage/storageAccounts]: x';
  const cls = classify(`${title}\n\n${body}`, { title, body, miningTitle: title });
  const lower = cls.propertyNames.map(p => p.toLowerCase());
  assert.ok(lower.includes('accesstier'), 'still extracts the real property');
  assert.equal(lower.includes('message'), false, 'error-envelope key must be stopworded');
  assert.equal(lower.includes('code'), false, 'error-envelope key must be stopworded');
});

// --- two different error shapes in one issue (fix: #787) --------------------

test('extracts both properties when an issue quotes two different Bicep error shapes', () => {
  const body = [
    '### Resource Type', '', 'Microsoft.Web/connections', '',
    '### Issue Type', '', 'Missing property(s)', '',
    '### Other Notes', '',
    'Error 1: `The property "kind" does not exist in the resource or type definition.`',
    'Error 2: `The type "ApiConnectionDefinitionProperties" does not contain property "connectionRuntimeUrl".`',
  ].join('\n');
  const title = '[Microsoft.Web/connections]: kind property missing';
  const cls = classify(`${title}\n\n${body}`, { title, body, miningTitle: title });
  const lower = cls.propertyNames.map(p => p.toLowerCase());
  assert.ok(lower.includes('kind'), 'keeps the definitively-missing property');
  assert.ok(lower.includes('connectionruntimeurl'), 'also captures the "type X does not contain property Y" shape');
  // The container type must NOT be mistaken for a property.
  assert.equal(lower.includes('apiconnectiondefinitionproperties'), false);
});

// --- extractApiVersion() ----------------------------------------------------

test('extracts api version from <type>@<version>', () => {
  const v = extractApiVersion('x', "resource s 'Microsoft.Storage/storageAccounts@2023-01-01' = {}");
  assert.equal(v, '2023-01-01');
});

test('extracts api version from the issue-template block', () => {
  const v = extractApiVersion('', '### Api Version\n\n2024-05-01-preview');
  assert.equal(v, '2024-05-01-preview');
});

test('extracts api version from a flattened cross-posted body (fix: #795)', () => {
  // Newlines collapsed to spaces; a cross-post date precedes the real
  // template value. The "### Api Version" section must win over the
  // "Originally opened ... on 2026-04-13" date.
  const body = '_Originally opened by @x on 2026-04-13_  ---  ### Resource Type  Microsoft.Network/virtualNetworks  ### Api Version  2024-10-01  ### Issue Type  Missing property(s)  ### Other Notes  needs summarizedGatewayPrefixes';
  assert.equal(extractApiVersion('', body), '2024-10-01');
});

test('does not mistake the cross-post date for the api version', () => {
  const body = '_Originally opened by @x on 2026-04-13_  ### Api Version  2024-10-01  ### Issue Type  Missing property(s)';
  const cls = classify(body, { title: 't', body });
  assert.equal(cls.apiVersion, '2024-10-01');
  assert.notEqual(cls.apiVersion, '2026-04-13');
});

// --- normalizeNs() ----------------------------------------------------------

test('normalizes namespace casing', () => {
  assert.equal(normalizeNs('Microsoft.STORAGE'), 'Microsoft.Storage');
  assert.equal(normalizeNs('Microsoft.storage'), 'Microsoft.Storage');
  assert.equal(normalizeNs('Microsoft.KeyVault'), 'Microsoft.KeyVault'); // mixed case preserved
});

// --- compareTypeVersions() (fix: GA beats preview for same date) ------------

test('ranks GA above preview of the same date (newest-first sort)', () => {
  const sorted = ['2024-01-01-preview', '2024-01-01', '2023-06-01'].sort(compareTypeVersions);
  assert.deepEqual(sorted, ['2024-01-01', '2024-01-01-preview', '2023-06-01']);
});

test('ranks newer date first regardless of stage', () => {
  const sorted = ['2023-01-01', '2025-01-01-preview', '2024-01-01'].sort(compareTypeVersions);
  assert.deepEqual(sorted, ['2025-01-01-preview', '2024-01-01', '2023-01-01']);
});

// --- quality-v2: property canonicalization (#1) -----------------------------

test('canonicalizeProperties strips the noise "properties." prefix', () => {
  assert.deepEqual(canonicalizeProperties(['properties.accessTier']), ['accessTier']);
});

test('canonicalizeProperties collapses bare + dotted forms of one leaf', () => {
  const out = canonicalizeProperties([
    'disablePasswordAuthentication',
    'linuxConfiguration.disablePasswordAuthentication',
    'properties.osProfile.linuxConfiguration.disablePasswordAuthentication',
  ]);
  assert.deepEqual(out, ['disablePasswordAuthentication']);
});

test('canonicalizeProperties preserves distinct leaves in first-seen order', () => {
  const out = canonicalizeProperties([
    'properties.IpConfigurations',
    'privateIPAllocationMethod',
    'properties.privateIPAllocationMethod',
  ]);
  assert.deepEqual(out, ['IpConfigurations', 'privateIPAllocationMethod']);
});

// --- quality-v2: hyphenated tokens rejected (#3) ----------------------------

test('isPlausiblePropertyName rejects hyphenated CLI-flag tokens', () => {
  assert.equal(isPlausiblePropertyName('what-if'), false);
  assert.equal(isPlausiblePropertyName('api-version'), false);
  assert.equal(isPlausiblePropertyName('accessTier'), true);
});

test('hyphenated repro tokens do not leak into extracted properties', () => {
  const body = 'When I run bicep with --what-if the disablePasswordAuthentication property is missing.';
  const props = extractAllMissingProperties('', body, ['Microsoft.Compute/virtualMachines']);
  assert.ok(props.includes('disablePasswordAuthentication'));
  assert.ok(!props.some(p => p.includes('-')), `no hyphenated tokens, got ${JSON.stringify(props)}`);
});

// --- quality-v2: lowercase+digit title shorthand (#4) -----------------------

test('extracts a lowercase-with-digit property from a capitalized title shorthand', () => {
  // Regression for #547 ("Missing oauth2scopes") — the keyword "Missing" is
  // capitalized and the identifier has no uppercase hump, only a digit.
  const props = extractAllMissingProperties('Missing oauth2scopes', '', ['Microsoft.Graph/applications']);
  assert.deepEqual(props, ['oauth2scopes']);
});

test('camelCase title shorthand still extracts (no regression)', () => {
  const props = extractAllMissingProperties('Missing networkAcls', '', ['Microsoft.Storage/storageAccounts']);
  assert.deepEqual(props, ['networkAcls']);
});

// --- pageHasWord() ----------------------------------------------------------

test('pageHasWord matches whole words case-insensitively, not substrings', () => {
  const page = 'Defines the networkAcls object and the sku property.';
  assert.equal(pageHasWord(page, 'networkAcls'), true);
  assert.equal(pageHasWord(page, 'NETWORKACLS'), true);
  assert.equal(pageHasWord(page, 'networkAcl'), false); // not a whole word
});

// --- scopeToResourceType() --------------------------------------------------

test('scopes a types.md to a single resource and its referenced types', () => {
  const md = [
    '## Resource Microsoft.Storage/storageAccounts@2023-01-01',
    '* **properties**: [StorageProps](#storageprops)',
    '',
    '## StorageProps',
    '* **networkAcls**: string',
    '',
    '## Resource Microsoft.Storage/blobServices@2023-01-01',
    '* **unrelated**: [Other](#other)',
    '',
    '## Other',
    '* **shouldNotLeak**: string',
  ].join('\n');
  const scoped = scopeToResourceType(md, 'Microsoft.Storage/storageAccounts', '2023-01-01');
  assert.ok(pageHasWord(scoped, 'networkAcls'), 'includes referenced object type');
  assert.equal(pageHasWord(scoped, 'shouldNotLeak'), false, 'excludes unrelated resource');
});

// --- read-only / write-only mutability category -----------------------------

test('classifies the template "Property(s) inaccurately marked read-only/write-only" selection', () => {
  const body = '### Resource Type\n\nMicrosoft.Storage/storageAccounts\n\n### Issue Type\n\nProperty(s) inaccurately marked read-only/write-only\n\n### Other Notes\n\nThe primaryEndpoints field is settable.';
  const title = '[Microsoft.Storage/storageAccounts]: read-only mistake';
  const cls = classify(`${title}\n\n${body}`, { title, body, miningTitle: title });
  assert.equal(cls.templateIssueType, 'readwrite-only');
  assert.equal(cls.hasReadWriteOnlyLanguage, true);
});

test('classifies the template "Property(s) should be marked as read-only/write-only" selection', () => {
  const body = '### Issue Type\n\nProperty(s) should be marked as read-only/write-only\n\n### Resource Type\n\nMicrosoft.Web/sites';
  const cls = classify(body, { title: 'x', body });
  assert.equal(cls.templateIssueType, 'readwrite-only');
  assert.equal(cls.hasReadWriteOnlyLanguage, true);
});

test('detects a read-only/write-only issue from prose when no template is used', () => {
  const body = 'The property status is incorrectly marked read-only but should be writable.';
  const cls = classify(body, { title: 'mutability', body });
  assert.equal(cls.hasReadWriteOnlyLanguage, true);
});

// --- idempotency category ---------------------------------------------------

test('classifies an idempotency issue and keeps it out of the deployment bucket', () => {
  const body = 'Re-running the same deployment fails to deploy because the resource is not idempotent and gets recreated every time.';
  const cls = classify(body, { title: 'idempotency', body });
  assert.equal(cls.hasIdempotencyLanguage, true);
  assert.equal(cls.hasDeploymentLanguage, false, 'idempotency takes precedence over deployment');
});

// --- deployment category ----------------------------------------------------

test('classifies the template "Resource fails to deploy" selection', () => {
  const body = '### Issue Type\n\nResource fails to deploy\n\n### Resource Type\n\nMicrosoft.Web/sites';
  const cls = classify(body, { title: 'x', body });
  assert.equal(cls.templateIssueType, 'deployment');
  assert.equal(cls.hasDeploymentLanguage, true);
  assert.equal(cls.hasIdempotencyLanguage, false);
});

test('classifies the template "Property(s) do not have expected effect on deployment" selection', () => {
  const body = '### Issue Type\n\nProperty(s) do not have expected effect on deployment\n\n### Resource Type\n\nMicrosoft.Storage/storageAccounts';
  const cls = classify(body, { title: 'x', body });
  assert.equal(cls.templateIssueType, 'deployment');
  assert.equal(cls.hasDeploymentLanguage, true);
});

// --- ISSUE_CATEGORIES config-table integrity ---
// These guard the invariants the generic classify/label loops rely on, so a
// malformed new category fails fast in CI instead of silently misbehaving.

test('every category has a unique id and flag', () => {
  const ids = ISSUE_CATEGORIES.map(c => c.id);
  const flags = ISSUE_CATEGORIES.map(c => c.flag);
  assert.equal(new Set(ids).size, ids.length, 'duplicate category id');
  assert.equal(new Set(flags).size, flags.length, 'duplicate category flag');
});

test('every category label is managed so it can be stripped when stale', () => {
  for (const c of ISSUE_CATEGORIES) {
    assert.ok(MANAGED_LABELS.includes(c.label),
      `${c.id} applies "${c.label}" but it is not in MANAGED_LABELS`);
  }
});

test('MANAGED_LABELS never strips resource-provider labels', () => {
  for (const label of MANAGED_LABELS) {
    assert.ok(!/^Microsoft\./.test(label),
      `RP label "${label}" must not be auto-removed`);
  }
});

test('suppressedBy only references categories decided earlier in the table', () => {
  // The classify() loop evaluates categories in order and reads already-computed
  // flags, so a suppressor must appear before the category it suppresses.
  const decided = new Set(['definitively-bug', 'definitively-missing']);
  for (const c of ISSUE_CATEGORIES) {
    for (const dep of c.suppressedBy || []) {
      assert.ok(decided.has(dep),
        `${c.id} is suppressed by "${dep}", which is not decided before it`);
    }
    decided.add(c.id);
  }
});

test('classify returns exactly one flag per category', () => {
  const cls = classify('Microsoft.Storage/storageAccounts is missing accessTier', '');
  for (const c of ISSUE_CATEGORIES) {
    assert.equal(typeof cls[c.flag], 'boolean',
      `classify() did not return a boolean for ${c.flag}`);
  }
});

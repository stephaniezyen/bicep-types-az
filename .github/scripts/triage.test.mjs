import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  run,
  classify,
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

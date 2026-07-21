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

// --- extractApiVersion() ----------------------------------------------------

test('extracts api version from <type>@<version>', () => {
  const v = extractApiVersion('x', "resource s 'Microsoft.Storage/storageAccounts@2023-01-01' = {}");
  assert.equal(v, '2023-01-01');
});

test('extracts api version from the issue-template block', () => {
  const v = extractApiVersion('', '### Api Version\n\n2024-05-01-preview');
  assert.equal(v, '2024-05-01-preview');
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

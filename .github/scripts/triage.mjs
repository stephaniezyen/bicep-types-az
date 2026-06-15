#!/usr/bin/env node
// Triage orchestrator for stephaniezyen/bicep-types-az.
//
// Reads .github/triage-playbook.md as the LLM system prompt, gathers
// per-issue context (issue body, regex-extracted fields, fetched Azure
// docs page, list of open issues), calls GitHub Models for a structured
// decision, then applies it via the gh CLI.
//
// Invoked as:
//   node .github/scripts/triage.mjs --mode=on-open  (per-issue, ISSUE_NUMBER env)
//   node .github/scripts/triage.mjs --mode=sweep    (all open issues)
//
// Required env: GITHUB_TOKEN, GH_TOKEN (same value), GH_REPO. Optional: MODEL.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const MODE = (process.argv.find(a => a.startsWith('--mode=')) || '').slice(7) || 'on-open';
const ISSUE = process.env.ISSUE_NUMBER;
const REPO = process.env.GH_REPO;
const MODEL = process.env.MODEL || 'openai/gpt-4o-mini';
const TOKEN = process.env.GITHUB_TOKEN;
const MARKER = '<!-- copilot-triage:v1 -->';

const MANAGED_CATEGORY_LABELS = new Set([
  'type issue', 'missing property', 'missing validation',
  'type found', 'property found', 'bug', 'documentation',
]);
const ALL_MANAGED_LABELS = new Set([...MANAGED_CATEGORY_LABELS, 'possible-duplicate']);

if (!TOKEN) { console.error('Missing GITHUB_TOKEN'); process.exit(1); }
if (!REPO) { console.error('Missing GH_REPO'); process.exit(1); }

const playbook = readFileSync('.github/triage-playbook.md', 'utf8');

function gh(args, input = null) {
  const opts = { encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'], maxBuffer: 20 * 1024 * 1024 };
  if (input !== null) opts.input = input;
  return execFileSync('gh', args, opts);
}

function ghJson(args) { return JSON.parse(gh(args)); }

function getIssue(num) {
  return ghJson(['issue', 'view', String(num), '-R', REPO, '--json', 'number,title,body,labels,createdAt']);
}

function listOpenIssues() {
  return ghJson(['issue', 'list', '-R', REPO, '--state', 'open', '--limit', '300',
    '--json', 'number,title,body,labels,createdAt']);
}

function extractResourceType(body, title) {
  const text = `${title || ''}\n${body || ''}`;
  const structured = text.match(/###\s*Resource Type\s*\r?\n\s*\r?\n\s*(\S[^\n\r]*)/i);
  if (structured) return structured[1].trim();
  const fallback = text.match(/\bMicrosoft\.[A-Za-z][A-Za-z0-9]*(?:\/[A-Za-z][A-Za-z0-9]*)+/);
  return fallback ? fallback[0] : null;
}

function extractApiVersion(body, title) {
  const text = `${title || ''}\n${body || ''}`;
  const structured = text.match(/###\s*Api Version\s*\r?\n\s*\r?\n\s*(\S[^\n\r]*)/i);
  if (structured) return structured[1].trim().split(/\s|&/)[0];
  const fallback = text.match(/@(\d{4}-\d{2}-\d{2}(?:-[a-z]+)?)/i);
  return fallback ? fallback[1] : null;
}

function userProvidedDocsUrl(body) {
  if (!body) return null;
  const m = body.match(/https:\/\/learn\.microsoft\.com\/[^\s)`'"<>]*\/azure\/templates\/\S+/i);
  return m ? m[0].replace(/[.,);\]]+$/, '') : null;
}

function buildDocsUrl(rt, ver) {
  if (!rt) return null;
  const parts = rt.split('/');
  if (parts.length < 2) return null;
  const [ns, ...segs] = parts;
  const pieces = [ns.toLowerCase()];
  if (ver) pieces.push(ver);
  pieces.push(...segs.map(s => s.toLowerCase()));
  return `https://learn.microsoft.com/en-us/azure/templates/${pieces.join('/')}`;
}

async function fetchDocs(url) {
  if (!url) return { url: null, status: null, snippet: null };
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': 'bicep-types-az-triage/1.0' },
    });
    if (!res.ok) return { url, status: res.status, snippet: null };
    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();
    return { url, status: res.status, snippet: text.slice(0, 8000) };
  } catch (e) {
    return { url, status: null, snippet: null, error: e.message };
  }
}

async function callLLM(systemPrompt, userPrompt) {
  const res = await fetch('https://models.github.ai/inference/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Models API HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error(`Models API: empty content. Full response: ${JSON.stringify(data).slice(0, 500)}`);
  try {
    return JSON.parse(content);
  } catch (e) {
    throw new Error(`Models API returned non-JSON content: ${content.slice(0, 500)}`);
  }
}

function validateDecision(d) {
  const errors = [];
  if (d.category_label && !MANAGED_CATEGORY_LABELS.has(d.category_label)) {
    errors.push(`Unknown category_label: ${d.category_label}`);
  }
  for (const l of (d.additional_labels || [])) {
    if (!MANAGED_CATEGORY_LABELS.has(l)) errors.push(`Unknown additional_label: ${l}`);
  }
  if (d.rp_label && !/^Microsoft\.[A-Za-z][A-Za-z0-9]*$/.test(d.rp_label)) {
    errors.push(`Suspicious rp_label: ${d.rp_label}`);
  }
  if (d.possible_duplicate_of && typeof d.possible_duplicate_of.number !== 'number') {
    errors.push(`possible_duplicate_of must be {number, createdAt}`);
  }
  return errors;
}

function applyDecision(num, d) {
  const adds = new Set();
  if (d.rp_label) adds.add(d.rp_label);
  if (d.category_label) adds.add(d.category_label);
  for (const l of (d.additional_labels || [])) adds.add(l);
  if (d.possible_duplicate_of) adds.add('possible-duplicate');

  if (adds.size) {
    console.log(`  Adding labels: ${[...adds].join(', ')}`);
    const labelArgs = [...adds].flatMap(l => ['--add-label', l]);
    try { gh(['issue', 'edit', String(num), '-R', REPO, ...labelArgs]); }
    catch (e) { console.error(`  Add-labels failed: ${e.message}`); }
  }

  if (d.remove_needs_triage) {
    console.log('  Removing needs: triage');
    try { gh(['issue', 'edit', String(num), '-R', REPO, '--remove-label', 'needs: triage']); }
    catch (e) { console.error(`  Remove needs: triage failed: ${e.message}`); }
  }

  if (d.comment) {
    const body = d.comment.includes(MARKER) ? d.comment : `${MARKER}\n${d.comment}`;
    console.log('  Posting comment');
    try { gh(['issue', 'comment', String(num), '-R', REPO, '--body-file', '-'], body); }
    catch (e) { console.error(`  Post comment failed: ${e.message}`); }
  }
}

async function triageOne(issueNum, openIssuesForDupes = null) {
  console.log(`\n=== Triaging issue #${issueNum} ===`);
  const issue = getIssue(issueNum);
  const rt = extractResourceType(issue.body, issue.title);
  const ver = extractApiVersion(issue.body, issue.title);
  const userUrl = userProvidedDocsUrl(issue.body);
  const docsUrl = userUrl || buildDocsUrl(rt, ver);
  console.log(`  Extracted: rt=${rt} ver=${ver}`);
  console.log(`  Docs URL:  ${docsUrl}`);
  const docs = await fetchDocs(docsUrl);
  console.log(`  Docs fetch status: ${docs.status ?? 'unreachable'}`);

  let openIssuesContext = '';
  if (MODE === 'on-open' && openIssuesForDupes) {
    const summarized = openIssuesForDupes
      .filter(i => i.number !== issueNum)
      .map(i => ({
        number: i.number,
        title: i.title,
        createdAt: i.createdAt,
        resourceType: extractResourceType(i.body, i.title),
        apiVersion: extractApiVersion(i.body, i.title),
      }));
    openIssuesContext = JSON.stringify(summarized, null, 2);
  }

  const userPromptLines = [
    '## Issue to triage',
    `Number: ${issue.number}`,
    `Title: ${issue.title}`,
    `Created: ${issue.createdAt}`,
    `Current labels: ${(issue.labels || []).map(l => l.name).join(', ') || '(none)'}`,
    '',
    '### Body',
    issue.body || '(empty)',
    '',
    '## Extracted fields (best-effort regex)',
    `Resource Type: ${rt || 'NOT FOUND'}`,
    `Api Version:   ${ver || 'NOT FOUND'}`,
    `Docs URL:      ${docsUrl || 'NOT BUILT'}`,
    `Docs status:   ${docs.status ?? 'unreachable'}`,
    '',
    '## Docs page text (first 8000 chars, HTML stripped)',
    docs.snippet ? '```\n' + docs.snippet + '\n```' : '(unavailable)',
    '',
    MODE === 'on-open'
      ? '## Currently open issues in this repo (for duplicate detection)'
      : '## Duplicate detection — SKIP for this run (Mode: sweep)',
    MODE === 'on-open' ? '```json\n' + openIssuesContext + '\n```' : '',
    '',
    `## Mode: ${MODE}`,
    MODE === 'sweep'
      ? 'Skip Step 5 (duplicate detection) per the playbook.'
      : 'Run all six steps of the playbook.',
    '',
    'Respond with ONLY the JSON object specified at the end of the playbook. No prose, no markdown fences.',
  ];
  const userPrompt = userPromptLines.join('\n');

  const decision = await callLLM(playbook, userPrompt);
  console.log(`  Decision: ${JSON.stringify(decision)}`);
  const errs = validateDecision(decision);
  if (errs.length) {
    console.error(`  Validation errors: ${errs.join('; ')}`);
    console.error('  Aborting application of this decision.');
    return;
  }
  applyDecision(issueNum, decision);
}

async function main() {
  console.log(`Triage starting. mode=${MODE} model=${MODEL} repo=${REPO}`);

  if (MODE === 'on-open') {
    if (!ISSUE) { console.error('Missing ISSUE_NUMBER for on-open mode'); process.exit(1); }
    const openIssues = listOpenIssues();
    await triageOne(parseInt(ISSUE, 10), openIssues);
    return;
  }

  if (MODE === 'sweep') {
    const openIssues = listOpenIssues();
    const candidates = openIssues.filter(i => {
      const labels = (i.labels || []).map(l => l.name);
      const hasManaged = labels.some(n => ALL_MANAGED_LABELS.has(n) || /^Microsoft\./.test(n));
      return !hasManaged;
    });
    console.log(`Sweep: ${candidates.length} of ${openIssues.length} open issues will be triaged.`);
    for (const i of candidates) {
      try { await triageOne(i.number, null); }
      catch (e) { console.error(`Issue #${i.number} failed: ${e.message}`); }
    }
    return;
  }

  console.error(`Unknown mode: ${MODE}`);
  process.exit(1);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });

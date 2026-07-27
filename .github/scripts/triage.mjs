// Auto-triage engine for stephaniezyen/bicep-types-az.
//
// This is the single source of truth for the heuristic issue-triage logic.
// It is invoked by .github/workflows/triage.yml, which dynamic-imports this
// module and calls run() with the actions/github-script toolkit:
//
//   const { pathToFileURL } = require('url');
//   const { run } = await import(pathToFileURL(
//     process.env.GITHUB_WORKSPACE + '/.github/scripts/triage.mjs').href);
//   await run({ github, context, core });
//
// Params:
//   github  - authenticated Octokit REST client (actions/github-script)
//   context - workflow event context (context.repo, context.payload.issue, ...)
//   core    - @actions/core (core.info / core.warning / ...)
// Uses the global fetch (Node 20+) to pull generated types.md from
// Azure/bicep-types-az. No LLM, no external dependencies.

// ============================================================================
// Pure heuristics — hoisted to module scope so CI (triage.test.mjs) can
// unit-test them directly. None of these touch github/context/core; run()
// below wires them to the live GitHub API.
// ============================================================================

const MARKER = '<!-- auto-triage-bot:v3 -->';
const TYPES_REPO = 'Azure/bicep-types-az';
const [TYPES_OWNER, TYPES_NAME] = TYPES_REPO.split('/');
const TYPES_BRANCH = 'main';
const RAW_BASE = `https://raw.githubusercontent.com/${TYPES_REPO}/${TYPES_BRANCH}/generated`;
const UA = 'bicep-types-az-triage-bot/3.0';

// PascalCase Microsoft.<Namespace> — case-sensitive to avoid matching
// domain names like `learn.microsoft.com`. The namespace segment must
// start with an uppercase letter and contain at least 3 chars total.
const RP_REGEX = /(?<![.\/\w])Microsoft\.[A-Z][A-Za-z0-9]{2,}/g;
const TYPE_REGEX = /(?<![.\/\w])Microsoft\.[A-Z][A-Za-z0-9]{2,}(?:\/[A-Za-z][A-Za-z0-9]*)+/g;

// --- Missing-property heuristic (proximity-based, not regex pile) ---
//
// We detect "missing property" language by looking for one of:
//   (a) a "miss" word (missing, lacks, lacking, unrecognized, not allowed,
//       not exposed, doesn't have, etc.) near a "prop" word
//       (property/properties/field/fields/attribute/attributes), in either
//       direction, within a short token window; OR
//   (b) a "miss" verb phrase followed by an identifier that is plausibly a
//       property name (camelCase or backticked).
//
// Property-name extraction looks for the closest identifier to the "prop"
// word (preferring quoted/backticked identifiers, then camelCase tokens),
// filtered against a stopword set.

// Generic "missing-ness" words and short phrases.
const MISS_TERMS = [
  'missing', 'lacks', 'lack', 'lacking',
  'unrecognized', 'unsupported', 'unavailable',
  'not allowed', 'not permitted', 'not recognized', 'not supported',
  'not accepted', 'not exposed', 'not defined', 'not present',
  'not listed', 'not available', "doesn't have", 'does not have',
  "doesn't expose", 'does not expose', "doesn't include", 'does not include',
  "doesn't support", 'does not support', "doesn't define", 'does not define',
  'should have', 'should include', 'should support', 'should expose',
  'should add', 'needs to have', 'needs to add', 'add support for',
  'rejected',
];
const PROP_TERMS = ['property', 'properties', 'field', 'fields', 'attribute', 'attributes'];

// Build an alternation regex (escape spaces; '.' isn't used in any term).
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const missAlt = MISS_TERMS.map(escapeRe).join('|');
const propAlt = PROP_TERMS.join('|');

// Stricter boundaries for the "prop word" — must not be inside a
// hyphenated compound like "reference-property" (which is not the
// user asserting a property is missing — it's ARM internal jargon).
const PROP_WORD_PATTERN = `(?<![\\w-])(?:${propAlt})(?![\\w-])`;
// Co-occurrence within a small character window (~80 chars ≈ 12-15 tokens).
// Direction-agnostic: either "miss ... prop" or "prop ... miss".
const MISS_NEAR_PROP = new RegExp(
  `(?:\\b(?:${missAlt})\\b[^\\n.]{0,80}?${PROP_WORD_PATTERN})` +
  `|` +
  `(?:${PROP_WORD_PATTERN}[^\\n.]{0,80}?\\b(?:${missAlt})\\b)`,
  'i'
);

// For property-name extraction we want the identifier closest to the
// "property" word. Strategy:
//   1. Scan the text for any occurrence of a "prop" word.
//   2. Within a 60-char window on either side, find candidate identifiers:
//      preferred = `quoted`, "quoted", or 'quoted'; fallback = camelCase
//      or PascalCase tokens >= 3 chars long, filtered against stopwords.
//   3. If still nothing, look for "missing <camelCaseName>" patterns
//      (title shorthand like "Missing networkAcls").
const PROP_WORD_REGEX = new RegExp(PROP_WORD_PATTERN, 'gi');
const QUOTED_IDENT = /[`'"]([A-Za-z_][\w.-]*)[`'"]/g;
const CAMEL_IDENT = /\b([A-Za-z_][\w.-]*)\b/g;

// Strong signals that the issue is about a *resource* missing or a
// deployment failure, NOT a missing schema property. When the only
// missing-property language sits inside such a trace, we should not
// classify the issue as "missing property".
const RESOURCE_NOT_FOUND_PATTERNS = [
  /\bResource(?:Group)?NotFound\b/,
  /\bResource\s+['"`][^'"`\n]+['"`]?\s+(?:does\s+not\s+exist|was\s+not\s+found|cannot\s+be\s+found)\b/i,
  /\bResource\s+not\s+found\b/i,
  /\bDeploymentFailed\b/,
  /\b"code"\s*:\s*"NotFound"/i,
  /\bcode\s*[:=]\s*['"]?NotFound['"]?/i,
];
const RESOURCE_NOT_FOUND_RE = new RegExp(
  RESOURCE_NOT_FOUND_PATTERNS.map(r => r.source).join('|'),
  'i'
);

const PROPERTY_NAME_STOPWORDS = new Set([
  'the','a','an','this','that','these','those','my','our','your','their','its','his','her',
  'one','no','any','some','all','each','every','first','last','new','old','same','other','another',
  'is','are','was','were','will','should','must','can','may','might','has','have','had','do','does','did',
  'and','or','but','not','if','when','then','so','because','also','only','just','still','already',
  'required','optional','important','expected','missing','lack','lacks','lacking',
  'property','properties','field','fields','attribute','attributes',
  'type','types','resource','resources','definition','schema','api','for','of','on','in','from','with',
  'unrecognized','unsupported','allowed','permitted','recognized','supported','accepted','exposed',
  'value','values','string','strings','int','integer','number','bool','boolean','array',
  // Literal values and common placeholder identifiers that are never
  // property names.
  'true','false','null','undefined','foo','bar','baz','qux','todo','xxx','yyy','zzz',
  'azure','microsoft','i','it','we','you','they','please','need','want',
  // Common tag/prefix words found in issue titles like "Test:", "Bug:", "Feature:".
  'test','tests','testing','bug','bugs','feature','fix','wip','draft','rfc','question','help',
  'bicep','arm','json','yaml','terraform','template','templates','repro','example','examples',
  // Common Azure resource-type plural segments that camelCase but aren't properties.
  'services','workspaces','accounts','storageaccounts','virtualmachines','servers','databases',
  'webtests','networkinterfaces','components','registrations','registries','vaults',
  // Common English words that show up as sentence-starters or noise in
  // issue prose but are not property names.
  'error','errors','based','however','additionally','note','notes','there','here',
  'deployment','deployments','deploy','deployed','deploying',
  'trying','tried','using','used','set','setting','sets',
  'above','below','following','followed','after','before','during','while',
  'reference','references','referenced','object','objects',
  // Product/technology names that commonly appear as prose references.
  'redis','graph','cosmos','sql','kusto','synapse','fabric','purview',
  // API/protocol acronyms that show up in prose ("REST API", "SDK", etc.)
  'rest','apis','sdk','http','https','url','uri',
  // Partial-word fragments that show up when regex splits on punctuation
  // (e.g. "ApiCenter services" → "ApiCe").
  'apice','microsof','azur',
  // ARM/JSON error-envelope keys. Deployment/preflight errors are pasted
  // as JSON whose keys (`"message"`, `"code"`, `"target"`, ...) sit right
  // next to the word "property" (e.g. `"message": "Account property
  // accessTier is required"`), so the prose miner would otherwise extract
  // them as property names. These are never Bicep resource properties in
  // that context.
  'message','messages','code','codes','target','targets','details','detail',
  'innererror','correlationid','statuscode','requestid','activityid','timestamp',
  'additionalinfo','tracking','trackingid',
]);

function isPlausiblePropertyName(name) {
  if (!name) return false;
  if (name.length < 3) return false;
  if (PROPERTY_NAME_STOPWORDS.has(name.toLowerCase())) return false;
  if (/^\d+$/.test(name)) return false;
  // Must contain at least one letter.
  if (!/[A-Za-z]/.test(name)) return false;
  // Reject markdown-emphasis / placeholder artifacts that begin or
  // end with an underscore (e.g. "_No", "response_" from a stray
  // `_No response_`, or "_New-AzDeployment"). Real ARM/Bicep
  // property names never start or end with an underscore.
  if (/^_|_$/.test(name)) return false;
  // Reject hyphenated tokens. Real ARM/Bicep property names are
  // camelCase and never contain hyphens — a hyphenated token is
  // almost always a CLI flag or query param that leaked in from a
  // repro ("what-if", "api-version", "resource-group"), not a
  // schema property. (Dotted paths like "properties.foo" are still
  // allowed; only the hyphen is disqualifying.)
  if (name.includes('-')) return false;
  // Reject truncated "Microsoft.X" namespace fragments that survive
  // in stale bot-renamed titles — e.g. "soft.Web", "oft.Web",
  // "t.App", "osoft.Network". These are a short all-lowercase run
  // followed by a dot and a PascalCase segment, which no real
  // property path produces (real dotted paths are camelCase, e.g.
  // "properties.frontendIPConfigurations").
  if (/^[a-z]{1,6}\.[A-Z]/.test(name)) return false;
  // Reject GUID / hash / correlation-id fragments (e.g.
  // "c376fff78aa", "ba1e9f8c1e", "abff-08a26baeb411",
  // "e1e6d94240a50608b998437f32"). These leak in from resource
  // names, storage keys, and correlation IDs in user repros and
  // are never property names. A property name is never a run of
  // 8+ hex digits (optionally hyphen-separated like a GUID).
  if (/^[0-9a-fA-F]{8,}$/.test(name.replace(/-/g, ''))) return false;
  return true;
}
function isLikelyIdentifier(name) {
  // Real property names are camelCase/PascalCase or contain digits/underscores.
  // Plain-English words of any length (e.g. "noticed", "missing") shouldn't qualify.
  if (/^Microsoft\./i.test(name)) return false;
  return /[A-Z]/.test(name) || /[_\d]/.test(name);
}

// Collapse redundant path forms of the same property to a single clean
// entry. ARM properties are all nested under `properties`, so a leading
// `properties.` prefix is pure noise; and when a reporter (or our own
// extraction) surfaces both a bare leaf (`disablePasswordAuthentication`)
// and one or more dotted ancestors of it
// (`linuxConfiguration.disablePasswordAuthentication`,
// `properties.osProfile.linuxConfiguration.disablePasswordAuthentication`),
// they all refer to the same property. Keying by the lowercased leaf and
// keeping the first occurrence (order-preserving) yields stable, readable
// titles/labels and also improves docs verification, which matches on the
// leaf token rather than a dotted path.
function canonicalizeProperties(names) {
  const byLeaf = new Map(); // leafLower -> chosen display form
  for (const raw of names || []) {
    if (!raw) continue;
    let name = raw;
    // Strip any number of leading `properties.` segments.
    while (/^properties\./i.test(name)) name = name.slice('properties.'.length);
    if (!name) continue;
    const leaf = name.split('.').pop();
    if (!leaf) continue;
    const key = leaf.toLowerCase();
    if (!byLeaf.has(key)) byLeaf.set(key, leaf);
  }
  return [...byLeaf.values()];
}

// Build a set of "off-limits" tokens dynamically: any segment of a
// detected resource type (e.g. "storageAccounts" from
// "Microsoft.Storage/storageAccounts") shouldn't be returned as a
// property name — it's the resource itself.
function buildExclusions(typeStrings) {
  const ex = new Set();
  for (const t of typeStrings || []) {
    for (const seg of t.split('/')) {
      // skip "Microsoft.X" namespaces
      if (seg.toLowerCase().startsWith('microsoft.')) continue;
      ex.add(seg.toLowerCase());
    }
  }
  return ex;
}

// Strip common title-prefix tags that look like "Tag: rest of title".
// Examples: "Test: ...", "Bug: ...", "[Microsoft.X/y]: ...".
function stripTitlePrefix(title) {
  return (title || '')
    .replace(/^\s*\[[^\]]+\]\s*:\s*/, '')        // [Microsoft.X/y]: ...
    .replace(/^\s*[A-Za-z][\w-]{0,15}\s*:\s+/, '') // Test: / Bug: / WIP: ...
    .trim();
}

function extractPropertyCandidates(text, excludeNames) {
  excludeNames = excludeNames || new Set();
  const candidates = [];
  const seen = new Set(); // dedupe by lowercased name
  const propMatches = [...text.matchAll(PROP_WORD_REGEX)];
  for (const pm of propMatches) {
    const idx = pm.index;
    const winStart = Math.max(0, idx - 60);
    const winEnd = Math.min(text.length, idx + pm[0].length + 60);
    const window = text.slice(winStart, winEnd);
    const addCandidate = (name, offset, quoted) => {
      if (!isPlausiblePropertyName(name)) return;
      if (excludeNames.has(name.toLowerCase())) return;
      const key = name.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push({ name, offset, quoted, distance: Math.abs(offset - idx) });
    };
    let qm;
    QUOTED_IDENT.lastIndex = 0;
    while ((qm = QUOTED_IDENT.exec(window)) !== null) {
      // Even quoted tokens must start lowercase to be a property
      // name/key. Quoted PascalCase tokens are enum string VALUES
      // (e.g. `type: 'SystemAssigned'`, `sku: 'Standard'`) or ARM
      // JSON PascalCase keys — not the Bicep camelCase property.
      if (!/^[a-z]/.test(qm[1])) continue;
      addCandidate(qm[1], winStart + qm.index, true);
    }
    let cm;
    CAMEL_IDENT.lastIndex = 0;
    while ((cm = CAMEL_IDENT.exec(window)) !== null) {
      // Reject matches truncated by the window slice: if the match
      // butts up against a window edge that isn't the true start/end
      // of the text, it's a partial word (e.g. "Microsoft" → "oft" or
      // "Whenever" → "Whe") and must be discarded.
      if (cm.index === 0 && winStart > 0) continue;
      if (cm.index + cm[0].length === window.length && winEnd < text.length) continue;
      if (!isLikelyIdentifier(cm[1])) continue;
      // Unquoted prose candidates must look like a real ARM/Bicep
      // property reference, which is camelCase starting with a
      // lowercase letter (optionally a dotted path like
      // `properties.fooBar`). PascalCase / ALL-CAPS bare tokens are
      // almost always type names, enum VALUES (e.g. "SystemAssigned",
      // "Standard"), acronyms ("CPU", from "VS Code" → "Code"), or
      // sentence-leading English words ("Thanks", "Redirect") — not
      // property names. Quoted candidates bypass this (handled above).
      if (!/^[a-z]/.test(cm[1])) continue;
      addCandidate(cm[1], winStart + cm.index, false);
    }
  }
  // Also catch "missing <camelCaseName>" shorthand. Accept either a
  // camelCase hump (`networkAcls`) OR a lowercase-with-digit identifier
  // (`oauth2scopes`, `b2cName`) — the digit run is itself enough of an
  // identifier signal to distinguish a property from a plain English word.
  const shorthandRe = /\b[Mm]issing\s+[`'"]?([a-z][a-zA-Z0-9]*(?:[A-Z][A-Za-z0-9]{2,}|[0-9][A-Za-z]{2,}))[`'"]?\b/g;
  let sm;
  while ((sm = shorthandRe.exec(text)) !== null) {
    const name = sm[1];
    if (!isPlausiblePropertyName(name)) continue;
    if (excludeNames.has(name.toLowerCase())) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ name, offset: sm.index, quoted: true, distance: 0 });
  }
  // Reverse shorthand: "<camelCaseName> (is) missing". PROP_WORD only
  // anchors on property/field/attribute, so a title like
  // "vnetEncryptionSupported missing" or
  // "logicAppsAccessControlConfiguration missing" has no anchor and
  // would otherwise be dropped. Requiring the camelCase shape
  // (lowercase start + an internal uppercase hump) keeps this from
  // firing on ordinary prose words before "missing".
  const shorthandRe2 = /\b([a-z][a-zA-Z0-9]*(?:[A-Z][A-Za-z0-9]{2,}|[0-9][A-Za-z]{2,}))[`'"]?\s+(?:is\s+|are\s+|was\s+|were\s+)?[Mm]issing\b/g;
  let sm2;
  while ((sm2 = shorthandRe2.exec(text)) !== null) {
    const name = sm2[1];
    if (!isPlausiblePropertyName(name)) continue;
    if (excludeNames.has(name.toLowerCase())) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ name, offset: sm2.index, quoted: true, distance: 0 });
  }
  candidates.sort((a, b) => (b.quoted - a.quoted) || (a.distance - b.distance));
  return candidates;
}

// Catches phrasings like:
//   "networkAcls is not allowed"
//   "publicNetworkAccess is not recognized"
//   "The property `foo` is unsupported"
// — i.e. the missing-ness verb is right after a candidate identifier.
const INVERTED_PHRASE_RE =
  /[`'"]?([A-Za-z][A-Za-z0-9_]{2,})[`'"]?\s+(?:is|are)\s+(?:not\s+)?(?:allowed|recognized|supported|permitted|accepted|valid|defined|present|available)\b/g;
function extractInvertedFallback(text, excludeNames) {
  excludeNames = excludeNames || new Set();
  INVERTED_PHRASE_RE.lastIndex = 0;
  let m;
  while ((m = INVERTED_PHRASE_RE.exec(text)) !== null) {
    const name = m[1];
    if (!isPlausiblePropertyName(name)) continue;
    if (!isLikelyIdentifier(name)) continue;
    if (excludeNames.has(name.toLowerCase())) continue;
    return name;
  }
  return null;
}

// High-confidence extraction from ARM/Bicep error messages that spell out
// BOTH the property name AND the container-type name. Examples:
//   The property "publicNetworkAccess" is not allowed on objects of type "ClusterProperties"
//   Property 'foo' is not allowed on type 'Bar'
//   'foo' is not a valid property of type 'Bar'
//   Property 'foo' is not defined on type 'Bar'
//   Unknown property 'foo' on type 'Bar'
//
// Returns { properties: [names...], containerTypes: [names...] }.
// Properties are high-confidence; container types are excluded from
// being interpreted as property names elsewhere in the pipeline.
function extractErrorPatterns(text) {
  const properties = [];
  const containerTypes = [];
  const patterns = [
    // "property 'X' is (not) allowed on (objects of) type 'Y'"
    /(?:the\s+)?property\s+["'`]\**([A-Za-z_][\w.-]*)\**["'`]\s+is\s+(?:not\s+)?allowed\s+on\s+(?:objects?\s+of\s+)?type\s+["'`]\**([A-Za-z_][\w.-]*)\**["'`]/gi,
    // "'X' is not a valid property of (type) 'Y'"
    /["'`]\**([A-Za-z_][\w.-]*)\**["'`]\s+is\s+not\s+a\s+valid\s+property\s+(?:of|on)\s+(?:type\s+)?["'`]\**([A-Za-z_][\w.-]*)\**["'`]/gi,
    // "property 'X' is not defined on (type) 'Y'"
    /property\s+["'`]\**([A-Za-z_][\w.-]*)\**["'`]\s+is\s+not\s+(?:defined|declared|present)\s+on\s+(?:type\s+)?["'`]\**([A-Za-z_][\w.-]*)\**["'`]/gi,
    // "unknown property 'X' on (type) 'Y'"
    /unknown\s+property\s+["'`]\**([A-Za-z_][\w.-]*)\**["'`]\s+(?:on|for)\s+(?:type\s+)?["'`]\**([A-Za-z_][\w.-]*)\**["'`]/gi,
    // "property 'X' not found on (type) 'Y'"
    /property\s+["'`]\**([A-Za-z_][\w.-]*)\**["'`]\s+(?:not\s+found|does\s+not\s+exist)\s+on\s+(?:type\s+)?["'`]\**([A-Za-z_][\w.-]*)\**["'`]/gi,
    // "`X` property of (type) `Y`" — user quoting property + its container type
    /["'`]\**([A-Za-z_][\w.-]*)\**["'`]\s+property\s+of\s+(?:type\s+)?["'`]\**([A-Za-z_][\w.-]*)\**["'`]/gi,
    // "property `X` of (type) `Y`" — same, alternate word order
    /property\s+["'`]\**([A-Za-z_][\w.-]*)\**["'`]\s+of\s+(?:type\s+)?["'`]\**([A-Za-z_][\w.-]*)\**["'`]/gi,
    // Bicep diagnostic code tied to a property: "raises BCP187 for
    // `kind`", "BCP037 warning for `parameterValueType`". The BCP
    // code makes this a high-confidence property reference.
    /\bBCP\d+\b(?:\s+(?:warning|error))?\s+(?:for|on)\s+["'`]\**([A-Za-z_][\w.-]*)\**["'`]/gi,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      if (isPlausiblePropertyName(m[1])) properties.push(m[1]);
      if (m[2]) containerTypes.push(m[2]);
    }
  }
  // Reversed-order patterns where the CONTAINER type is named BEFORE
  // the property — e.g. Bicep's `The type "ApiConnectionDefinition
  // Properties" does not contain property "connectionRuntimeUrl".`
  // Here capture group 1 is the container and group 2 is the property
  // (the opposite of the patterns above), so map them accordingly.
  const reversedPatterns = [
    /\btype\s+["'`]\**([A-Za-z_][\w.-]*)\**["'`]\s+does(?:\s+not|n['’]?t)\s+(?:contain|include|define|declare|have)\s+(?:the\s+|a\s+)?(?:property|member)\s+["'`]\**([A-Za-z_][\w.-]*)\**["'`]/gi,
  ];
  for (const re of reversedPatterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m[1]) containerTypes.push(m[1]);
      if (isPlausiblePropertyName(m[2])) properties.push(m[2]);
    }
  }
  return { properties, containerTypes };
}

// Extract property names from a structured "properties:" list in
// prose — e.g. a user writing:
//     properties:
//       parameterValueType
//       alternativeParameterValues
// Only identifiers indented UNDER a bare `properties:` header are
// returned; siblings at or above the header indent (like a
// top-level `kind`) are ignored. High-confidence: this shorthand
// enumerates exactly the properties the reporter means.
function extractIndentedPropertyList(text) {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const out = [];
  const seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    const head = /^(\s*)properties\s*:\s*$/i.exec(lines[i]);
    if (!head) continue;
    const headIndent = head[1].length;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (/^\s*$/.test(line)) break;                 // blank line ends block
      const item = /^(\s*)(?:[-*]\s+)?([A-Za-z_][\w.-]*)\s*(?::.*)?$/.exec(line);
      if (!item) break;                              // non-item line ends block
      if (item[1].length <= headIndent) break;       // not nested under header
      const name = item[2];
      if (!isPlausiblePropertyName(name)) continue;
      const k = name.toLowerCase();
      if (!seen.has(k)) { seen.add(k); out.push(name); }
    }
  }
  return out;
}

// Returns ALL plausible property names found across layers (deduped),
// preserving the precedence: title-layer candidates first.
function extractAllMissingProperties(title, body, types) {
  const fullText = (title || '') + '\n' + (body || '');
  // High-confidence error-message patterns come first — they yield both
  // the property AND the container-type to exclude from other paths.
  const errPat = extractErrorPatterns(fullText);
  const exclude = buildExclusions(types);
  for (const ct of errPat.containerTypes) exclude.add(ct.toLowerCase());
  const out = [];
  const seen = new Set();
  const pushName = (p) => {
    if (!p) return;
    const k = p.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(p); }
  };
  // High-confidence layer A: structured error-message patterns.
  for (const p of errPat.properties) pushName(p);
  // High-confidence layer B: definitively-missing linter/ARM phrases
  // (e.g. `The property "identity" does not exist in the resource or
  // type definition`). Both A and B are trustworthy structured Bicep/
  // ARM diagnostics, so we MERGE them rather than letting whichever
  // matches first win — an issue that quotes two DIFFERENT error
  // shapes (e.g. `The property "kind" does not exist...` AND `The type
  // "X" does not contain property "connectionRuntimeUrl"`) must
  // surface BOTH property names, not just the first.
  for (const re of DEFINITIVELY_MISSING_REGEXES) {
    const rg = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m;
    while ((m = rg.exec(fullText)) !== null) pushName(m[1]);
  }
  // If either high-confidence layer named properties, trust ONLY those.
  // Don't augment with prose-mined identifiers that tend to pull noise
  // words ("However", "Code", "Error") out of surrounding sentences.
  if (out.length > 0) return canonicalizeProperties(out);
  // Structured "properties:" list in prose (indented enumeration)
  // — e.g. `properties:` followed by indented `parameterValueType`
  // / `alternativeParameterValues`. High confidence: return ONLY
  // these, skipping the noisier prose layers that pull identifiers
  // out of the surrounding Bicep repro.
  const listed = extractIndentedPropertyList(stripCode(body || ''));
  for (const p of listed) {
    const k = p.toLowerCase();
    if (!exclude.has(k) && !seen.has(k)) { seen.add(k); out.push(p); }
  }
  if (out.length > 0) return canonicalizeProperties(out);
  const layers = [
    stripTitlePrefix(title),
    stripCode(body || ''),
    body || '',
  ];
  for (const layer of layers) {
    if (!layer) continue;
    const cands = extractPropertyCandidates(layer, exclude);
    for (const c of cands) {
      const k = c.name.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(c.name);
    }
  }
  if (out.length === 0) {
    const fb = extractInvertedFallback(fullText, exclude);
    if (fb) out.push(fb);
  }
  return canonicalizeProperties(out);
}

// Strip fenced/inline code blocks so extraction doesn't pull identifiers
// out of Bicep/JSON repros (where any quoted string can look like a property).
function stripCode(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]+`/g, ' ');
}

// Language indicating "the type itself is unavailable / doesn't exist /
// hasn't been generated yet". This is distinct from "the type exists but
// its schema is wrong" (TYPE_ISSUE_REGEXES below).
const TYPE_UNAVAILABLE_REGEXES = [
  /\b(?:resource\s+)?type\s+(?:is\s+)?(?:unavailable|not\s+available|not\s+found)\b/i,
  /\bresource\s+type\s+(?:is\s+)?missing\b/i,
  /\btype\s+does(?:\s+not|n['']?t)\s+exist\b/i,
  /\bno\s+such\s+resource\s+type\b/i,
  /\bunknown\s+resource\s+type\b/i,
  /\bBCP081\b/i,
  /\bResource\s+type\s+[^\n.]{0,80}\s+does\s+not\s+have\s+types\s+available\b/i,
  /\b(?:type|types)\s+(?:for|of)\s+[`'"][^`'"\n]+[`'"]\s+(?:are\s+|is\s+)?(?:not\s+)?(?:yet\s+)?(?:available|defined|generated|published)\b/i,
  /\bno\s+types\s+(?:available|defined|generated|published)\b/i,
  /\btypes?\s+(?:not\s+)?(?:yet\s+)?(?:generated|published|defined)\b/i,
  /\bmissing\s+(?:resource\s+)?type\s+definition\b/i,
  // ARM runtime: "The resource type 'X' could not be found in the namespace 'Y'"
  /\bresource\s+type\s+["'`][^"'`\n]+["'`]\s+could\s+not\s+be\s+found\s+in\s+the\s+namespace\b/i,
  /\bcould\s+not\s+be\s+found\s+in\s+the\s+namespace\b/i,
];

// Explicit "property is missing" phrases — used as a HIGH-CONFIDENCE
// signal for the missing-property classification. Unlike the loose
// proximity heuristic (MISS_NEAR_PROP), these require the user to
// literally state that a specific property is missing.
const EXPLICIT_MISSING_PROP_REGEXES = [
  // "<X> property is missing" / "<X> property missing" / "<X> properties missing"
  /\b([A-Za-z_][\w.-]*)\s+propert(?:y|ies)\s+(?:is\s+|are\s+)?missing\b/i,
  // "property <X> is missing"
  /\bproperty\s+["'`]?([A-Za-z_][\w.-]*)["'`]?\s+is\s+missing\b/i,
  // "missing property <X>" / "Missing property(s): <X>"
  /\bmissing\s+propert(?:y|ies)(?:\s*\(s\))?[\s:]+["'`]?([A-Za-z_][\w.-]*)["'`]?/i,
  // "is missing the <X> property"
  /\bis\s+missing\s+(?:the\s+)?["'`]?([A-Za-z_][\w.-]*)["'`]?\s+property\b/i,
  // Inverted: "does not expose <X> property", "doesn't have <X> property",
  // "type does not have a <X> property", "does not include <X>"
  /\b(?:doesn['']?t|does\s+not|do\s+not|don['']?t)\s+(?:expose|include|have|contain|define|support)\s+(?:an?\s+|the\s+)?["'`]?([A-Za-z_][\w.-]*)["'`]?\s+propert/i,
  // "type definition does not expose (a|the) <X>"
  /\btype\s+(?:definition\s+)?(?:doesn['']?t|does\s+not)\s+(?:expose|include|have|contain|define)\s+(?:an?\s+|the\s+)?["'`]?([A-Za-z_][\w.-]*)["'`]?\b/i,
  // "lacks (a|the) <X> property" / "lacking <X>"
  /\black(?:s|ing)?\s+(?:an?\s+|the\s+)?["'`]?([A-Za-z_][\w.-]*)["'`]?\s+propert/i,
  // "no <X> property"
  /\bno\s+["'`]?([A-Za-z_][\w.-]*)["'`]?\s+propert(?:y|ies)\b/i,
  // Bicep linter diagnostic: `The property "X" does not exist in the
  // resource or type definition, although it might still be valid.`
  // (Also matches "in the resource type definition" / "in the type
  // definition" variants that appear in older tooling output.)
  /\bproperty\s+["'`]([A-Za-z_][\w.-]*)["'`]\s+does\s+not\s+exist\s+in\s+the\s+(?:resource\s+(?:or\s+type\s+)?|type\s+)?definition\b/i,
];

// A subset of EXPLICIT_MISSING_PROP_REGEXES whose wording is so
// unambiguous that the classifier treats them as an OVERRIDE — i.e.
// the issue is missing-property even when the reporter picked
// "Inaccurate property type(s)" (or another type-issue phrasing) in
// the issue template. These are literal error messages emitted by
// Bicep / ARM saying the property is not defined, not messages
// about a property having the wrong type.
const DEFINITIVELY_MISSING_REGEXES = [
  /\bproperty\s+["'`]([A-Za-z_][\w.-]*)["'`]\s+does\s+not\s+exist\s+in\s+the\s+(?:resource\s+(?:or\s+type\s+)?|type\s+)?definition\b/i,
];

// Language indicating "the type exists but its schema is wrong".
// Intentionally separate from missing-property + types-unavailable.
const TYPE_ISSUE_REGEXES = [
  /\btype\s+(?:definition\s+)?is\s+(?:wrong|incorrect|inaccurate)/i,
  /\btype\s+(?:definition\s+)?(?:for|of)\b[^\n]{0,100}?\bis\s+(?:wrong|incorrect|inaccurate)/i,
  /\b(?:wrong|incorrect|inaccurate)\s+type\s+(?:for|on)\b/i,
  /\b(?:doesn['']?t|does\s+not|don['']?t|do\s+not)\s+(?:accept|allow)\b/i,
  /\bshould\s+(?:accept|allow)\b/i,
  /\brejects?\b[^\n]{0,40}?\b(?:string|int|integer|number|bool|boolean|array|value)\b/i,
  // "expected a value of type X but the provided value is of type Y" —
  // classic Bicep type-mismatch diagnostic.
  /\bexpected\s+a?\s*value\s+of\s+type\b[^\n]{0,80}?\bprovided\s+value\s+is\s+of\s+type\b/i,
  // Inline template value: "Inaccurate property type(s)"
  /\binaccurate\s+propert(?:y|ies)?\s+type/i,
];

// Language indicating "the type exists and its shape is fine, but a
// property's DESCRIPTION / documentation is wrong, incomplete, or
// confusing" — the Azure issue-template's "Inaccurate/confusing
// description(s)" bucket. Kept separate from type-issue so these get
// their own `inaccurate description` label instead of being mislabeled
// or slipping through uncategorized.
const DESCRIPTION_ISSUE_REGEXES = [
  /\b(?:inaccurate|incomplete|incorrect|wrong|confusing|misleading|unclear|outdated)\s+description\b/i,
  /\bdescription\s+(?:for|of)\b[^\n]{0,80}?\bis\s+(?:inaccurate|incomplete|incorrect|wrong|confusing|misleading|unclear|outdated|missing)\b/i,
  /\bdescription\s+(?:is\s+)?(?:inaccurate|incomplete|incorrect|wrong|confusing|misleading|unclear|outdated)\b/i,
  /\b(?:doc|docs|documentation)\s+(?:for|of|on)\b[^\n]{0,80}?\b(?:is\s+)?(?:inaccurate|incomplete|incorrect|wrong|confusing|misleading|unclear|outdated)\b/i,
  /\bdocumentation\s+does(?:\s+not|n['']?t)\s+(?:mention|explain|describe|cover|say)\b/i,
];

// Language indicating a runtime/deployment bug (not a schema/type issue).
const BUG_REGEXES = [
  /\b(?:deployment|deploy|provisioning)\s+(?:fail|fails|failed|failing)\b/i,
  /\bfail(?:s|ed|ing)?\s+to\s+(?:deploy|provision|create|update)\b/i,
  /\bARM\s+(?:rejects?|errors?\s+on|throws|complains)\b/i,
  /\b(?:error\s+message|error)\s+is\s+(?:unclear|confusing|unhelpful|misleading|cryptic)\b/i,
  /\bconfusing\s+(?:error|message)\b/i,
  /\b(?:I\s+)?(?:don['']?t|do\s+not|cannot|can['']?t)\s+understand\s+(?:this|the|that)?\s*error\b/i,
  /\bhas\s+no\s+effect\s+on\s+(?:deployment|the\s+resource|the\s+deploy)\b/i,
  /\bsetting\s+\S+\s+is\s+ignored\b/i,
  /\bdoes(?:\s+not|n['']?t)\s+(?:change|affect|modify)\s+anything\b/i,
  /\bunexpected(?:ly)?\s+(?:fails|behavior|behaviour)\b/i,
  /\b(?:bug|defect)\s+in\s+(?:the\s+)?(?:resource\s+provider|RP|API|service)\b/i,
  /\bintermittent(?:ly)?\s+(?:fail|fails|failing|breaks|errors)\b/i,
];

// A subset of BUG signals whose wording is so unambiguous that the
// classifier treats them as an OVERRIDE — the user's real problem
// is a Bicep/ARM language limitation (typically wanting to loop
// over an array or dynamically expand element keys), not a schema
// defect. When any of these match, we force `bug` and suppress
// type-issue / type-unavailable / missing-property labels.
const DEFINITIVELY_BUG_REGEXES = [
  // "loop through the array" / "loop over each identity"
  /\bloop\s+(?:through|over|across)\b/i,
  // "iterate through the array"
  /\biterat(?:e|ing)\s+(?:through|over|across)\b/i,
  // Bicep `for-expression` used as a noun
  /\bfor[-\s]expression\b/i,
  // "doesn't scale well" / "not scalable" (design/language limitation)
  /\b(?:doesn['']?t|does\s+not|won['']?t|will\s+not)\s+scale\s+(?:well|nicely)?\b/i,
  /\bnot\s+scalable\b/i,
];

function normalizeNs(raw) {
  const suffix = raw.slice('Microsoft.'.length);
  const uniform = suffix === suffix.toLowerCase() || suffix === suffix.toUpperCase();
  const norm = uniform
    ? suffix[0].toUpperCase() + suffix.slice(1).toLowerCase()
    : suffix;
  return 'Microsoft.' + norm;
}

// API version extraction.
// Date-based ARM versions: yyyy-MM-dd with optional -preview / -beta /
// -alpha / -privatepreview suffix and an optional revision number
// (e.g. 2024-01-01-preview, 2024-01-01-preview-01).
const VERSION_TOKEN = /\b(\d{4}-\d{2}-\d{2}(?:-(?:preview|beta|alpha|privatepreview)(?:-\d+)?)?)\b/g;
function extractApiVersion(title, body) {
  const text = (title || '') + '\n' + (body || '');
  // 1. Azure issue-template "### Api Version" block. Tolerate BOTH the
  //    normal fenced form ("### Api Version\n\n2024-10-01") AND the
  //    flattened form ("### Api Version  2024-10-01  ### Issue Type")
  //    produced when a cross-posted body has its newlines collapsed to
  //    spaces. Confine the search to THIS section (up to the next "###"
  //    or end) so an unrelated date elsewhere in the body — e.g. the
  //    "Originally opened ... on YYYY-MM-DD" cross-post line — can't be
  //    mistaken for the API version.
  const tmpl = /###\s+Api\s+Version\b[:\s]*([\s\S]*?)(?=\s*###|$)/i.exec(text);
  if (tmpl) {
    const tm = VERSION_TOKEN.exec(tmpl[1]);
    VERSION_TOKEN.lastIndex = 0;
    if (tm) return tm[1];
  }
  VERSION_TOKEN.lastIndex = 0;
  // 2. `<type>@<version>` in resource declarations.
  const atVer = /Microsoft\.[A-Z][A-Za-z0-9]*\/[^\s'"`@]+@(\d{4}-\d{2}-\d{2}(?:-(?:preview|beta|alpha|privatepreview)(?:-\d+)?)?)/.exec(text);
  if (atVer) return atVer[1];
  // 3. apiVersion: '<version>' / "apiVersion": "<version>".
  const apiVer = /["']?api[Vv]ersion["']?\s*[:=]\s*["']?(\d{4}-\d{2}-\d{2}(?:-(?:preview|beta|alpha|privatepreview)(?:-\d+)?)?)["']?/.exec(text);
  if (apiVer) return apiVer[1];
  // 4. Fallback: most-frequently mentioned bare version token.
  const counts = new Map();
  let m;
  VERSION_TOKEN.lastIndex = 0;
  while ((m = VERSION_TOKEN.exec(text)) !== null) {
    counts.set(m[1], (counts.get(m[1]) || 0) + 1);
  }
  if (counts.size === 0) return null;
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function classify(text, opts) {
  opts = opts || {};
  const title = opts.title || '';
  const body = opts.body || '';
  // The title we mine for property NAMES. Prefer the reporter's
  // ORIGINAL title (before any bot rename) so the bot never mines
  // its own previously-generated title — that feedback loop is how
  // stale/garbage property names (repro param names, Bicep
  // functions, "Fails"/"There") get re-baked into the title on
  // every retrigger. Falls back to the current title when no
  // original is supplied (e.g. never-renamed issues).
  const miningTitle = opts.miningTitle || title;
  const rpMap = new Map();
  for (const m of text.matchAll(RP_REGEX)) {
    const c = normalizeNs(m[0]);
    if (!rpMap.has(c.toLowerCase())) rpMap.set(c.toLowerCase(), c);
  }
  const typeMap = new Map();
  for (const m of text.matchAll(TYPE_REGEX)) {
    const [ns, ...rest] = m[0].split('/');
    const c = [normalizeNs(ns), ...rest].join('/');
    if (!typeMap.has(c.toLowerCase())) typeMap.set(c.toLowerCase(), c);
  }
  const types = [...typeMap.values()];
  const stripTemplate = s => s
    .replace(/###\s+Issue\s+Type[\s\S]*?(?=###\s|$)/gi, ' ')
    // Drop the WHOLE "Bicep Repro" section (header + the user's
    // reproduction code), not just its header. The repro shows the
    // user's own parameter names, Bicep functions (toLower, etc.)
    // and working property assignments — none of which are the
    // missing property, yet the prose miner would otherwise pull
    // them into the title.
    .replace(/###\s+Bicep\s+Repro\b[\s\S]*?(?=###\s|$)/gi, ' ')
    .replace(/_No\s+response_/gi, ' ')
    .replace(/###\s+(?:Resource\s+Type|Api\s+Version|Bicep\s+Repro|Confirm|Other\s+Notes)\b/gi, ' ');
  const stripped = stripTemplate(text);
  const strippedNoCode = stripCode(stripped);
  // -- Explicit user signal: the Azure issue template asks the user
  // to pick an "Issue Type". If they set it, trust that value over
  // the loose text heuristics. Values seen in practice include
  // "Missing property(s)", "Type is unavailable", "Type is incorrect",
  // and "Bug".
  const tmplIssueType = (() => {
    // Accept both fenced form (### Issue Type\n\nValue) and inline
    // form (### Issue Type Value) — GitHub bodies fetched via API
    // sometimes get flattened onto a single line.
    const m = /###\s+Issue\s+Type\b[\s:]*([^\r\n#]+?)(?=\s*(?:###|$|\r|\n))/i.exec(text);
    if (!m) return null;
    const v = m[1].trim().toLowerCase();
    if (!v) return null;
    if (/\btype\s+is\s+unavailable\b/.test(v) ||
        /\btype\s+(?:not|un)available\b/.test(v)) return 'type-unavailable';
    if (/\bmissing\s+propert/.test(v)) return 'missing-property';
    // "Inaccurate/confusing description(s)" — check BEFORE type-issue so
    // the shared word "inaccurate" doesn't misroute it to type-issue.
    if (/description/.test(v)) return 'description-issue';
    if (/\btype\s+(?:is\s+)?(?:incorrect|wrong|inaccurate)\b/.test(v) ||
        /\binaccurate\s+propert(?:y|ies)?\s+type/.test(v)) return 'type-issue';
    if (/^bug\b/.test(v)) return 'bug';
    return null;
  })();

  // Layered extraction. Pass types so resource-type segments aren't
  // mistaken for property names. Always use the multi-layer extractor
  // so the error-pattern high-confidence path runs even when title
  // is missing.
  // Detect whether the MINING title is the bot's own canonical
  // renamed format (`[Microsoft.X/y]: <props> propert(y|ies)
  // missing`). Because miningTitle is the reporter's ORIGINAL
  // title, this is normally false — we mine genuine user wording,
  // not our own prior output.
  const isBotRenamedTitle =
    /^\s*\[Microsoft\.[^\]]+\]:\s+[\w.,\s-]+\s+propert(?:y|ies)\s+missing\s*$/i.test(miningTitle || '');
  const propertyNames = extractAllMissingProperties(
    stripTemplate(miningTitle || ''),
    stripTemplate(body || ''),
    types
  );
  const propertyName = propertyNames[0] || null;

  // Explicit missing-property signals:
  //   1. Template `### Issue Type: Missing property(s)`
  //   2. Error-message pattern `property "X" is not allowed on type "Y"`
  //      (extractErrorPatterns yielded properties)
  //   3. Literal phrase `<X> property is missing` / `Missing property <X>`
  //      etc. in the prose (not inside code blocks)
  const bodyProse = stripCode(stripTemplate(body || ''));
  const errPat = extractErrorPatterns((miningTitle || '') + '\n' + (body || ''));
  // Skip title-based EXPLICIT_MISSING_PROP_REGEXES matching when
  // the title is the bot's canonical renamed format
  // (`[<Microsoft.X/y>]: <props> propert(y|ies) missing`) — otherwise
  // the auto-generated title feeds back into the classifier and
  // spuriously labels type-issue reports as missing-property.
  // (isBotRenamedTitle computed above, before extraction.)
  const hasExplicitMissingProp =
    tmplIssueType === 'missing-property' ||
    errPat.properties.length > 0 ||
    EXPLICIT_MISSING_PROP_REGEXES.some(r => r.test(bodyProse)) ||
    (!isBotRenamedTitle && EXPLICIT_MISSING_PROP_REGEXES.some(r => r.test(miningTitle || '')));

  let hasMP = hasExplicitMissingProp;
  // Resource-not-found / deployment-failure guard still applies: even
  // if we picked up an explicit phrase, an ARM "resource not found"
  // trace with no user prose asserting the same is not a missing-prop
  // report.
  if (hasMP && RESOURCE_NOT_FOUND_RE.test(stripped) && tmplIssueType !== 'missing-property') {
    const propLanguageInProse =
      EXPLICIT_MISSING_PROP_REGEXES.some(r => r.test(bodyProse)) ||
      errPat.properties.length > 0;
    if (!propLanguageInProse) {
      hasMP = false;
    }
  }

  // Template value takes precedence over heuristics for the
  // type-unavailable / type-issue / bug categories too.
  let hasTypeUnavail =
    tmplIssueType === 'type-unavailable' ||
    TYPE_UNAVAILABLE_REGEXES.some(r => r.test(stripped));
  // Definitively-missing wording (e.g. the Bicep linter phrase
  // `The property "X" does not exist in the resource or type
  // definition`) is a strong overriding signal: reclassify as
  // missing-property and suppress the type-issue label even if the
  // reporter picked "Inaccurate property type(s)" in the template.
  const hasDefinitivelyMissing =
    DEFINITIVELY_MISSING_REGEXES.some(r => r.test(bodyProse)) ||
    DEFINITIVELY_MISSING_REGEXES.some(r => r.test(title || ''));
  if (hasDefinitivelyMissing) hasMP = true;
  let hasTypeIssue =
    !hasDefinitivelyMissing &&
    tmplIssueType !== 'description-issue' &&
    (tmplIssueType === 'type-issue' ||
     TYPE_ISSUE_REGEXES.some(r => r.test(stripped)));
  // Description/documentation issue (distinct from a wrong *type*).
  // Template selection is authoritative; prose regexes catch it when
  // the reporter didn't use the template.
  let hasDescriptionIssue =
    tmplIssueType === 'description-issue' ||
    (tmplIssueType === null && DESCRIPTION_ISSUE_REGEXES.some(r => r.test(stripped)));
  let hasBug =
    tmplIssueType === 'bug' ||
    BUG_REGEXES.some(r => r.test(stripped));

  // Definitively-bug wording (language-limitation cues like
  // wanting to loop through an array) suppresses schema-shaped
  // classifications so we don't mislabel language limitations as
  // type-issue / type-unavailable / missing-property. We do NOT
  // auto-apply the `bug` label from these cues alone — bug
  // classification still requires an explicit BUG_REGEXES match or
  // the template value.
  const hasDefinitivelyBug =
    DEFINITIVELY_BUG_REGEXES.some(r => r.test(bodyProse)) ||
    DEFINITIVELY_BUG_REGEXES.some(r => r.test(title || ''));
  if (hasDefinitivelyBug) {
    hasMP = false;
    hasTypeIssue = false;
    hasTypeUnavail = false;
    hasDescriptionIssue = false;
  }

  return {
    rps: [...rpMap.values()],
    types,
    hasMissingPropertyLanguage: hasMP,
    hasTypeIssueLanguage: hasTypeIssue,
    hasTypeUnavailableLanguage: hasTypeUnavail,
    hasDescriptionIssueLanguage: hasDescriptionIssue,
    hasBugLanguage: hasBug,
    propertyName,
    propertyNames,
    apiVersion: extractApiVersion(title, body),
    templateIssueType: tmplIssueType,
    bodyProse,
  };
}

// Case-insensitive whole-word search.
function pageHasWord(pageText, word) {
  if (!pageText || !word) return false;
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_])${esc}(?![A-Za-z0-9_])`, 'i').test(pageText);
}

// Scope a types.md down to a SINGLE resource type's schema so a
// property check can't match a property that belongs to a
// different resource sharing the same namespace file (a storage
// types.md, for example, defines ~17 resources + ~100 shared
// object types). We split the doc into `## `-delimited sections,
// then walk `[Type](#anchor)` references starting from the target
// `## Resource <type>@<version>` heading, transitively pulling in
// only the object-type definitions that resource actually uses.
// Returns '' when the resource heading can't be found (caller
// falls back to the whole document).
function scopeToResourceType(pageText, type, version) {
  if (!pageText || !type) return '';
  const lines = pageText.split(/\r?\n/);
  // GitHub-style heading -> anchor slug (with duplicate suffixing).
  const slugCounts = new Map();
  const slugify = (h) => {
    const s = h.toLowerCase().replace(/[^a-z0-9 -]/g, '').trim().replace(/\s+/g, '-');
    const n = slugCounts.get(s) || 0;
    slugCounts.set(s, n + 1);
    return n === 0 ? s : `${s}-${n}`;
  };
  const sections = [];
  let cur = null;
  for (const ln of lines) {
    const h = /^##\s+(.*\S)\s*$/.exec(ln);
    if (h) {
      cur = { heading: h[1], anchor: slugify(h[1]), body: [] };
      sections.push(cur);
    } else if (cur) {
      cur.body.push(ln);
    }
  }
  const byAnchor = new Map();
  for (const s of sections) byAnchor.set(s.anchor, s);
  const want = `resource ${type}@${version}`.toLowerCase();
  const start = sections.find(s => s.heading.toLowerCase() === want)
    || sections.find(s => s.heading.toLowerCase().startsWith(`resource ${type.toLowerCase()}@`));
  if (!start) return '';
  const refRe = /\]\(#([a-z0-9-]+)\)/g;
  const visited = new Set();
  const queue = [start];
  const out = [];
  while (queue.length) {
    const sec = queue.shift();
    if (!sec || visited.has(sec.anchor)) continue;
    visited.add(sec.anchor);
    const text = sec.heading + '\n' + sec.body.join('\n');
    out.push(text);
    let m;
    refRe.lastIndex = 0;
    while ((m = refRe.exec(text)) !== null) {
      const target = byAnchor.get(m[1]);
      if (target && !visited.has(target.anchor)) queue.push(target);
    }
  }
  return out.join('\n');
}

function hashColor(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) & 0xffffff;
  return h.toString(16).padStart(6, '0');
}

// Compare two ARM API-version strings for a DESCENDING sort (newest first).
// For the SAME date, a stable GA version outranks a -preview/-beta/-alpha of
// that date, so "latest" never resolves to a preview when a GA exists.
function compareTypeVersions(a, b) {
  const parse = (v) => {
    const m = /^(\d{4}-\d{2}-\d{2})(?:-(preview|beta|alpha|privatepreview)(?:-(\d+))?)?$/i.exec(v || '');
    if (!m) return { date: (v || '').toLowerCase(), stage: 0, rev: 0, raw: (v || '').toLowerCase() };
    return { date: m[1], stage: m[2] ? 1 : 0, rev: m[3] ? parseInt(m[3], 10) : 0, raw: (v || '').toLowerCase() };
  };
  const pa = parse(a), pb = parse(b);
  if (pa.date !== pb.date) return pa.date < pb.date ? 1 : -1; // newer date first
  if (pa.stage !== pb.stage) return pa.stage - pb.stage;      // GA(0) before preview(1)
  if (pa.rev !== pb.rev) return pb.rev - pa.rev;              // higher revision first
  return pb.raw.localeCompare(pa.raw);
}

export {
  classify,
  extractAllMissingProperties,
  canonicalizeProperties,
  extractErrorPatterns,
  extractApiVersion,
  normalizeNs,
  isPlausiblePropertyName,
  isLikelyIdentifier,
  pageHasWord,
  scopeToResourceType,
  hashColor,
  compareTypeVersions,
};

export async function run({ github, context, core }) {

// --- Property verification via Azure/bicep-types-az generated types.md ---
// Cache directory listings so we don't refetch across property lookups.
const generatedListCache = { promise: null };
const dirCache = new Map();
async function listGenerated() {
  if (!generatedListCache.promise) {
    generatedListCache.promise = (async () => {
      try {
        // Paginated so a `generated/` tree that grows past the contents
        // API's single-page cap (~1000 entries) still lists in full.
        const data = await github.paginate(github.rest.repos.getContent, {
          owner: TYPES_OWNER, repo: TYPES_NAME, path: 'generated',
          ref: TYPES_BRANCH, per_page: 100,
          headers: { 'user-agent': UA },
        });
        return (Array.isArray(data) ? data : []).map(e => e.name);
      } catch (e) {
        core.warning(`listGenerated failed: ${e.message}`);
        return [];
      }
    })();
  }
  return generatedListCache.promise;
}
async function listContents(path) {
  if (dirCache.has(path)) return dirCache.get(path);
  const p = (async () => {
    try {
      const data = await github.paginate(github.rest.repos.getContent, {
        owner: TYPES_OWNER, repo: TYPES_NAME, path,
        ref: TYPES_BRANCH, per_page: 100,
        headers: { 'user-agent': UA },
      });
      return (Array.isArray(data) ? data : []).map(e => ({ name: e.name, type: e.type }));
    } catch (e) {
      return [];
    }
  })();
  dirCache.set(path, p);
  return p;
}
// fetch() with an abort-based timeout so a hung raw.githubusercontent.com
// request can't stall the whole triage job (the workflow also caps the job
// via timeout-minutes as a backstop).
async function fetchWithTimeout(url, opts = {}, ms = 10000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}
async function fetchTypesMd(folder, ns, version) {
  const url = `${RAW_BASE}/${folder}/${ns}/${version}/types.md`;
  try {
    const res = await fetchWithTimeout(url, { headers: { 'User-Agent': UA } }, 10000);
    if (!res.ok) return { url, status: res.status, text: null };
    return { url, status: res.status, text: await res.text() };
  } catch (e) {
    return { url, status: null, text: null, error: e.message };
  }
}

// Resolve a Microsoft.X/y resource type to the types.md that
// declares it. If preferVersion is provided, try that exact
// API version first (so we verify against the version the user
// is actually using). Fall back to the latest available.
// Returns { url, status, text, version } — or null text when no
// matching definition exists.
async function fetchDocsText(type, preferVersion) {
  const parts = type.split('/');
  if (parts.length < 2 || !/^Microsoft\./i.test(parts[0])) {
    return { url: null, status: null, text: null };
  }
  const namespace = parts[0].toLowerCase(); // microsoft.containerregistry
  const slug = namespace.replace(/^microsoft\./, ''); // containerregistry
  const generated = await listGenerated();
  const slugRe = new RegExp(`^${slug.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}(_\\d+)?$`);
  const candidates = generated.filter(n => slugRe.test(n));
  if (!candidates.length) {
    return { url: null, status: 404, text: null };
  }
  // Collect every (folder, nsDir, version) triple across candidate folders.
  const all = [];
  for (const folder of candidates) {
    const entries = await listContents(`generated/${folder}`);
    const nsDir = entries.find(e => e.type === 'dir' && e.name.toLowerCase() === namespace);
    if (!nsDir) continue;
    const versions = await listContents(`generated/${folder}/${nsDir.name}`);
    for (const v of versions) {
      if (v.type === 'dir') all.push({ folder, nsDir: nsDir.name, v: v.name });
    }
  }
  if (!all.length) return { url: null, status: 404, text: null };
  // Sort newest-first. compareTypeVersions ranks a stable GA above a
  // -preview of the same date, so "latest" never resolves to a preview
  // when a GA exists.
  all.sort((a, b) => compareTypeVersions(a.v, b.v));
  // If the user pinned an API version, try exact match first so we
  // verify against what they're actually deploying.
  if (preferVersion) {
    const pv = preferVersion.toLowerCase();
    const idx = all.findIndex(c => c.v.toLowerCase() === pv);
    if (idx > 0) {
      const [pinned] = all.splice(idx, 1);
      all.unshift(pinned);
    }
  }
  const escType = type.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const markerRe = new RegExp(`^## Resource ${escType}@`, 'im');
  // Walk candidates newest-first, but fetch in small parallel batches so a
  // type that doesn't exist (or only exists in an old version) costs
  // ceil(N/BATCH) round trips instead of N sequential ones. Within a batch
  // we still honor sort order, returning the highest-ranked match.
  const BATCH = 6;
  for (let i = 0; i < all.length; i += BATCH) {
    const batch = all.slice(i, i + BATCH);
    const fetched = await Promise.all(
      batch.map(cand => fetchTypesMd(cand.folder, cand.nsDir, cand.v))
    );
    for (let j = 0; j < batch.length; j++) {
      const res = fetched[j];
      if (!res.text || !markerRe.test(res.text)) continue;
      const cand = batch[j];
      return {
        url: `https://github.com/${TYPES_REPO}/blob/${TYPES_BRANCH}/generated/${cand.folder}/${cand.nsDir}/${cand.v}/types.md`,
        status: 200,
        text: res.text,
        version: cand.v,
        requestedVersion: preferVersion || null,
        versionMatched: preferVersion ? cand.v.toLowerCase() === preferVersion.toLowerCase() : null,
      };
    }
  }
  return { url: null, status: 404, text: null };
}

// #2: Given a resource type + property names the reporter says are missing
// at their pinned version, find the NEWEST generated API version whose
// scoped schema contains ALL of those properties. Used to turn a dead-end
// `missing property` into an actionable "available in <newer version>"
// hint. Returns { version, url } or null. Reuses the same listing/fetch
// helpers and version ranking as fetchDocsText.
async function findPropertyInNewerVersion(type, propertyNames, requestedVersion) {
  const parts = type.split('/');
  if (parts.length < 2 || !/^Microsoft\./i.test(parts[0])) return null;
  const namespace = parts[0].toLowerCase();
  const slug = namespace.replace(/^microsoft\./, '');
  const generated = await listGenerated();
  const slugRe = new RegExp(`^${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(_\\d+)?$`);
  const candidates = generated.filter(n => slugRe.test(n));
  if (!candidates.length) return null;
  const all = [];
  for (const folder of candidates) {
    const entries = await listContents(`generated/${folder}`);
    const nsDir = entries.find(e => e.type === 'dir' && e.name.toLowerCase() === namespace);
    if (!nsDir) continue;
    const versions = await listContents(`generated/${folder}/${nsDir.name}`);
    for (const v of versions) if (v.type === 'dir') all.push({ folder, nsDir: nsDir.name, v: v.name });
  }
  if (!all.length) return null;
  all.sort((a, b) => compareTypeVersions(a.v, b.v)); // newest first
  const escType = type.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const markerRe = new RegExp(`^## Resource ${escType}@`, 'im');
  const BATCH = 6;
  for (let i = 0; i < all.length; i += BATCH) {
    const batch = all.slice(i, i + BATCH);
    const fetched = await Promise.all(batch.map(c => fetchTypesMd(c.folder, c.nsDir, c.v)));
    for (let j = 0; j < batch.length; j++) {
      const res = fetched[j], cand = batch[j];
      if (!res.text || !markerRe.test(res.text)) continue;
      // Only interested in versions strictly NEWER than the reporter's.
      if (requestedVersion && compareTypeVersions(cand.v, requestedVersion) >= 0) continue;
      const scoped = scopeToResourceType(res.text, type, cand.v) || res.text;
      if (propertyNames.every(n => pageHasWord(scoped, n))) {
        return {
          version: cand.v,
          url: `https://github.com/${TYPES_REPO}/blob/${TYPES_BRANCH}/generated/${cand.folder}/${cand.nsDir}/${cand.v}/types.md`,
        };
      }
    }
  }
  return null;
}


async function withRetry(fn, { tries = 4, baseMs = 1000, label = 'api' } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const status = e && e.status;
      const isRate = status === 403 || status === 429 ||
        /secondary rate limit|abuse detection|rate limit/i.test((e && e.message) || '');
      if (!isRate || attempt === tries - 1) throw e;
      const retryAfter = Number(e && e.response && e.response.headers &&
        e.response.headers['retry-after']) || 0;
      const delay = retryAfter > 0 ? retryAfter * 1000 : baseMs * Math.pow(2, attempt);
      core.warning(`${label}: rate-limited (status=${status}); retrying in ${delay}ms (attempt ${attempt + 1}/${tries}).`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

async function ensureLabel(label, description) {
  try {
    await github.rest.issues.getLabel({ owner, repo, name: label });
  } catch (e) {
    if (e.status !== 404) throw e;
    try {
      await github.rest.issues.createLabel({
        owner, repo, name: label,
        color: hashColor(label),
        description: description || `Auto-triage label: ${label}`,
      });
      core.info(`Created label ${label}`);
    } catch (createErr) {
      if (createErr.status !== 422) throw createErr;
    }
  }
}

// Recover the reporter's original (pre-bot-rename) issue title by
// walking the issue timeline for the EARLIEST `renamed` event and
// returning its `from` value. Falls back to the current title when
// the issue was never renamed or the timeline can't be read.
async function getOriginalTitle(issueNumber, currentTitle) {
  try {
    const events = await github.paginate(
      github.rest.issues.listEventsForTimeline,
      { owner, repo, issue_number: issueNumber, per_page: 100 }
    );
    for (const ev of events) {
      if (ev.event === 'renamed' && ev.rename && ev.rename.from) {
        return ev.rename.from;
      }
    }
  } catch (e) {
    core.warning(`getOriginalTitle(#${issueNumber}) failed: ${e.message}`);
  }
  return currentTitle;
}

// --- run ---
const { owner, repo } = context.repo;
const issue = context.payload.issue;
const num = issue.number;
const action = context.payload.action;

if (issue.state === 'closed') {
  core.info('Issue already closed, skipping.');
  return;
}

// Re-entrancy guard: when THIS bot renames a title or toggles a label it
// fires another `issues.edited`/`labeled` event, which would re-run triage
// on our own output. Those self-triggered runs are redundant (the logic is
// idempotent, but they burn Actions minutes and API quota). Skip them by
// detecting our own actor. A human editing the issue still triggers a run
// normally.
const sender = context.payload.sender || {};
const selfActor = sender.type === 'Bot' &&
  /^(github-actions(\[bot\])?|.*\[bot\])$/i.test(sender.login || '');
if (selfActor && action !== 'opened' && action !== 'reopened') {
  core.info(`Edit was made by the bot itself (${sender.login}); skipping self-triggered run.`);
  return;
}

const text = `${issue.title || ''}\n\n${issue.body || ''}`;
// Recover the reporter's ORIGINAL title (before any bot rename) so
// we mine genuine user wording for property names instead of the
// bot's own prior output. The earliest `renamed` event's `from`
// value is the title as first opened.
// Only pay for the timeline lookup when the current title is one
// WE prefixed (`[Microsoft.X/y]: ...`). For a raw reporter title
// there's nothing to "recover" — the current title IS the original
// — so we skip the extra paginated API call on those triggers.
const titleLooksBotPrefixed = /^\s*\[Microsoft\.[^\]]+\]:/.test(issue.title || '');
const originalTitle = titleLooksBotPrefixed
  ? await getOriginalTitle(num, issue.title || '')
  : (issue.title || '');
const cls = classify(text, {
  title: issue.title || '',
  body: issue.body || '',
  miningTitle: originalTitle,
});
// Determine the *primary* resource provider(s) for labeling:
//   1. Any `Microsoft.X/y` types mentioned in the title → use their RPs.
//   2. Else any `Microsoft.X` RPs mentioned in the title → use those.
//   3. Else any English keyword in the title that maps to a known RP
//      (e.g. "storage account" → Microsoft.Storage).
//   4. Else any `Microsoft.X/y` types in the body → use their RPs.
//   5. Else fall back to RPs found anywhere in the body.
// In every case, deprioritize "wrapper" RPs (Microsoft.Resources/deployments)
// that show up in every ARM deployment error trace but rarely describe the
// actual subject of the report.

// Generic ARM deployment wrappers — present in nearly every error trace.
// Keep these only if NO other RP is mentioned anywhere.
const WRAPPER_TYPES = new Set([
  'microsoft.resources/deployments',
  'microsoft.resources/deploymentscripts',
  'microsoft.resources/deploymentstacks',
]);
function nonWrapperTypes(types) {
  return types.filter(t => !WRAPPER_TYPES.has(t.toLowerCase()));
}

// Keyword → RP fallback for titles that describe the resource in English
// (e.g. "storage account services" with no `Microsoft.Storage` token).
const KEYWORD_TO_RP = [
  [/\bstorage\s+accounts?\b/i, 'Microsoft.Storage'],
  [/\bkey\s*vault\b/i, 'Microsoft.KeyVault'],
  [/\bweb\s+app\b|\bapp\s+service\b|\bfunction\s+app\b/i, 'Microsoft.Web'],
  [/\bvirtual\s+machine\b|\bvm\b/i, 'Microsoft.Compute'],
  [/\bvirtual\s+network\b|\bvnet\b/i, 'Microsoft.Network'],
  [/\bcosmos\s*db\b/i, 'Microsoft.DocumentDB'],
  [/\bservice\s+bus\b/i, 'Microsoft.ServiceBus'],
  [/\bevent\s+hub\b/i, 'Microsoft.EventHub'],
  [/\bevent\s+grid\b/i, 'Microsoft.EventGrid'],
  [/\bapi\s+management\b/i, 'Microsoft.ApiManagement'],
  [/\bcontainer\s+(?:registry|app|instance)s?\b/i, null],
  [/\bcontainer\s+registry\b/i, 'Microsoft.ContainerRegistry'],
  [/\bcontainer\s+app\b/i, 'Microsoft.App'],
  [/\baks\b|\bkubernetes\s+service\b/i, 'Microsoft.ContainerService'],
  [/\blog\s+analytics\b/i, 'Microsoft.OperationalInsights'],
  [/\bapplication\s+insights\b/i, 'Microsoft.Insights'],
  [/\bredis\b/i, 'Microsoft.Cache'],
  [/\bsignalr\b/i, 'Microsoft.SignalRService'],
  [/\bsql\s+(?:server|database|db)\b/i, 'Microsoft.Sql'],
  [/\bpostgres(?:ql)?\b/i, 'Microsoft.DBforPostgreSQL'],
  [/\bmysql\b/i, 'Microsoft.DBforMySQL'],
  [/\bmachine\s+learning\b/i, 'Microsoft.MachineLearningServices'],
].filter(([, rp]) => rp);

function keywordRpsFromTitle(title) {
  const hits = new Set();
  for (const [re, rp] of KEYWORD_TO_RP) {
    if (re.test(title)) hits.add(rp);
  }
  return [...hits];
}

const titleCls = classify(issue.title || '');
const titleNonWrapperTypes = nonWrapperTypes(titleCls.types);
const bodyNonWrapperTypes = nonWrapperTypes(cls.types);
const keywordRps = keywordRpsFromTitle(issue.title || '');

let primaryRps;
if (titleNonWrapperTypes.length > 0) {
  primaryRps = [...new Set(titleNonWrapperTypes.map(t => t.split('/')[0]))];
} else if (titleCls.rps.length > 0) {
  primaryRps = titleCls.rps.filter(r => r.toLowerCase() !== 'microsoft.resources' || cls.rps.length === 1);
  if (primaryRps.length === 0) primaryRps = titleCls.rps;
} else if (keywordRps.length > 0) {
  primaryRps = keywordRps;
} else if (bodyNonWrapperTypes.length > 0) {
  primaryRps = [...new Set(bodyNonWrapperTypes.map(t => t.split('/')[0]))];
} else if (cls.types.length > 0) {
  primaryRps = [...new Set(cls.types.map(t => t.split('/')[0]))];
} else {
  primaryRps = cls.rps;
}
core.info(
  `Extracted rps=[${cls.rps.join(', ')}] types=[${cls.types.join(', ')}] ` +
  `keywordRps=[${keywordRps.join(', ')}] primaryRps=[${primaryRps.join(', ')}] ` +
  `typeIssue=${cls.hasTypeIssueLanguage} typeUnavail=${cls.hasTypeUnavailableLanguage} missingProp=${cls.hasMissingPropertyLanguage} ` +
  `bug=${cls.hasBugLanguage} properties=${(cls.propertyNames || []).join(',')} ` +
  `apiVersion=${cls.apiVersion || ''}`
);

// Idempotency: if we've already triaged this issue, don't re-comment.
const priorComments = await github.paginate(github.rest.issues.listComments, {
  owner, repo, issue_number: num, per_page: 100,
});
const alreadyTriaged = priorComments.some(c =>
  c.user && c.user.type === 'Bot' && (c.body || '').includes(MARKER)
);

// --- Property verification against generated types (only when we have named properties + a type) ---
// propertyVerification: { found: bool, url, type, version, property, results: [{name, found}] }
// Walk EVERY extracted type (not just the first): a property the reporter
// named may live on the second/third type mentioned in the issue. Prefer a
// type that confirms all properties AT the user's version; otherwise fall
// back to the first type that had a resolvable schema (back-compat with the
// old single-type behaviour).
let propertyVerification = null;
if (cls.hasMissingPropertyLanguage && cls.propertyNames.length > 0 && cls.types.length > 0) {
  let fallback = null;
  for (const t of cls.types) {
    const docs = await fetchDocsText(t, cls.apiVersion);
    core.info(`Types fetch for ${t} (requested=${cls.apiVersion || 'n/a'}): status=${docs.status} resolved=${docs.version || 'n/a'} matched=${docs.versionMatched} length=${docs.text ? docs.text.length : 0}`);
    if (!docs.text) continue;
    // Restrict the property search to ONLY this resource type's
    // schema (its section + the object types it references) so a
    // property defined on a different resource in the same
    // namespace file can't yield a false "property found". Falls
    // back to the whole document if the resource heading isn't
    // located (shouldn't happen — fetchDocsText matched it).
    const scoped = scopeToResourceType(docs.text, t, docs.version) || docs.text;
    const results = cls.propertyNames.map(n => ({ name: n, found: pageHasWord(scoped, n) }));
    const allFound = results.every(r => r.found);
    const pv = {
      found: allFound,
      url: docs.url,
      type: t,
      version: docs.version || null,
      requestedVersion: docs.requestedVersion || null,
      versionMatched: docs.versionMatched,
      property: cls.propertyName, // first one, back-compat
      results,
    };
    core.info(`Property check for ${t}@${docs.version}: ${results.map(r => `${r.name}=${r.found}`).join(', ')}`);
    // A confident hit at the user's version wins immediately.
    if (allFound && docs.versionMatched !== false) { propertyVerification = pv; break; }
    if (!fallback) fallback = pv;
  }
  if (!propertyVerification) propertyVerification = fallback;
}

// --- Compose labels ---
const labelsToApply = new Set(primaryRps);

if (cls.hasTypeIssueLanguage) {
  labelsToApply.add('type issue');
}

if (cls.hasDescriptionIssueLanguage) {
  labelsToApply.add('inaccurate description');
}

if (cls.hasTypeUnavailableLanguage) {
  // Treat "type unavailable" (whole resource type missing) as the
  // same taxonomy bucket as "missing property" — both are cases of
  // Bicep types not exposing something the user needs.
  labelsToApply.add('missing property');
}

if (cls.hasBugLanguage) {
  labelsToApply.add('bug');
}

if (cls.hasMissingPropertyLanguage) {
  // `property found` asserts the property exists AT THE USER'S API
  // version. Only claim it when we actually verified against that
  // version: either the user pinned no version (verify against latest,
  // versionMatched === null) or the pinned version resolved exactly
  // (versionMatched === true). If the user pinned a version we could
  // NOT locate in the generated docs (versionMatched === false), we
  // only checked a DIFFERENT version, so the property is not confirmed
  // present for them — treat it as missing at their version.
  const verifiedAtUserVersion =
    propertyVerification &&
    propertyVerification.found &&
    propertyVerification.versionMatched !== false;
  if (verifiedAtUserVersion) {
    labelsToApply.add('property found');
  } else {
    labelsToApply.add('missing property');
  }
}

// #2: When the property is NOT confirmed at the reporter's pinned version,
// check whether a NEWER API version exposes it. If so, that's the real,
// actionable answer ("bump your apiVersion") — flag it and surface the
// version + link in a comment. Only worth the extra fetches when the user
// actually pinned a version and we have both a type and property names.
let newerVersionHit = null;
if (cls.hasMissingPropertyLanguage &&
    !(propertyVerification && propertyVerification.found && propertyVerification.versionMatched !== false) &&
    cls.apiVersion && cls.types.length > 0 && cls.propertyNames.length > 0) {
  try {
    const verifyType = (propertyVerification && propertyVerification.type) || cls.types[0];
    newerVersionHit = await findPropertyInNewerVersion(verifyType, cls.propertyNames, cls.apiVersion);
  } catch (e) {
    core.warning(`findPropertyInNewerVersion failed: ${e.message}`);
  }
  if (newerVersionHit) {
    labelsToApply.add('available in newer version');
    core.info(`Property available in newer version ${newerVersionHit.version} (reporter pinned ${cls.apiVersion}).`);
  }
}

// --- Duplicate detection ---
// Only run for `missing property` or `type issue` categories,
// matching on same resource type + same property name (case-insensitive).
// Categories don't cross: a `missing property` issue only dupes
// against other `missing property` issues; a `type issue` only
// against other `type issue` issues.
// For any other category (bug / unclassified / etc.) we do NOT dedupe.
// Only LABEL + COMMENT, never auto-close.
const isPropOrTypeIssue = cls.hasMissingPropertyLanguage || cls.hasTypeIssueLanguage;
let duplicateMatches = []; // array of { number, createdAt, reason }
const currentTypesLower = new Set(cls.types.map(t => t.toLowerCase()));
const currentPropsLower = new Set((cls.propertyNames || []).map(p => p.toLowerCase()));
const shouldCheckDupes =
  isPropOrTypeIssue &&
  cls.types.length > 0 &&
  cls.propertyName;
if (shouldCheckDupes) {
  // Cost optimization: only scan issues already labeled in the
  // SAME category bucket(s) rather than every open issue. These
  // labels are applied by this same bot, so triaged issues in the
  // category are reliably tagged — this shrinks the scan (and the
  // per-issue re-classify) from "all open issues" down to just the
  // relevant few. The API's `labels` filter is AND-combined, so we
  // page each applicable bucket separately and merge by number.
  const dupeBuckets = [];
  if (cls.hasMissingPropertyLanguage) dupeBuckets.push('missing property');
  if (cls.hasTypeIssueLanguage) dupeBuckets.push('type issue');
  const openByNumber = new Map();
  for (const lbl of dupeBuckets) {
    const page = await withRetry(
      () => github.paginate(github.rest.issues.listForRepo, {
        owner, repo, state: 'open', labels: lbl, per_page: 100,
      }),
      { label: `listForRepo(${lbl})` }
    );
    for (const it of page) openByNumber.set(it.number, it);
  }
  const allOpen = [...openByNumber.values()];
  for (const other of allOpen) {
    if (other.number === num) continue;
    if (other.pull_request) continue;
    if (new Date(other.created_at) >= new Date(issue.created_at)) continue;
    const otherText = `${other.title || ''}\n\n${other.body || ''}`;
    const otherCls = classify(otherText, { title: other.title || '', body: other.body || '' });
    // Must share the SAME category — don't cross MP ↔ type-issue.
    const sameCategory =
      (cls.hasMissingPropertyLanguage && otherCls.hasMissingPropertyLanguage) ||
      (cls.hasTypeIssueLanguage && otherCls.hasTypeIssueLanguage);
    if (!sameCategory) continue;
    const sharedType = otherCls.types.find(t => currentTypesLower.has(t.toLowerCase()));
    if (!sharedType) continue;
    // Match on ANY shared property (case-insensitive), not just each
    // issue's first-extracted one — a multi-property report and a
    // single-property report about the same missing property are still
    // duplicates even when their property LISTS differ in order/length.
    const sharedProp = (otherCls.propertyNames || [])
      .find(p => currentPropsLower.has(p.toLowerCase()));
    if (sharedProp) {
      duplicateMatches.push({
        number: other.number,
        createdAt: other.created_at,
        reason: `same type \`${sharedType}\` and shared property \`${sharedProp}\``,
      });
    }
  }
  duplicateMatches.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}

if (duplicateMatches.length > 0) {
  labelsToApply.add('possible-duplicate');
}

// --- Apply labels ---
const labelArr = [...labelsToApply];
for (const label of labelArr) {
  await ensureLabel(label);
}
if (labelArr.length > 0) {
  await github.rest.issues.addLabels({
    owner, repo, issue_number: num, labels: labelArr,
  });
  core.info(`Applied labels: ${labelArr.join(', ')}`);
} else {
  core.info('No labels to apply.');
}

// --- Remove conflicting labels we no longer believe apply ---
// 'missing property' and 'property found' are mutually exclusive — keep
// whichever this run chose and strip the other if it lingers from a prior run.
const existingNames = new Set((issue.labels || []).map(l => (typeof l === 'string' ? l : l.name)));
async function removeLabelIf(name) {
  if (existingNames.has(name) && !labelsToApply.has(name)) {
    try {
      await github.rest.issues.removeLabel({ owner, repo, issue_number: num, name });
      core.info(`Removed stale label: ${name}`);
    } catch (e) { /* 404 is fine */ }
  }
}
if (labelsToApply.has('property found')) await removeLabelIf('missing property');
if (labelsToApply.has('missing property')) await removeLabelIf('property found');
// If neither classification applies anymore (e.g. previously flagged
// missing-property but the resource-not-found guard now suppresses it),
// strip both labels so stale state doesn't linger.
if (!labelsToApply.has('missing property') && !labelsToApply.has('property found')) {
  await removeLabelIf('missing property');
  await removeLabelIf('property found');
}
// Always strip the deprecated `types unavailable` label — it's
// been folded into `missing property`.
await removeLabelIf('types unavailable');
if (!labelsToApply.has('type issue')) await removeLabelIf('type issue');
if (!labelsToApply.has('inaccurate description')) await removeLabelIf('inaccurate description');
if (!labelsToApply.has('bug')) await removeLabelIf('bug');
// Strip stale `available in newer version` when this run didn't find one
// (e.g. the property is now present at the reporter's version, or the
// reporter changed their pinned version).
if (!labelsToApply.has('available in newer version')) {
  await removeLabelIf('available in newer version');
}
// Strip stale `possible-duplicate` when this issue's category no
// longer qualifies for dedupe (i.e. it's neither missing-property
// nor type-issue). If dedupe DID run and found nothing, also strip.
const shouldRemoveDupeLabel =
  !isPropOrTypeIssue ||
  (shouldCheckDupes && duplicateMatches.length === 0);
if (shouldRemoveDupeLabel && !labelsToApply.has('possible-duplicate')) {
  await removeLabelIf('possible-duplicate');
}

// --- Title normalization for confirmed missing-property issues ---
// Also runs when the current title is bot-canonical (we own it) so
// we can correct earlier noisy renames even after the docs check
// reclassifies the issue as `property found`.
const titleIsBotOwned = /^\s*\[Microsoft\.[^\]]+\]:\s+.+\s+propert(?:y|ies)\s+missing\s*$/i.test(issue.title || '');
// Any `[Microsoft.X/y]: <description>` title — the shape we always
// want to own and normalize, even if a reporter (not the bot) wrote
// the freeform description after the resource-type prefix.
const titleIsResourcePrefixed = /^\s*\[Microsoft\.[^\]]+\]:\s+\S/i.test(issue.title || '');
// The unedited issue-template default title, left verbatim by a
// reporter who never filled it in: `[<resource_type>]: <description>`
// (tolerant of angle brackets, spacing, and _/space in the token).
const titleIsPlaceholder = /^\s*\[\s*<?\s*resource[_\s]?type\s*>?\s*\]\s*:\s*<?\s*description\s*>?\s*$/i.test(issue.title || '');
// A title the bot itself generated as a neutral category placeholder
// ("Missing property", "Type is unavailable", "Type issue",
// "Inaccurate/confusing description"). We always own these and must
// correct them when the category changes underneath us.
const titleIsBotGeneric = /^\s*\[Microsoft\.[^\]]+\]:\s+(?:Missing property|Type is unavailable|Type issue|Inaccurate\/confusing description)\s*$/i.test(issue.title || '');
if (cls.propertyNames.length > 0 && cls.types.length > 0 &&
    (cls.hasMissingPropertyLanguage || titleIsBotOwned) &&
    !(propertyVerification && propertyVerification.found && !titleIsBotOwned)) {
  const propsForTitle = cls.propertyNames.slice(0, 3).join(', ');
  const wordForm = cls.propertyNames.length > 1 ? 'properties' : 'property';
  const normalizedTitle = `[${cls.types[0]}]: ${propsForTitle} ${wordForm} missing`;
  if (issue.title !== normalizedTitle) {
    await github.rest.issues.update({
      owner, repo, issue_number: num, title: normalizedTitle,
    });
    core.info(`Renamed issue to: ${normalizedTitle}`);
  }
} else if ((titleIsBotOwned || titleIsResourcePrefixed) &&
           (cls.hasMissingPropertyLanguage || cls.hasTypeUnavailableLanguage) &&
           cls.propertyNames.length === 0 && cls.types.length > 0) {
  // The title is either one WE generated ("<props> properties
  // missing") or a freeform `[Microsoft.X/y]: <description>` a
  // reporter wrote — and re-mining the body yields no property
  // name. Either the previous list was garbage (repro parameter/
  // function names, resource-name words, noise baked in by an
  // earlier bot-title feedback loop) or the reporter never named a
  // specific property. Always normalize these to a neutral,
  // category-appropriate title rather than leaving a wrong or
  // freeform description in place.
  const generic = (cls.hasTypeUnavailableLanguage && !cls.hasMissingPropertyLanguage)
    ? `[${cls.types[0]}]: Type is unavailable`
    : `[${cls.types[0]}]: Missing property`;
  if (issue.title !== generic) {
    await github.rest.issues.update({
      owner, repo, issue_number: num, title: generic,
    });
    core.info(`Reset stale bot title to neutral: ${generic}`);
  }
} else if (cls.hasDescriptionIssueLanguage &&
           (titleIsBotOwned || titleIsResourcePrefixed || titleIsPlaceholder || titleIsBotGeneric) &&
           cls.types.length > 0) {
  // Description/documentation issue: give it a neutral,
  // category-appropriate title. This also corrects issues left with a
  // stale bot-generated generic (e.g. an earlier run labeled it
  // "Missing property") once the classification settles on
  // description-issue.
  const target = `[${cls.types[0]}]: Inaccurate/confusing description`;
  if (issue.title !== target) {
    await github.rest.issues.update({
      owner, repo, issue_number: num, title: target,
    });
    core.info(`Normalized description-issue title to: ${target}`);
  }
} else if (titleIsBotGeneric && cls.types.length > 0 &&
           !cls.hasMissingPropertyLanguage && !cls.hasTypeUnavailableLanguage &&
           !cls.hasTypeIssueLanguage && !cls.hasDescriptionIssueLanguage) {
  // The title is a stale bot-generated generic but the issue no longer
  // classifies into any schema category (e.g. reclassified as an
  // uncategorized/bug report). Rather than overwrite it with a bot
  // placeholder like "Needs triage" — which reads oddly to reporters and
  // buries the resource type — restore the reporter's ORIGINAL pre-rename
  // title when we can recover one that isn't itself a bot generic. If we
  // can't recover a clean original, leave the current title untouched.
  const originalIsBotGeneric =
    /^\s*\[Microsoft\.[^\]]+\]:\s+(?:Missing property|Type is unavailable|Type issue|Inaccurate\/confusing description|Needs triage)\s*$/i
      .test(originalTitle || '');
  if (originalTitle && originalTitle !== issue.title && !originalIsBotGeneric) {
    await github.rest.issues.update({
      owner, repo, issue_number: num, title: originalTitle,
    });
    core.info(`Restored reporter's original title: ${originalTitle}`);
  } else {
    core.info('Stale bot-generic title but no clean original to restore; leaving title unchanged.');
  }
} else if (titleIsPlaceholder &&
           (cls.hasMissingPropertyLanguage || cls.hasTypeUnavailableLanguage || cls.hasTypeIssueLanguage) &&
           cls.types.length > 0) {
  // The reporter never edited the issue-template default, so the
  // title is still the literal `[<resource_type>]: <description>`
  // placeholder. Always replace it with a real, category-appropriate
  // title mined from the BODY — including the `property found`
  // contradiction case (property named + verified present), where
  // neither branch above fires and the placeholder would otherwise
  // survive. Requires a parseable Microsoft.X/y type; placeholders
  // whose body gives no resolvable resource type are left untouched.
  const verifiedFound = propertyVerification && propertyVerification.found;
  const isMissingCat = cls.hasMissingPropertyLanguage || cls.hasTypeUnavailableLanguage;
  let target;
  if (isMissingCat && cls.propertyNames.length > 0 && !verifiedFound) {
    const props = cls.propertyNames.slice(0, 3).join(', ');
    const wordForm = cls.propertyNames.length > 1 ? 'properties' : 'property';
    target = `[${cls.types[0]}]: ${props} ${wordForm} missing`;
  } else if (isMissingCat) {
    target = (cls.hasTypeUnavailableLanguage && !cls.hasMissingPropertyLanguage)
      ? `[${cls.types[0]}]: Type is unavailable`
      : `[${cls.types[0]}]: Missing property`;
  } else {
    // Type-issue-only placeholder (inaccurate property type/desc).
    target = `[${cls.types[0]}]: Type issue`;
  }
  if (issue.title !== target) {
    await github.rest.issues.update({
      owner, repo, issue_number: num, title: target,
    });
    core.info(`Normalized placeholder title to: ${target}`);
  }
}

// --- Comments ---
// Find any prior bot comment so we can update/delete instead of
// stacking duplicates on retrigger.
const priorBotComment = priorComments.find(c =>
  c.user && c.user.type === 'Bot' && (c.body || '').includes(MARKER)
);

const commentBlocks = [];

// "Property found in generated types" comment (contradiction).
// Same guard as the `property found` label: only claim we found it
// when verification actually ran at the user's API version (or they
// pinned none). If they pinned a version we couldn't locate, we only
// checked a different version and must not assert the property exists.
if (propertyVerification && propertyVerification.found &&
    propertyVerification.versionMatched !== false) {
  const list = propertyVerification.results.map(r => `\`${r.name}\``).join(', ');
  const rv = propertyVerification.requestedVersion;
  const v = propertyVerification.version;
  let verLabel = v ? ` (API version \`${v}\`)` : '';
  if (rv && v && rv.toLowerCase() !== v.toLowerCase()) {
    verLabel = ` (couldn't find API version \`${rv}\`; checked \`${v}\` instead)`;
  } else if (rv && v && rv.toLowerCase() === v.toLowerCase()) {
    verLabel = ` (API version \`${v}\`, matching the one you referenced)`;
  }
  commentBlocks.push(
    `I checked the [Azure/bicep-types-az](https://github.com/${TYPES_REPO}) generated type ` +
    `definitions for **\`${propertyVerification.type}\`**${verLabel} and found the ` +
    `propert${propertyVerification.results.length > 1 ? 'ies' : 'y'} ${list} defined:\n\n` +
    `${propertyVerification.url}\n\n` +
    `Could you double-check spelling and the API version you're targeting? ` +
    `If the property is working for you, feel free to close.`
  );
}

// "Available in a newer API version" comment. When the property is missing
// at the reporter's pinned version but present in a newer one, tell them
// exactly which version exposes it — the actionable fix is to bump the
// apiVersion. Mutually exclusive with the "property found" block above
// (that only fires when verified AT the user's version).
if (newerVersionHit) {
  const names = cls.propertyNames;
  const list = names.map(p => `\`${p}\``).join(', ');
  const plural = names.length > 1;
  commentBlocks.push(
    `The propert${plural ? 'ies' : 'y'} ${list} ${plural ? 'appear' : 'appears'} to be ` +
    `**available in a newer API version**: \`${newerVersionHit.version}\` ` +
    `(you referenced \`${cls.apiVersion}\`).\n\n${newerVersionHit.url}\n\n` +
    `If you can target \`${newerVersionHit.version}\`, ${plural ? 'they' : 'it'} should be available there.`
  );
}

// Possible-duplicate comment (don't close — just flag for maintainer review).
if (duplicateMatches.length > 0) {
  const list = duplicateMatches.slice(0, 5)
    .map(d => `- #${d.number} (${d.reason}, opened ${d.createdAt.slice(0, 10)})`)
    .join('\n');
  commentBlocks.push(
    `🤔 This looks like it may duplicate:\n\n${list}\n\n` +
    `Labeled \`possible-duplicate\` for maintainer review — not auto-closing.`
  );
}

// (Clarification-request comment removed — was too noisy and
// triggered on every issue where the classifier couldn't extract
// a property name, even when the issue itself was already clear.)

// Only post the acknowledgement on the FIRST triage (action=='opened'
// AND no prior bot comment). On retriggers, skip acknowledgement.
if (commentBlocks.length === 0 && action === 'opened' && !priorBotComment) {
  const lines = ['Thanks for the report! Auto-triage detected:', ''];
  if (primaryRps.length > 0) {
    lines.push(`- **Resource provider${primaryRps.length > 1 ? 's' : ''}:** ` +
      primaryRps.map(r => `\`${r}\``).join(', '));
  }
  // Only include the type when the issue is missing-property or type-issue —
  // for other categories the type isn't the interesting signal.
  if (cls.hasMissingPropertyLanguage || cls.hasTypeIssueLanguage) {
    const primaryTypes = (titleNonWrapperTypes.length > 0
      ? titleNonWrapperTypes
      : (bodyNonWrapperTypes.length > 0 ? bodyNonWrapperTypes : cls.types));
    if (primaryTypes.length > 0) {
      lines.push(`- **Type${primaryTypes.length > 1 ? 's' : ''}:** ` +
        primaryTypes.map(t => `\`${t}\``).join(', '));
    }
    if (cls.apiVersion) {
      lines.push(`- **API version:** \`${cls.apiVersion}\``);
    }
  }
  if (cls.hasTypeIssueLanguage) {
    lines.push(`- Labeled \`type issue\` based on language about the type being wrong or unavailable.`);
  }
  if (cls.hasBugLanguage) {
    lines.push(`- Labeled \`bug\` based on language about a deployment failure or unexpected runtime behavior.`);
  }
  if (cls.hasMissingPropertyLanguage) {
    lines.push(`- Labeled \`missing property\`` +
      (cls.propertyName ? ` (extracted property: \`${cls.propertyName}\`)` : '') + `.`);
  }
  if (lines.length > 2) {
    commentBlocks.push(lines.join('\n'));
  }
}

if (commentBlocks.length > 0) {
  const body = `${MARKER}\n` + commentBlocks.join('\n\n---\n\n');
  if (priorBotComment) {
    if ((priorBotComment.body || '').trim() === body.trim()) {
      core.info('Bot comment unchanged; skipping update.');
    } else {
      await github.rest.issues.updateComment({
        owner, repo, comment_id: priorBotComment.id, body,
      });
      core.info(`Updated existing bot comment (${commentBlocks.length} block(s)).`);
    }
  } else {
    await github.rest.issues.createComment({ owner, repo, issue_number: num, body });
    core.info(`Posted ${commentBlocks.length} comment block(s).`);
  }
} else if (priorBotComment) {
  // Nothing to say anymore — delete the stale bot comment so
  // outdated dupe lists / property-found warnings don't linger.
  await github.rest.issues.deleteComment({
    owner, repo, comment_id: priorBotComment.id,
  });
  core.info('Deleted stale bot comment (no comment blocks apply now).');
}

}

// Auto-triage engine for stephaniezyen/bicep-types-az — the single source of
// truth for the heuristic issue-triage logic. Invoked by
// .github/workflows/triage.yml, which dynamic-imports this module and calls
// run({ github, context, core }):
//   github  - authenticated Octokit REST client (actions/github-script)
//   context - workflow event context (context.repo, context.payload.issue, ...)
//   core    - @actions/core
// Uses the global fetch (Node 20+) to pull generated types.md from
// Azure/bicep-types-az. No LLM, no external dependencies.

// ============================================================================
// Pure heuristics — hoisted to module scope so CI (triage.test.mjs) can
// unit-test them without github/context/core.
// ============================================================================

const MARKER = '<!-- auto-triage-bot:v3 -->';
const TYPES_REPO = 'Azure/bicep-types-az';
const [TYPES_OWNER, TYPES_NAME] = TYPES_REPO.split('/');
const TYPES_BRANCH = 'main';
const RAW_BASE = `https://raw.githubusercontent.com/${TYPES_REPO}/${TYPES_BRANCH}/generated`;
const UA = 'bicep-types-az-triage-bot/3.0';

// PascalCase Microsoft.<Namespace> — case-sensitive so lowercase domain
// names (learn.microsoft.com) don't match.
const RP_REGEX = /(?<![.\/\w])Microsoft\.[A-Z][A-Za-z0-9]{2,}/g;
const TYPE_REGEX = /(?<![.\/\w])Microsoft\.[A-Z][A-Za-z0-9]{2,}(?:\/[A-Za-z][A-Za-z0-9]*)+/g;

// --- Missing-property heuristic ---
// Detected by proximity: a "missing-ness" word near a "property" word (either
// direction), or a missing-ness phrase followed by a plausible property name.

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

// Hyphen-aware boundaries so hyphenated ARM jargon ("reference-property")
// isn't read as the user asserting a property is missing.
const PROP_WORD_PATTERN = `(?<![\\w-])(?:${propAlt})(?![\\w-])`;
// Direction-agnostic co-occurrence within a small same-line window.
const MISS_NEAR_PROP = new RegExp(
  `(?:\\b(?:${missAlt})\\b[^\\n.]{0,80}?${PROP_WORD_PATTERN})` +
  `|` +
  `(?:${PROP_WORD_PATTERN}[^\\n.]{0,80}?\\b(?:${missAlt})\\b)`,
  'i'
);

// Property-name extraction takes the identifier nearest a "property" word,
// preferring quoted tokens over bare camelCase, with a shorthand fallback.
const PROP_WORD_REGEX = new RegExp(PROP_WORD_PATTERN, 'gi');
const QUOTED_IDENT = /[`'"]([A-Za-z_][\w.-]*)[`'"]/g;
const CAMEL_IDENT = /\b([A-Za-z_][\w.-]*)\b/g;

// Signals that the issue is about a missing *resource* or a deployment
// failure, not a missing schema property.
const RESOURCE_NOT_FOUND_PATTERNS = [
  /\bResource(?:Group)?NotFound\b/,
  /\bResource\s+['"`][^'"`\n]+['"`]?\s+(?:does\s+not\s+exist|was\s+not\s+found|cannot\s+be\s+found)\b/i,
  /\bResource\s+not\s+found\b/i,
  /\bDeploymentFailed\b/,
  // No `\b` before the quote: a quote preceded by whitespace or `{` has
  // non-word on both sides, so `\b` would fail on real JSON payloads.
  /"code"\s*:\s*"NotFound"/i,
  /\bcode\s*[:=]\s*['"]?NotFound['"]?/i,
];
const RESOURCE_NOT_FOUND_RE = new RegExp(
  RESOURCE_NOT_FOUND_PATTERNS.map(r => r.source).join('|'),
  'i'
);

// Last-resort filter for tokens that look like property names but aren't.
// Deliberately small — most noise is rejected upstream by isLikelyIdentifier,
// buildExclusions(), stripTitlePrefix() and the window-truncation guard.
// These remain because they start lowercase and sit next to a property word,
// usually in pasted JSON.
const PROPERTY_NAME_STOPWORDS = new Set([
  // Schema vocabulary — the words the miner anchors on in the first place.
  'property', 'properties', 'field', 'fields', 'attribute', 'attributes',
  'type', 'types', 'resource', 'resources', 'schema', 'definition', 'api', 'apis',
  // Primitive type names, which appear beside properties in pasted schemas
  // and error text.
  'string', 'strings', 'int', 'integer', 'number', 'bool', 'boolean',
  'object', 'objects', 'array', 'value', 'values', 'true', 'false', 'null', 'undefined',
  // ARM/JSON error-envelope keys, which sit right next to the word "property"
  // in pasted deployment errors.
  'message', 'messages', 'code', 'codes', 'target', 'targets', 'details', 'detail',
  'innererror', 'correlationid', 'statuscode', 'requestid', 'activityid',
  'timestamp', 'additionalinfo', 'trackingid',
  // Generic nouns and protocol acronyms frequently quoted in prose.
  'error', 'errors', 'test', 'set', 'http', 'https', 'url', 'uri',
]);

function isPlausiblePropertyName(name) {
  if (!name) return false;
  if (name.length < 3) return false;
  if (PROPERTY_NAME_STOPWORDS.has(name.toLowerCase())) return false;
  if (/^\d+$/.test(name)) return false;
  // Must contain at least one letter.
  if (!/[A-Za-z]/.test(name)) return false;
  // Reject markdown-emphasis / placeholder artifacts: real ARM/Bicep
  // property names never start or end with an underscore.
  if (/^_|_$/.test(name)) return false;
  // Reject hyphenated tokens — CLI flags and query params leaking in from a
  // repro. Dotted paths are still allowed.
  if (name.includes('-')) return false;
  // Reject truncated "Microsoft.X" namespace fragments left in stale
  // bot-renamed titles: a short lowercase run, a dot, then PascalCase.
  if (/^[a-z]{1,6}\.[A-Z]/.test(name)) return false;
  // Reject GUID / hash / correlation-id fragments leaking in from repros.
  if (/^[0-9a-fA-F]{8,}$/.test(name.replace(/-/g, ''))) return false;
  return true;
}
function isLikelyIdentifier(name) {
  // Real property names are camelCase/PascalCase or contain digits/underscores.
  // Plain-English words of any length (e.g. "noticed", "missing") shouldn't qualify.
  if (/^Microsoft\./i.test(name)) return false;
  return /[A-Z]/.test(name) || /[_\d]/.test(name);
}

// Collapse redundant path forms of the same property (leading `properties.`
// prefixes and dotted ancestors) to a single leaf entry, keeping the first
// occurrence. Leaf-keying also matches how schema verification searches.
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

// Dynamically exclude every segment of a detected resource type — those
// name the resource itself, not a property.
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

// Strip common "Tag: rest of title" prefixes.
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
      // Quoted PascalCase tokens are enum values or ARM JSON keys, not the
      // Bicep camelCase property.
      if (!/^[a-z]/.test(qm[1])) continue;
      addCandidate(qm[1], winStart + qm.index, true);
    }
    let cm;
    CAMEL_IDENT.lastIndex = 0;
    while ((cm = CAMEL_IDENT.exec(window)) !== null) {
      // Discard matches butting against a window edge that isn't the true
      // start/end of the text — they're words sliced by the window.
      if (cm.index === 0 && winStart > 0) continue;
      if (cm.index + cm[0].length === window.length && winEnd < text.length) continue;
      if (!isLikelyIdentifier(cm[1])) continue;
      // Unquoted candidates must be camelCase starting lowercase; PascalCase
      // and ALL-CAPS bare tokens are type names, enum values or acronyms.
      // Quoted candidates bypass this (handled above).
      if (!/^[a-z]/.test(cm[1])) continue;
      addCandidate(cm[1], winStart + cm.index, false);
    }
  }
  // "missing <name>" shorthand. A camelCase hump OR an embedded digit run is
  // enough of an identifier signal to separate a property from a prose word.
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
  // Reverse shorthand: "<name> (is) missing". There is no prop-word anchor in
  // such titles, so require the camelCase shape to avoid firing on prose.
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

// Catches "<identifier> is not allowed/recognized/supported" — the
// missing-ness verb sits right after a candidate identifier.
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

// --- Shared regex fragments: building blocks composed with new RegExp() below,
// so each literal is written once instead of repeated in every pattern. ---
const Q = '["\'`]';                       // a quote character: " ' or `
const NAME = '([A-Za-z_][\\w.-]*)';       // captured identifier
const IDENT = `${Q}?${NAME}${Q}?`;        // identifier, surrounding quotes optional
const QIDENT = `${Q}\\**${NAME}\\**${Q}`; // quoted identifier, **bold** markers tolerated
const DOESNT = "doesn['']?t|does\\s+not"; // negated-verb alternatives; kept as
const DONT = "don['']?t|do\\s+not";       // separate halves so each call site can
const DOES_NOT = "does(?:\\s+not|n['']?t)"; // reproduce its own alternation order
const gap = n => `[^\\n]{0,${n}}?`;       // non-greedy same-line filler

// High-confidence extraction from ARM/Bicep error messages that name BOTH the
// property and its container type. Returns { properties, containerTypes };
// container types are excluded from being read as property names elsewhere.
function extractErrorPatterns(text) {
  const properties = [];
  const containerTypes = [];
  const patterns = [
    String.raw`(?:the\s+)?property\s+${QIDENT}\s+is\s+(?:not\s+)?allowed\s+on\s+(?:objects?\s+of\s+)?type\s+${QIDENT}`,
    String.raw`${QIDENT}\s+is\s+not\s+a\s+valid\s+property\s+(?:of|on)\s+(?:type\s+)?${QIDENT}`,
    String.raw`property\s+${QIDENT}\s+is\s+not\s+(?:defined|declared|present)\s+on\s+(?:type\s+)?${QIDENT}`,
    String.raw`unknown\s+property\s+${QIDENT}\s+(?:on|for)\s+(?:type\s+)?${QIDENT}`,
    String.raw`property\s+${QIDENT}\s+(?:not\s+found|does\s+not\s+exist)\s+on\s+(?:type\s+)?${QIDENT}`,
    // User quoting the property next to its container type, either word order.
    String.raw`${QIDENT}\s+property\s+of\s+(?:type\s+)?${QIDENT}`,
    String.raw`property\s+${QIDENT}\s+of\s+(?:type\s+)?${QIDENT}`,
    // A Bicep diagnostic code ("BCP187 for `kind`") makes this high-confidence.
    String.raw`\bBCP\d+\b(?:\s+(?:warning|error))?\s+(?:for|on)\s+${QIDENT}`,
  ].map(src => new RegExp(src, 'gi'));
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      if (isPlausiblePropertyName(m[1])) properties.push(m[1]);
      if (m[2]) containerTypes.push(m[2]);
    }
  }
  // Patterns where the container type is named BEFORE the property, so the
  // capture groups are reversed relative to the ones above.
  const reversedPatterns = [
    new RegExp(String.raw`\btype\s+${QIDENT}\s+does(?:\s+not|n['’]?t)\s+(?:contain|include|define|declare|have)\s+(?:the\s+|a\s+)?(?:property|member)\s+${QIDENT}`, 'gi'),
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

// Extract property names from a prose `properties:` block. Only identifiers
// indented under the header are returned; siblings at or above the header
// indent are ignored. High confidence — the reporter enumerated them.
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
  // High-confidence layer B: definitively-missing linter/ARM phrases. A and B
  // are merged rather than first-wins, so an issue quoting two different error
  // shapes surfaces both property names.
  for (const re of DEFINITIVELY_MISSING_REGEXES) {
    const rg = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m;
    while ((m = rg.exec(fullText)) !== null) pushName(m[1]);
  }
  // If either high-confidence layer named properties, trust ONLY those —
  // prose-mined identifiers would pull in surrounding noise words.
  if (out.length > 0) return canonicalizeProperties(out);
  // Structured `properties:` enumeration in prose. High confidence: return
  // ONLY these, skipping the noisier prose layers below.
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

// Bicep linter diagnostic: `The property "X" does not exist in the resource or
// type definition` (and its older variants). Also used verbatim as the
// definitively-missing override below.
const PROP_NOT_IN_DEFINITION = new RegExp(
  String.raw`\bproperty\s+${Q}${NAME}${Q}\s+does\s+not\s+exist\s+in\s+the\s+(?:resource\s+(?:or\s+type\s+)?|type\s+)?definition\b`, 'i');

// Explicit "property is missing" phrases — a HIGH-CONFIDENCE missing-property
// signal, unlike the loose proximity heuristic (MISS_NEAR_PROP).
const EXPLICIT_MISSING_PROP_REGEXES = [
  // "<X> property is missing" / "<X> properties missing"
  new RegExp(String.raw`\b${NAME}\s+propert(?:y|ies)\s+(?:is\s+|are\s+)?missing\b`, 'i'),
  new RegExp(String.raw`\bproperty\s+${IDENT}\s+is\s+missing\b`, 'i'),
  // "missing property <X>" / "Missing property(s): <X>"
  new RegExp(String.raw`\bmissing\s+propert(?:y|ies)(?:\s*\(s\))?[\s:]+${IDENT}`, 'i'),
  new RegExp(String.raw`\bis\s+missing\s+(?:the\s+)?${IDENT}\s+property\b`, 'i'),
  // Inverted: "does not expose / doesn't have / does not include <X> property"
  new RegExp(String.raw`\b(?:${DOESNT}|do\s+not|don['']?t)\s+(?:expose|include|have|contain|define|support)\s+(?:an?\s+|the\s+)?${IDENT}\s+propert`, 'i'),
  // "type definition does not expose (a|the) <X>"
  new RegExp(String.raw`\btype\s+(?:definition\s+)?(?:${DOESNT})\s+(?:expose|include|have|contain|define)\s+(?:an?\s+|the\s+)?${IDENT}\b`, 'i'),
  // "lacks (a|the) <X> property" / "lacking <X>"
  new RegExp(String.raw`\black(?:s|ing)?\s+(?:an?\s+|the\s+)?${IDENT}\s+propert`, 'i'),
  // "no <X> property"
  new RegExp(String.raw`\bno\s+${IDENT}\s+propert(?:y|ies)\b`, 'i'),
  PROP_NOT_IN_DEFINITION,
];

// Subset of EXPLICIT_MISSING_PROP_REGEXES unambiguous enough to OVERRIDE the
// reporter's template selection: literal Bicep/ARM errors saying the property
// is not defined, not that it has the wrong type.
const DEFINITIVELY_MISSING_REGEXES = [PROP_NOT_IN_DEFINITION];

// Subset of BUG signals unambiguous enough to OVERRIDE: the real problem is a
// Bicep/ARM language limitation (usually wanting to loop over an array), not a
// schema defect, so the schema-shaped categories are suppressed.
const DEFINITIVELY_BUG_REGEXES = [
  /\bloop\s+(?:through|over|across)\b/i,
  /\biterat(?:e|ing)\s+(?:through|over|across)\b/i,
  // Bicep `for-expression` used as a noun
  /\bfor[-\s]expression\b/i,
  // Design/language limitation phrasing
  new RegExp(String.raw`\b(?:${DOESNT}|won['']?t|will\s+not)\s+scale\s+(?:well|nicely)?\b`, 'i'),
  /\bnot\s+scalable\b/i,
];

// ============================================================================
// Issue categories — the single source of truth for classification. This one
// table drives template parsing, prose detection, label application, and
// stale-label cleanup; add a category by adding ONE entry here.
//
// Entries are evaluated IN ORDER and the first `templatePatterns` match wins,
// so list more specific categories first.
//
// Fields:
//   id                     Category name (also exposed as `templateIssueType`).
//   label                  GitHub label to apply; may be shared by categories.
//   flag                   Boolean exposed on the classify() result.
//   templatePatterns       Tested against the lowercased `### Issue Type` value.
//   prosePatterns          Tested against free text when the template didn't decide.
//   proseScope             'stripped' (default) or 'proseAndTitle'.
//   proseNeedsNoTemplate   Only trust prose when no template value was picked.
//   proseBlockedByTemplate Template selections that disable this category's prose.
//   suppressedBy           Category ids / overrides that force this off.
//   resolveLabel           Optional dynamic label (depends on schema verification).
// ============================================================================
const ISSUE_CATEGORIES = [
  {
    id: 'readwrite-only',
    label: 'read-only/write-only',
    flag: 'hasReadWriteOnlyLanguage',
    templatePatterns: [/read-?only|write-?only/],
    // High-precision: only phrasings asserting a mistake, not casual mentions.
    prosePatterns: [
      /\b(?:marked|flagged|set|treated|exposed|defined)\s+(?:as\s+)?(?:read-?only|write-?only)\b/i,
      /\bshould\s+(?:be\s+)?(?:marked\s+(?:as\s+)?)?(?:read-?only|write-?only|writable|writeable|mutable|settable)\b/i,
      /\b(?:incorrectly|wrongly|inaccurately|erroneously|mistakenly)\s+(?:marked\s+(?:as\s+)?)?(?:read-?only|write-?only)\b/i,
      /\b(?:read-?only|write-?only)\s+but\s+(?:should|can|it|is|shouldn|it['']?s)\b/i,
    ],
    proseScope: 'proseAndTitle',
  },
  {
    id: 'type-unavailable',
    // Folded into `missing property`: a whole type being absent and a single
    // property being absent are the same problem from a user's perspective.
    label: 'missing property',
    flag: 'hasTypeUnavailableLanguage',
    templatePatterns: [/\btype\s+is\s+unavailable\b/, /\btype\s+(?:not|un)available\b/],
    // "The type itself is absent / not generated yet" — distinct from
    // type-issue, where the type exists but its schema is wrong.
    prosePatterns: [
      /\b(?:resource\s+)?type\s+(?:is\s+)?(?:unavailable|not\s+available|not\s+found)\b/i,
      /\bresource\s+type\s+(?:is\s+)?missing\b/i,
      new RegExp(String.raw`\btype\s+${DOES_NOT}\s+exist\b`, 'i'),
      /\bno\s+such\s+resource\s+type\b/i,
      /\bunknown\s+resource\s+type\b/i,
      /\bBCP081\b/i,
      // The gap must allow dots (the type name it spans is dotted); excluding
      // only newlines keeps it anchored to a single line.
      new RegExp(String.raw`\bResource\s+type\s+${gap(80)}\s+does\s+not\s+have\s+types\s+available\b`, 'i'),
      /\b(?:type|types)\s+(?:for|of)\s+[`'"][^`'"\n]+[`'"]\s+(?:are\s+|is\s+)?(?:not\s+)?(?:yet\s+)?(?:available|defined|generated|published)\b/i,
      /\bno\s+types\s+(?:available|defined|generated|published)\b/i,
      /\btypes?\s+(?:not\s+)?(?:yet\s+)?(?:generated|published|defined)\b/i,
      /\bmissing\s+(?:resource\s+)?type\s+definition\b/i,
      // ARM runtime: "The resource type 'X' could not be found in the namespace 'Y'"
      /\bresource\s+type\s+["'`][^"'`\n]+["'`]\s+could\s+not\s+be\s+found\s+in\s+the\s+namespace\b/i,
      /\bcould\s+not\s+be\s+found\s+in\s+the\s+namespace\b/i,
    ],
    suppressedBy: ['definitively-bug'],
  },
  {
    id: 'missing-property',
    // Detection is bespoke (see detectMissingProperty); the label is dynamic
    // because schema verification may turn it into `property found`.
    label: 'missing property',
    flag: 'hasMissingPropertyLanguage',
    templatePatterns: [/\bmissing\s+propert/],
    detect: 'bespoke',
    suppressedBy: ['definitively-bug'],
    resolveLabel: ({ verifiedAtUserVersion }) =>
      verifiedAtUserVersion ? 'property found' : 'missing property',
  },
  {
    id: 'description-issue',
    label: 'inaccurate description',
    flag: 'hasDescriptionIssueLanguage',
    // Listed before type-issue: both templates contain the word
    // "inaccurate", so description must get first refusal.
    templatePatterns: [/description/],
    // The description is wrong/confusing while the type itself is fine.
    prosePatterns: [
      /\b(?:inaccurate|incomplete|incorrect|wrong|confusing|misleading|unclear|outdated)\s+description\b/i,
      new RegExp(String.raw`\bdescription\s+(?:for|of)\b${gap(80)}\bis\s+(?:inaccurate|incomplete|incorrect|wrong|confusing|misleading|unclear|outdated|missing)\b`, 'i'),
      /\bdescription\s+(?:is\s+)?(?:inaccurate|incomplete|incorrect|wrong|confusing|misleading|unclear|outdated)\b/i,
      new RegExp(String.raw`\b(?:doc|docs|documentation)\s+(?:for|of|on)\b${gap(80)}\b(?:is\s+)?(?:inaccurate|incomplete|incorrect|wrong|confusing|misleading|unclear|outdated)\b`, 'i'),
      new RegExp(String.raw`\bdocumentation\s+${DOES_NOT}\s+(?:mention|explain|describe|cover|say)\b`, 'i'),
    ],
    proseNeedsNoTemplate: true,
    suppressedBy: ['definitively-bug'],
  },
  {
    id: 'type-issue',
    label: 'type issue',
    flag: 'hasTypeIssueLanguage',
    templatePatterns: [
      /\btype\s+(?:is\s+)?(?:incorrect|wrong|inaccurate)\b/,
      /\binaccurate\s+propert(?:y|ies)?\s+type/,
    ],
    // "The type exists but its schema is wrong."
    prosePatterns: [
      /\btype\s+(?:definition\s+)?is\s+(?:wrong|incorrect|inaccurate)/i,
      new RegExp(String.raw`\btype\s+(?:definition\s+)?(?:for|of)\b${gap(100)}\bis\s+(?:wrong|incorrect|inaccurate)`, 'i'),
      /\b(?:wrong|incorrect|inaccurate)\s+type\s+(?:for|on)\b/i,
      new RegExp(String.raw`\b(?:${DOESNT}|${DONT})\s+(?:accept|allow)\b`, 'i'),
      /\bshould\s+(?:accept|allow)\b/i,
      new RegExp(String.raw`\brejects?\b${gap(40)}\b(?:string|int|integer|number|bool|boolean|array|value)\b`, 'i'),
      // Classic Bicep type-mismatch diagnostic.
      new RegExp(String.raw`\bexpected\s+a?\s*value\s+of\s+type\b${gap(80)}\bprovided\s+value\s+is\s+of\s+type\b`, 'i'),
      // Inline template value.
      /\binaccurate\s+propert(?:y|ies)?\s+type/i,
    ],
    proseBlockedByTemplate: ['description-issue'],
    suppressedBy: ['definitively-bug', 'definitively-missing'],
  },
  {
    id: 'bug',
    label: 'bug',
    flag: 'hasBugLanguage',
    templatePatterns: [/^bug\b/],
    // Runtime/deployment misbehaviour, not a schema/type defect.
    prosePatterns: [
      /\b(?:deployment|deploy|provisioning)\s+(?:fail|fails|failed|failing)\b/i,
      /\bfail(?:s|ed|ing)?\s+to\s+(?:deploy|provision|create|update)\b/i,
      /\bARM\s+(?:rejects?|errors?\s+on|throws|complains)\b/i,
      /\b(?:error\s+message|error)\s+is\s+(?:unclear|confusing|unhelpful|misleading|cryptic)\b/i,
      /\bconfusing\s+(?:error|message)\b/i,
      new RegExp(String.raw`\b(?:I\s+)?(?:${DONT}|cannot|can['']?t)\s+understand\s+(?:this|the|that)?\s*error\b`, 'i'),
      /\bhas\s+no\s+effect\s+on\s+(?:deployment|the\s+resource|the\s+deploy)\b/i,
      /\bsetting\s+\S+\s+is\s+ignored\b/i,
      new RegExp(String.raw`\b${DOES_NOT}\s+(?:change|affect|modify)\s+anything\b`, 'i'),
      /\bunexpected(?:ly)?\s+(?:fails|behavior|behaviour)\b/i,
      /\b(?:bug|defect)\s+in\s+(?:the\s+)?(?:resource\s+provider|RP|API|service)\b/i,
      /\bintermittent(?:ly)?\s+(?:fail|fails|failing|breaks|errors)\b/i,
    ],
  },
  {
    id: 'idempotency',
    label: 'idempotency issue',
    flag: 'hasIdempotencyLanguage',
    // No template bucket exists for idempotency; it is prose-only.
    templatePatterns: [],
    // The word itself is a high-precision signal for the concept.
    prosePatterns: [/\bidempoten\w*/i],
    proseScope: 'proseAndTitle',
  },
  {
    id: 'deployment',
    label: 'deployment issue',
    flag: 'hasDeploymentLanguage',
    // Listed last so the more specific schema categories claim the
    // template value first.
    templatePatterns: [
      /fails?\s+to\s+deploy/,
      /error\s+message\s+on\s+deployment/,
      /expected\s+effect\s+on\s+deployment/,
    ],
    // Deployment-time problems where the type itself is fine.
    prosePatterns: [
      /\b(?:resource\s+)?fail(?:s|ed|ing)?\s+to\s+deploy\b/i,
      /\bdeployment\s+(?:fail|fails|failed|failing)\b/i,
      /\bconfusing\s+error\s+(?:message\s+)?(?:on|during|at)\s+deployment\b/i,
      /\b(?:no|not|without)\s+(?:having\s+)?(?:the\s+)?expected\s+effect\s+on\s+deployment\b/i,
      /\bdo(?:es)?\s+not\s+have\s+(?:the\s+)?expected\s+effect\s+on\s+deployment\b/i,
    ],
    proseScope: 'proseAndTitle',
    // A non-idempotent re-deploy is its own bucket, never the generic one.
    suppressedBy: ['idempotency'],
  },
];

// Labels the bot owns and will remove once its category stops applying. This
// is what keeps `missing property` / `property found` mutually exclusive
// without pairwise special cases.
const MANAGED_LABELS = [
  ...new Set(ISSUE_CATEGORIES.map(c => c.label)),
  'property found',
  'available in newer version',
  // Deprecated (folded into `missing property`): never applied, but kept here
  // so re-triage strips it from issues labeled before the fold.
  'types unavailable',
];

function normalizeNs(raw) {
  const suffix = raw.slice('Microsoft.'.length);
  const uniform = suffix === suffix.toLowerCase() || suffix === suffix.toUpperCase();
  const norm = uniform
    ? suffix[0].toUpperCase() + suffix.slice(1).toLowerCase()
    : suffix;
  return 'Microsoft.' + norm;
}

// API version extraction. Date-based ARM versions with optional stage suffix
// and revision number.
const VERSION_TOKEN = /\b(\d{4}-\d{2}-\d{2}(?:-(?:preview|beta|alpha|privatepreview)(?:-\d+)?)?)\b/g;
function extractApiVersion(title, body) {
  const text = (title || '') + '\n' + (body || '');
  // 1. Azure issue-template "### Api Version" block, tolerating both the
  //    fenced form and the flattened (newlines-collapsed) form. Confined to
  //    that section so unrelated dates elsewhere can't be mistaken for it.
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

// Read the reporter's `### Issue Type` selection and map it to a category id.
// Accepts both the fenced and inline forms (API-fetched bodies are sometimes
// flattened). Returns null when the template wasn't used.
function matchTemplateIssueType(text) {
  const m = /###\s+Issue\s+Type\b[\s:]*([^\r\n#]+?)(?=\s*(?:###|$|\r|\n))/i.exec(text);
  if (!m) return null;
  const value = m[1].trim().toLowerCase();
  if (!value) return null;
  const hit = ISSUE_CATEGORIES.find(
    c => (c.templatePatterns || []).some(p => p.test(value))
  );
  return hit ? hit.id : null;
}

// Decide whether one category's prose patterns match. Template selections are
// handled by the caller; this is purely the free-text fallback.
function matchesCategoryProse(category, { stripped, bodyProse, title, templateIssueType }) {
  const patterns = category.prosePatterns || [];
  if (patterns.length === 0) return false;
  // Some categories only trust prose when the reporter gave no template
  // answer, or when they didn't pick a specific conflicting category.
  if (category.proseNeedsNoTemplate && templateIssueType !== null) return false;
  if ((category.proseBlockedByTemplate || []).includes(templateIssueType)) return false;
  const haystacks = category.proseScope === 'proseAndTitle'
    ? [bodyProse, title || '']
    : [stripped];
  return haystacks.some(text => patterns.some(p => p.test(text)));
}

function classify(text, opts) {
  opts = opts || {};
  const title = opts.title || '';
  const body = opts.body || '';
  // Mine property NAMES from the reporter's ORIGINAL title (before any bot
  // rename) so the bot never mines its own generated title back in. Falls back
  // to the current title when no original is supplied.
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
    // Drop the whole "Bicep Repro" section, not just its header: the repro's
    // parameter names and working assignments are never the missing property.
    .replace(/###\s+Bicep\s+Repro\b[\s\S]*?(?=###\s|$)/gi, ' ')
    .replace(/_No\s+response_/gi, ' ')
    .replace(/###\s+(?:Resource\s+Type|Api\s+Version|Bicep\s+Repro|Confirm|Other\s+Notes)\b/gi, ' ');
  const stripped = stripTemplate(text);
  // Explicit user signal: when the reporter picked an "Issue Type" in the
  // template, trust it over the loose text heuristics.
  const tmplIssueType = matchTemplateIssueType(text);

  // Layered extraction. Types are passed so resource-type segments aren't
  // mistaken for property names.
  // Whether the mining title is the bot's own canonical renamed format.
  // Normally false, since miningTitle is the reporter's original title.
  const isBotRenamedTitle =
    /^\s*\[Microsoft\.[^\]]+\]:\s+[\w.,\s-]+\s+propert(?:y|ies)\s+missing\s*$/i.test(miningTitle || '');
  const propertyNames = extractAllMissingProperties(
    stripTemplate(miningTitle || ''),
    stripTemplate(body || ''),
    types
  );
  const propertyName = propertyNames[0] || null;

  // Explicit missing-property signals: the template selection, a structured
  // error-message match, or a literal missing phrase in the prose.
  const bodyProse = stripCode(stripTemplate(body || ''));
  const errPat = extractErrorPatterns((miningTitle || '') + '\n' + (body || ''));
  // Skip title matching when the title is the bot's own canonical rename —
  // otherwise our generated title feeds back into the classifier.
  const hasExplicitMissingProp =
    tmplIssueType === 'missing-property' ||
    errPat.properties.length > 0 ||
    EXPLICIT_MISSING_PROP_REGEXES.some(r => r.test(bodyProse)) ||
    (!isBotRenamedTitle && EXPLICIT_MISSING_PROP_REGEXES.some(r => r.test(miningTitle || '')));

  let hasMP = hasExplicitMissingProp;
  // Resource-not-found guard: an ARM "resource not found" trace with no user
  // prose asserting a missing property is not a missing-property report.
  if (hasMP && RESOURCE_NOT_FOUND_RE.test(stripped) && tmplIssueType !== 'missing-property') {
    const propLanguageInProse =
      EXPLICIT_MISSING_PROP_REGEXES.some(r => r.test(bodyProse)) ||
      errPat.properties.length > 0;
    if (!propLanguageInProse) {
      hasMP = false;
    }
  }

  // Two override signals quote literal Bicep/ARM diagnostics, so they are
  // trusted above both the template selection and the prose heuristics. Each
  // force-enables its own category and suppresses categories listing it in
  // `suppressedBy`. Note definitively-bug does not by itself apply the `bug`
  // label; that still needs a real bug signal.
  const hasDefinitivelyMissing =
    DEFINITIVELY_MISSING_REGEXES.some(r => r.test(bodyProse)) ||
    DEFINITIVELY_MISSING_REGEXES.some(r => r.test(title || ''));
  if (hasDefinitivelyMissing) hasMP = true;

  const hasDefinitivelyBug =
    DEFINITIVELY_BUG_REGEXES.some(r => r.test(bodyProse)) ||
    DEFINITIVELY_BUG_REGEXES.some(r => r.test(title || ''));

  // Resolve every category from the ISSUE_CATEGORIES table. Order matters
  // only for `suppressedBy`, which reads flags decided earlier in the table.
  const proseContext = { stripped, bodyProse, title, templateIssueType: tmplIssueType };
  const overrides = {
    'definitively-missing': hasDefinitivelyMissing,
    'definitively-bug': hasDefinitivelyBug,
  };
  const flags = {};
  for (const category of ISSUE_CATEGORIES) {
    // missing-property is detected above by bespoke logic; everything else
    // is "template said so, or prose matched".
    let active = category.detect === 'bespoke'
      ? hasMP
      : tmplIssueType === category.id || matchesCategoryProse(category, proseContext);
    const suppressors = category.suppressedBy || [];
    if (suppressors.some(id => id in overrides ? overrides[id] : flags[id])) {
      active = false;
    }
    flags[category.id] = active;
  }

  return {
    rps: [...rpMap.values()],
    types,
    ...Object.fromEntries(ISSUE_CATEGORIES.map(c => [c.flag, flags[c.id]])),
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

// Scope a types.md down to a SINGLE resource type's schema so a property check
// can't match one belonging to another resource in the same namespace file.
// Walks `[Type](#anchor)` references from the resource heading, transitively
// pulling in only the object types it uses. Returns '' when the heading isn't
// found (caller falls back to the whole document).
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
// A stable GA outranks a preview of the same date, so "latest" never resolves
// to a preview when a GA exists.
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
  ISSUE_CATEGORIES,
  MANAGED_LABELS,
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
        // Paginated so a `generated/` tree past the contents API's
        // single-page cap still lists in full.
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
// request can't stall the whole triage job.
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

// Resolve a Microsoft.X/y resource type to the types.md that declares it,
// preferring preferVersion (the version the user is on) and falling back to
// the latest. Returns { url, status, text, version }.
async function fetchDocsText(type, preferVersion) {
  const parts = type.split('/');
  if (parts.length < 2 || !/^Microsoft\./i.test(parts[0])) {
    return { url: null, status: null, text: null };
  }
  const namespace = parts[0].toLowerCase();
  const slug = namespace.replace(/^microsoft\./, '');
  const generated = await listGenerated();
  const slugRe = new RegExp(`^${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(_\\d+)?$`);
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
  // Sort newest-first (GA ranks above a preview of the same date).
  all.sort((a, b) => compareTypeVersions(a.v, b.v));
  // Honour a pinned API version first so we verify what they're deploying.
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
  // Walk candidates newest-first in small parallel batches, so a type that
  // doesn't exist costs ceil(N/BATCH) round trips instead of N. Sort order is
  // still honoured within a batch.
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

// Find the NEWEST generated API version whose scoped schema contains ALL the
// named properties, turning a dead-end `missing property` into an actionable
// "available in <newer version>" hint. Returns { version, url } or null.
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

// Recover the reporter's original (pre-bot-rename) title from the earliest
// `renamed` timeline event. Falls back to the current title.
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

// Re-entrancy guard: the bot's own renames and label toggles fire further
// `issues.edited`/`labeled` events. Those runs are redundant (the logic is
// idempotent) but burn Actions minutes, so skip them by detecting our actor.
const sender = context.payload.sender || {};
const selfActor = sender.type === 'Bot' &&
  /^(github-actions(\[bot\])?|.*\[bot\])$/i.test(sender.login || '');
if (selfActor && action !== 'opened' && action !== 'reopened') {
  core.info(`Edit was made by the bot itself (${sender.login}); skipping self-triggered run.`);
  return;
}

const text = `${issue.title || ''}\n\n${issue.body || ''}`;
// Recover the reporter's ORIGINAL title so we mine genuine user wording rather
// than the bot's prior output. Only pay for the timeline lookup when the
// current title is one WE prefixed; otherwise it already is the original.
const titleLooksBotPrefixed = /^\s*\[Microsoft\.[^\]]+\]:/.test(issue.title || '');
const originalTitle = titleLooksBotPrefixed
  ? await getOriginalTitle(num, issue.title || '')
  : (issue.title || '');
const cls = classify(text, {
  title: issue.title || '',
  body: issue.body || '',
  miningTitle: originalTitle,
});
// Determine the *primary* resource provider(s) for labeling, in order of
// preference: types in the title, RPs in the title, English keywords in the
// title, types in the body, then any RP in the body. Generic ARM deployment
// wrappers are deprioritized throughout — they appear in every error trace but
// rarely describe the subject of the report.

// Kept only if NO other RP is mentioned anywhere.
const WRAPPER_TYPES = new Set([
  'microsoft.resources/deployments',
  'microsoft.resources/deploymentscripts',
  'microsoft.resources/deploymentstacks',
]);
function nonWrapperTypes(types) {
  return types.filter(t => !WRAPPER_TYPES.has(t.toLowerCase()));
}

// Keyword → RP fallback for titles that describe the resource in English.
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
  `bug=${cls.hasBugLanguage} rwOnly=${cls.hasReadWriteOnlyLanguage} idempotency=${cls.hasIdempotencyLanguage} deployment=${cls.hasDeploymentLanguage} properties=${(cls.propertyNames || []).join(',')} ` +
  `apiVersion=${cls.apiVersion || ''}`
);

// Idempotency: if we've already triaged this issue, don't re-comment.
const priorComments = await github.paginate(github.rest.issues.listComments, {
  owner, repo, issue_number: num, per_page: 100,
});
const alreadyTriaged = priorComments.some(c =>
  c.user && c.user.type === 'Bot' && (c.body || '').includes(MARKER)
);

// --- Property verification against generated types (needs named properties + a type) ---
// propertyVerification: { found: bool, url, type, version, property, results: [{name, found}] }
// Walk EVERY extracted type: the named property may live on the second or
// third type mentioned. Prefer a type confirming all properties AT the user's
// version, else fall back to the first type with a resolvable schema.
let propertyVerification = null;
if (cls.hasMissingPropertyLanguage && cls.propertyNames.length > 0 && cls.types.length > 0) {
  let fallback = null;
  for (const t of cls.types) {
    const docs = await fetchDocsText(t, cls.apiVersion);
    core.info(`Types fetch for ${t} (requested=${cls.apiVersion || 'n/a'}): status=${docs.status} resolved=${docs.version || 'n/a'} matched=${docs.versionMatched} length=${docs.text ? docs.text.length : 0}`);
    if (!docs.text) continue;
    // Restrict the search to THIS resource type's schema so a property on a
    // different resource in the same namespace file can't yield a false
    // "property found". Falls back to the whole document if unscoped.
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
// Driven by the ISSUE_CATEGORIES table; categories whose label depends on
// runtime verification supply a resolveLabel() instead.
//
// `property found` asserts the property exists AT THE USER'S API version, so
// we only claim it when verification actually ran against that version (they
// pinned none, or their pinned version resolved exactly). A pinned version we
// couldn't locate means we checked a different one — treat it as missing.
const verifiedAtUserVersion = Boolean(
  propertyVerification &&
  propertyVerification.found &&
  propertyVerification.versionMatched !== false
);

const labelsToApply = new Set(primaryRps);
for (const category of ISSUE_CATEGORIES) {
  if (!cls[category.flag]) continue;
  const label = category.resolveLabel
    ? category.resolveLabel({ verifiedAtUserVersion })
    : category.label;
  if (label) labelsToApply.add(label);
}

// When the property isn't confirmed at the reporter's pinned version, check
// whether a NEWER version exposes it — "bump your apiVersion" is the
// actionable answer. Only worth the extra fetches when they pinned a version
// and we have both a type and property names.
let newerVersionHit = null;
if (cls.hasMissingPropertyLanguage && !verifiedAtUserVersion &&
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
// Only for `missing property` / `type issue`, matching on same resource type +
// shared property name. Categories never cross. Label + comment only, never
// auto-close.
const isPropOrTypeIssue = cls.hasMissingPropertyLanguage || cls.hasTypeIssueLanguage;
let duplicateMatches = []; // array of { number, createdAt, reason }
const currentTypesLower = new Set(cls.types.map(t => t.toLowerCase()));
const currentPropsLower = new Set((cls.propertyNames || []).map(p => p.toLowerCase()));
const shouldCheckDupes =
  isPropOrTypeIssue &&
  cls.types.length > 0 &&
  cls.propertyName;
if (shouldCheckDupes) {
  // Cost optimization: scan only issues already labeled in the same category
  // bucket rather than every open issue. The API's `labels` filter is
  // AND-combined, so page each bucket separately and merge by number.
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
    // Match on ANY shared property, not just each issue's first-extracted
    // one — reports about the same property are duplicates even when their
    // property lists differ in order or length.
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
// Every managed label is re-derived from scratch each run, so any that this
// run did NOT apply is stale by definition — one rule subsuming all pairwise
// exclusions. Resource-provider labels are additive and never stripped.
const existingNames = new Set((issue.labels || []).map(l => (typeof l === 'string' ? l : l.name)));
async function removeLabelIf(name) {
  if (existingNames.has(name) && !labelsToApply.has(name)) {
    try {
      await github.rest.issues.removeLabel({ owner, repo, issue_number: num, name });
      core.info(`Removed stale label: ${name}`);
    } catch (e) { /* 404 is fine */ }
  }
}
for (const label of MANAGED_LABELS) {
  await removeLabelIf(label);
}

// `possible-duplicate` can't be re-derived every run: the dedupe scan is
// skipped for other categories and can be cut short by rate limits. Strip it
// only when the issue no longer qualifies, or the scan ran and found nothing.
const dedupeVerdictIsTrustworthy =
  !isPropOrTypeIssue ||
  (shouldCheckDupes && duplicateMatches.length === 0);
if (dedupeVerdictIsTrustworthy) {
  await removeLabelIf('possible-duplicate');
}

// --- Title normalization for confirmed missing-property issues ---
// Also runs when the current title is bot-canonical, so earlier noisy renames
// get corrected even after the docs check reclassifies the issue.
const titleIsBotOwned = /^\s*\[Microsoft\.[^\]]+\]:\s+.+\s+propert(?:y|ies)\s+missing\s*$/i.test(issue.title || '');
// Any `[Microsoft.X/y]: <description>` title — the shape we always own and
// normalize, even when a reporter wrote the description.
const titleIsResourcePrefixed = /^\s*\[Microsoft\.[^\]]+\]:\s+\S/i.test(issue.title || '');
// The unedited issue-template default title, left verbatim by the reporter.
const titleIsPlaceholder = /^\s*\[\s*<?\s*resource[_\s]?type\s*>?\s*\]\s*:\s*<?\s*description\s*>?\s*$/i.test(issue.title || '');
// A neutral category placeholder the bot generated. We own these and must
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
  // Either a title we generated or a freeform `[Microsoft.X/y]: <description>`,
  // and re-mining the body yields no property name. Normalize to a neutral,
  // category-appropriate title rather than leaving a wrong one in place.
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
  // Description/documentation issue: give it a neutral, category-appropriate
  // title. Also corrects issues left with a stale bot-generated generic once
  // the classification settles on description-issue.
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
  // Stale bot generic, but the issue no longer classifies into any schema
  // category. Restore the reporter's original pre-rename title when we can
  // recover one that isn't itself a bot generic; otherwise leave it alone —
  // a placeholder like "Needs triage" reads oddly and buries the type.
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
  // The reporter never edited the template default, so replace it with a real
  // title mined from the BODY — including the `property found` contradiction
  // case, where no branch above fires and the placeholder would survive.
  // Placeholders whose body gives no resolvable type are left untouched.
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
// Find any prior bot comment so we can update/delete instead of stacking
// duplicates on retrigger.
const priorBotComment = priorComments.find(c =>
  c.user && c.user.type === 'Bot' && (c.body || '').includes(MARKER)
);

const commentBlocks = [];

// "Property found in generated types" comment (contradiction). Same guard as
// the `property found` label: only claim it when verification ran at the
// user's API version, or they pinned none.
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

// "Available in a newer API version" comment — the actionable fix is to bump
// the apiVersion. Mutually exclusive with the "property found" block above.
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

// Only acknowledge on the FIRST triage; skip on retriggers.
if (commentBlocks.length === 0 && action === 'opened' && !priorBotComment) {
  const lines = ['Thanks for the report! Auto-triage detected:', ''];
  if (primaryRps.length > 0) {
    lines.push(`- **Resource provider${primaryRps.length > 1 ? 's' : ''}:** ` +
      primaryRps.map(r => `\`${r}\``).join(', '));
  }
  // Only include the type for missing-property or type-issue — elsewhere the
  // type isn't the interesting signal.
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
  // Nothing to say anymore — delete the stale bot comment so outdated dupe
  // lists / property-found warnings don't linger.
  await github.rest.issues.deleteComment({
    owner, repo, comment_id: priorBotComment.id,
  });
  core.info('Deleted stale bot comment (no comment blocks apply now).');
}

}

/**
 * ============================================================================
 * AUTO-REFORMAT SCHEMA
 * ============================================================================
 * Canonical schema constants, validator, prompt builder, and hallucination
 * guardrail for the Auto-Reformat feature (Document/URL/Wiki content).
 *
 * Pure, no ST dependencies — same convention as glossary-extractor.js — so
 * this can be unit-tested without mocking SillyTavern globals.
 *
 * DELIBERATELY INDEPENDENT from core/eventbase-schema.js: the record shape is
 * EventBase-*inspired* (a single self-tagged enum field carries the "is this
 * an entity or a topic" branch, same trick as EVENT_TYPES), but nothing here
 * imports from EventBase — this feature must stand on its own so a bug or
 * schema change in chat's EventBase pipeline can never affect Document/Wiki/
 * URL reformatting, and vice versa. Generic, provider-agnostic helpers (the
 * string-array coercion) come from the neutral utils/string-utils.js that both
 * schemas already share — that's a leaf utility, not an EventBase dependency.
 *
 * No CJK-localized prompt variants yet (unlike EventBase's prompts-i18n.js
 * variants) — out of scope for this feature's first pass. buildReformatPrompt
 * still takes a `customPrompt` override so a user who needs non-English
 * extraction instructions can supply their own template today.
 * ============================================================================
 */

import StringUtils from '../utils/string-utils.js';

/**
 * Controlled vocabulary for entry_type field. LLM is instructed to map every
 * extracted record to one of these; 'other' is the fallback.
 * @type {readonly string[]}
 */
export const REFORMAT_ENTRY_TYPES = Object.freeze([
    'character',
    'organization',
    'concept',
    'location',
    'item',
    'other',
]);

export const REFORMAT_SCHEMA_VERSION = 1;

/**
 * Non-fatal extraction parse error (per-batch; caller should log + skip that
 * batch while continuing with the rest of the document).
 */
export class ReformatExtractionError extends Error {
    /**
     * @param {string} message
     * @param {number} [batchIndex]
     */
    constructor(message, batchIndex = -1) {
        super(message);
        this.name = 'ReformatExtractionError';
        this.batchIndex = batchIndex;
    }
}

/**
 * Fatal configuration/auth error (aborts the entire reformat run).
 */
export class ReformatFatalError extends Error {
    /**
     * @param {string} message
     * @param {string} [code]
     */
    constructor(message, code = 'fatal') {
        super(message);
        this.name = 'ReformatFatalError';
        this.code = code;
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Dedupe + trim an array of strings; drop empties. Single implementation lives
// in StringUtils (shared with eventbase-schema.js) — aliased here so the call
// sites below stay terse.
const ensureArray = StringUtils.ensureArray;

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

/**
 * Validates and coerces a raw LLM-produced reformatted-chunk object.
 * @param {unknown} raw
 * @returns {{ ok: boolean, errors: string[], chunk?: object }}
 */
export function validateReformattedChunk(raw) {
    const errors = [];

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        const debugInfo = typeof raw === 'string' ? `string "${raw.slice(0, 50)}"` : typeof raw;
        return { ok: false, errors: [`Reformatted chunk is not an object (got ${debugInfo})`] };
    }

    // entry_type — coerce unknown to 'other'
    let entry_type = String((/** @type {any} */ (raw)).entry_type ?? '').trim().toLowerCase();
    if (!REFORMAT_ENTRY_TYPES.includes(entry_type)) {
        errors.push(`entry_type "${entry_type}" not in vocabulary — coerced to "other"`);
        entry_type = 'other';
    }

    // name — required non-empty string (nothing to key retrieval/dedup on without it)
    const name = typeof (/** @type {any} */ (raw)).name === 'string' ? (/** @type {any} */ (raw)).name.trim() : '';
    if (!name) {
        return { ok: false, errors: ['name is empty or missing'] };
    }

    // body — required non-empty string (nothing to store/embed without it)
    const body = typeof (/** @type {any} */ (raw)).body === 'string' ? (/** @type {any} */ (raw)).body.trim() : '';
    if (!body) {
        return { ok: false, errors: ['body is empty or missing'] };
    }

    const affiliation = typeof (/** @type {any} */ (raw)).affiliation === 'string'
        ? (/** @type {any} */ (raw)).affiliation.trim()
        : '';

    const chunk = {
        entry_type,
        name,
        aliases: ensureArray((/** @type {any} */ (raw)).aliases),
        affiliation,
        traits: ensureArray((/** @type {any} */ (raw)).traits),
        relationships: ensureArray((/** @type {any} */ (raw)).relationships),
        keywords: ensureArray((/** @type {any} */ (raw)).keywords),
        body,
    };

    return { ok: true, errors, chunk };
}

// ---------------------------------------------------------------------------
// Hallucination guardrail
// ---------------------------------------------------------------------------

const MAX_FUZZY_NAME_WORDS = 6;
const MAX_FUZZY_SOURCE_CHARS = 50000;

/**
 * Strips punctuation and collapses whitespace for loose text comparison.
 * @param {string} s
 * @returns {string}
 */
function normalizeForMatch(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Checks whether `name` is grounded in `sourceText` — either an exact
 * (normalized) substring match, or, for short names on reasonably-sized
 * sources, the best word-window Levenshtein similarity meets `threshold`.
 * The fuzzy fallback is intentionally bounded (name length, source length)
 * to keep this a cheap client-side sanity check, not a search engine — see
 * reformat-extractor.js's caller for the O(entities × source) cost note.
 * @param {string} name
 * @param {string} sourceText
 * @param {number} threshold
 * @returns {boolean}
 */
function isNameGroundedInSource(name, sourceText, threshold) {
    const normName = normalizeForMatch(name);
    if (!normName) return false;
    const normSource = normalizeForMatch(sourceText);
    if (!normSource) return false;

    if (normSource.includes(normName)) return true;

    const nameWords = normName.split(' ');
    if (nameWords.length > MAX_FUZZY_NAME_WORDS || normSource.length > MAX_FUZZY_SOURCE_CHARS) {
        // Too expensive to slide a window at this scale — no exact match was
        // found, so treat as unverified rather than silently skipping the check.
        return false;
    }

    const sourceWords = normSource.split(' ');
    let best = 0;
    for (let i = 0; i <= sourceWords.length - nameWords.length; i++) {
        const windowText = sourceWords.slice(i, i + nameWords.length).join(' ');
        const score = StringUtils.similarity(normName, windowText);
        if (score > best) best = score;
        if (best >= threshold) break;
    }
    return best >= threshold;
}

/**
 * Hallucination guardrail: flags any extracted chunk whose `name` (or every
 * one of its `aliases`) doesn't fuzzy-match the source text it was supposedly
 * extracted from. Pure/synchronous — callers (the review UI) render the
 * result as a warning banner, they don't block on it.
 *
 * @param {object[]} chunks - Validated reformatted chunks (from validateReformattedChunk)
 * @param {string} sourceText - The batch's source text the chunks were extracted from
 * @param {number} [threshold=0.8] - Minimum similarity to count as grounded
 * @returns {Array<{nameGrounded: boolean, ungroundedAliases: string[]}>} Parallel to `chunks`
 */
export function computeNameVerification(chunks, sourceText, threshold = 0.8) {
    if (!Array.isArray(chunks)) return [];
    if (!sourceText) return chunks.map(() => ({ nameGrounded: true, ungroundedAliases: [] }));

    return chunks.map(chunk => {
        const nameGrounded = isNameGroundedInSource(chunk?.name || '', sourceText, threshold);
        const aliases = Array.isArray(chunk?.aliases) ? chunk.aliases : [];
        const ungroundedAliases = aliases.filter(a => !isNameGroundedInSource(a, sourceText, threshold));
        return { nameGrounded, ungroundedAliases };
    });
}

// ---------------------------------------------------------------------------
// Extraction prompt builder
// ---------------------------------------------------------------------------

/**
 * Default (English) extraction prompt. Deliberately teaches BOTH regimes in
 * one pass via few-shot examples — see reformat-extractor.js's batching
 * design note on why this is a single self-tagged call, not a literal
 * two-pass classify-then-extract pipeline.
 */
const DEFAULT_REFORMAT_PROMPT = `You are restructuring a piece of reference material (a world bible, lore document, wiki export, or similar) so it can be split into clean, self-contained retrieval records for an AI roleplay memory system.

Read the TEXT below and extract every meaningful "entry" from it. An entry is either:
1. A NAMED ENTITY (a character, organization/faction, location, or item) — even if the document only marks it with bold/italic text or an inline label rather than a markdown heading. Give it its own entry so it can be retrieved on its own, without being diluted by unrelated entities that happen to share the same section.
2. A TOPIC / LORE entry — a self-contained subject (a system, a historical period, a rule, a piece of general worldbuilding) that isn't about one specific named entity.

Output ONLY a JSON array. Each element must have exactly these fields:
{
  "entry_type": one of "character" | "organization" | "concept" | "location" | "item" | "other",
  "name": string — required, the entity's name or the topic's title,
  "aliases": string[] — alternate names/titles this entry is also known by (empty array if none),
  "affiliation": string — group/faction/allegiance this entry belongs to, or "" if not applicable,
  "traits": string[] — short factual descriptors (abilities, role, notable qualities),
  "relationships": string[] — short statements of how this entry relates to other named entries,
  "keywords": string[] — additional search terms someone might use to recall this entry,
  "body": string — the actual retrievable prose for this entry, written so it stands alone (resolve pronouns to the actual name where the source only used "he"/"she"/"they")
}

CRITICAL RULES:
- Reproduce facts VERBATIM from the source. Do not invent details, numbers, names, or relationships that aren't in the text. Do not omit a named detail that IS in the text.
- If a section names multiple distinct entities (e.g. several people in a roster, several factions in a table), give EACH one its own array element — never merge multiple named entities into a single entry.
- If a section is genuinely about one topic with no distinct named sub-entities, emit ONE entry of type "concept" for that whole section rather than fragmenting it.
- Every array field must be an array of strings, even if empty ([]), never a single string or null.

EXAMPLE — a roster where entities are separated only by bold text, not headings:
Input excerpt:
"***Ironclad Agency*** — New York City. **Lead Hero:** Bulwark (Eleanor Graves). **Spark:** Fortress (Transformation-type) — Bulwark can transform her hide into indestructible metal.
***Ember Corps*** — Los Angeles. **Lead Hero:** Solaris. **Spark:** Inferno Drive — controls fire at extreme temperatures."
Correct output (two SEPARATE entries, not one merged entry):
[
  {"entry_type":"character","name":"Bulwark","aliases":["Eleanor Graves"],"affiliation":"Ironclad Agency","traits":["Transformation-type Spark: Fortress","can transform hide into indestructible metal"],"relationships":[],"keywords":["Ironclad","New York City","Fortress"],"body":"Bulwark (Eleanor Graves) is the lead hero of Ironclad Agency, based in New York City. Her Spark, \\"Fortress\\" (Transformation-type), lets Bulwark transform her hide into indestructible metal."},
  {"entry_type":"character","name":"Solaris","aliases":[],"affiliation":"Ember Corps","traits":["Emitter-type Spark: Inferno Drive","controls fire at extreme temperatures"],"relationships":[],"keywords":["Ember Corps","Los Angeles","Inferno Drive"],"body":"Solaris is the lead hero of Ember Corps, based in Los Angeles. Her Spark, \\"Inferno Drive\\", lets Solaris control fire at extreme temperatures."}
]

EXAMPLE — a topic/lore section with no distinct named entity:
Input excerpt:
"## Spark Classification System — Sparks fall into four categories based on how they manifest: Emitter (generate/control without permanent change), Transformation (temporary physical change), Mutant (permanent physical change), and Accumulation (must store energy before use)."
Correct output (ONE concept entry, not split per category unless categories are independently discussed at length elsewhere):
[
  {"entry_type":"concept","name":"Spark Classification System","aliases":[],"affiliation":"","traits":["four categories: Emitter, Transformation, Mutant, Accumulation"],"relationships":[],"keywords":["Spark types","classification","Emitter","Transformation","Mutant","Accumulation"],"body":"Sparks fall into four categories based on how they manifest: Emitter-type (generate/control something without permanent physical change), Transformation-type (temporary physical change while active), Mutant-type (permanent physical change), and Accumulation-type (must store energy/resource before it can be used)."}
]

{{continuationNote}}
TEXT:
{{text}}

Output ONLY the JSON array, no commentary, no markdown code fences.`;

/**
 * Builds the LLM extraction prompt for a given batch of source text.
 *
 * @param {string} text - The batch's source text
 * @param {object} [options]
 * @param {string} [options.customPrompt] - User-edited override from settings.reformat_custom_prompt
 * @param {{sectionTitle: string, alreadyExtractedNames: string[]}} [options.batchContext] -
 *        Set when this batch is a continuation of an oversized section (see the
 *        packer in reformat-extractor.js) so the model doesn't re-emit entities
 *        it already produced for an earlier slice of the same section.
 * @returns {string}
 */
export function buildReformatPrompt(text, { customPrompt = '', batchContext = null } = {}) {
    const template = (customPrompt && customPrompt.trim()) ? customPrompt : DEFAULT_REFORMAT_PROMPT;

    let continuationNote = '';
    if (batchContext?.sectionTitle) {
        const namesList = batchContext.alreadyExtractedNames?.length
            ? batchContext.alreadyExtractedNames.join(', ')
            : '(none yet)';
        continuationNote = `NOTE: This text is a continuation of section "${batchContext.sectionTitle}", which was too long for one call and was split. Entries already extracted from earlier in this same section: ${namesList}. Do NOT re-emit them — only extract entries that haven't been covered yet.\n\n`;
    }

    return template
        .replace(/\{\{continuationNote\}\}/g, continuationNote)
        .replace(/\{\{text\}\}/g, text);
}

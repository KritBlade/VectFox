/**
 * ============================================================================
 * ACRONYM GLOSSARY EXTRACTOR
 * ============================================================================
 * Pure, no ST dependencies — same convention as lorebook-content-preparer.js —
 * so this can be unit-tested without mocking SillyTavern globals.
 *
 * PROBLEM THIS SOLVES
 * A long-form document (world bible, lore doc, wiki export) typically spells
 * out a named entity's full form exactly once — "Federal Hero Oversight
 * Bureau (FHOB)" — and every later mention uses the bare acronym, trusting
 * the reader already saw the definition. Chunk-based RAG breaks that
 * assumption: a chunk containing only "Threat Level (FHOB): Severe" can be
 * retrieved on its own, with the one chunk that defines FHOB never surfacing
 * alongside it. The model then has an ungrounded token and may confabulate
 * a plausible-sounding but wrong expansion.
 *
 * FIX
 * Scan the whole source document once for "<Phrase> (<ACRONYM>)" definitions,
 * then prepend a compact glossary line to any chunk that references an
 * acronym without also containing its full name — so every chunk is
 * self-grounding regardless of which one gets retrieved.
 * ============================================================================
 */

const STOPWORDS = new Set(['of', 'the', 'and', 'for', 'a', 'an', 'in', 'on', 'to', '&']);

// Leading word must be capitalized (real definitions don't start mid-phrase
// on a connector); subsequent words may be any case so connectors like
// "of"/"the" inside a name ("Department of Justice") can be captured, then
// trimmed away by the initials check below if they're not actually part of
// the abbreviated span.
const CANDIDATE_RE = /([A-Z][\w'-]*(?:\s+[A-Za-z][\w'-]*){0,7})\s*\(([A-Z]{2,8})\)/g;

/**
 * Real-world acronyms are inconsistent about whether minor words contribute a
 * letter: "DOJ" = Department **of** Justice (every word counts) but "ISRC" =
 * (The) International Spark Research Council (the leading stopword doesn't).
 * Compute both variants and let the caller accept either, rather than
 * guessing which convention a given acronym follows.
 * @param {string} phrase
 * @returns {Set<string>} Candidate initials strings, uppercased.
 */
function initialsVariants(phrase) {
    const words = phrase.split(/\s+/).filter(Boolean);
    const allWords = words.map(w => w[0].toUpperCase()).join('');
    const significantWords = words
        .filter(w => !STOPWORDS.has(w.toLowerCase()))
        .map(w => w[0].toUpperCase())
        .join('');
    return new Set([allWords, significantWords]);
}

/**
 * Extract acronym→full-name definitions from a document.
 *
 * Only keeps a candidate whose initials match the acronym exactly (rejects
 * false positives like "Threat Level (FHOB)"), trying progressively shorter
 * suffixes of the captured phrase so leading sentence words swept up by the
 * greedy match don't block a real match. Keeps the FIRST valid definition
 * per acronym — documents define before referencing.
 *
 * @param {string} fullText - The complete source document, pre-chunking.
 * @returns {Array<{acronym: string, fullName: string}>}
 */
export function extractGlossary(fullText) {
    if (!fullText || typeof fullText !== 'string') return [];

    const glossary = [];
    const seen = new Set();
    const re = new RegExp(CANDIDATE_RE.source, 'g');
    let match;

    while ((match = re.exec(fullText)) !== null) {
        const [, rawPhrase, acronym] = match;
        if (seen.has(acronym)) continue;

        const words = rawPhrase.split(/\s+/);
        let fullName = null;
        for (let start = 0; start < words.length; start++) {
            const candidate = words.slice(start).join(' ');
            if (initialsVariants(candidate).has(acronym)) {
                fullName = candidate;
                break;
            }
        }
        if (!fullName) continue;

        seen.add(acronym);
        glossary.push({ acronym, fullName });
    }

    return glossary;
}

/**
 * Prepend grounding glossary lines to chunks that reference an acronym
 * without also containing its full name. Non-mutating — returns a new array.
 *
 * @param {Array<{text: string, metadata?: object}>} chunks - Output of chunkText()
 * @param {Array<{acronym: string, fullName: string}>} glossary - From extractGlossary()
 * @returns {Array} New chunks array, unaffected chunks returned as-is
 */
export function injectGlossary(chunks, glossary) {
    if (!Array.isArray(chunks) || !glossary?.length) return chunks || [];

    return chunks.map(chunk => {
        const text = typeof chunk === 'string' ? chunk : chunk.text;
        if (!text) return chunk;

        const linesToAdd = glossary
            .filter(({ acronym, fullName }) => new RegExp(`\\b${acronym}\\b`).test(text) && !text.includes(fullName))
            .map(({ acronym, fullName }) => `[Glossary: ${acronym} = ${fullName}]`);

        if (linesToAdd.length === 0) return chunk;

        const newText = `${linesToAdd.join('\n')}\n${text}`;
        return typeof chunk === 'string' ? newText : { ...chunk, text: newText };
    });
}

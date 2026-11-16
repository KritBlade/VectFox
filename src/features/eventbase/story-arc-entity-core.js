/**
 * ============================================================================
 * STORY ARC ENTITIES
 * ============================================================================
 * A person, place or faction can go by several names in a chat's stored events.
 * An entity merge records which names are one entity and which name is kept, as
 * { kept name: [other names] }. It applies when StoryArc reads: stored events and
 * their vectors never change, so a merge costs nothing and can be split again.
 * Spellings that differ only in case are one name, as an LLM writes a name in more
 * than one case. A name is found only where it stands as a word: a Latin-script name,
 * accented or not, where no Latin letter touches it, a Chinese, Japanese, Thai, Lao,
 * Khmer or Burmese name where the runtime's word splitter starts and ends a word, and a
 * Korean name where it starts a word with only particles after it, so a merged 家 is
 * never found inside 家族, a merged Zoë inside Zoëlla, nor a merged 바다 inside 앞바다.
 *
 * Pure: no host imports.
 * ============================================================================
 */

/** Which stored tag lists each kind of entity. */
const ENTITY_TAG_BY_KIND = Object.freeze({ people: 'characters', factions: 'factions', places: 'locations' });
const KIND_OF_UNTAGGED_ENTITY = 'people';

/** The event fields that can hold a name, which a reader or an LLM sees. */
const NAME_FIELDS = ['text', 'summary', 'cause', 'result', 'characters', 'locations', 'factions', 'items', 'concepts', 'keywords', 'open_threads'];

/**
 * A name holding less than this share of its entity's events stays out of the
 * search: a rare spelling is a rare word, which pulls the search toward itself.
 */
const SEARCHED_NAME_SHARE = 0.1;

/**
 * A longer name holding an other name is a different person only when this many events
 * tag it. Fewer are a one-off spelling, such as the name with a title on it.
 */
const OWN_ENTITY_MIN_EVENTS = 3;

/** What separates the parts of a full name, such as a given name and a family name. */
const NAME_PART_SEPARATORS = /[·・．.\s]+/;

/** A name in Latin script, accented letters such as ë and é included, with any digits, punctuation and spaces. */
const isLatinName = (name) => /^[\p{Script=Latin}\p{M}\p{N}\p{P}\p{S}\p{Zs}]+$/u.test(name);
/** A Latin name matches only where no Latin letter or accent mark touches it, so Zoë is not found in Zoëlla, but is in Zoë的劍. */
const asPattern = (name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return isLatinName(name) ? `(?<![\\p{Script=Latin}\\p{M}])${escaped}(?![\\p{Script=Latin}\\p{M}])` : escaped;
};
const isSameName = (a, b) => a.toLowerCase() === b.toLowerCase();

/**
 * Scripts written with no spaces between words, whose words the runtime's word splitter
 * knows from its dictionaries: Chinese, Japanese, Thai, Lao, Khmer and Burmese.
 */
const UNSPACED_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
/** The word edges of texts already split, as a turn reads one text for several names. Emptied when full. */
const wordEdgesByText = new Map();
const WORD_EDGE_TEXT_LIMIT = 5000;

/** Where the words of a text start and end, by the runtime's word splitter, which knows the words of the unspaced scripts. */
function wordEdgesOf(text) {
    const known = wordEdgesByText.get(text);
    if (known) return known;
    const edges = new Set([text.length]);
    for (const { index } of wordSegmenter.segment(text)) edges.add(index);
    if (wordEdgesByText.size >= WORD_EDGE_TEXT_LIMIT) wordEdgesByText.clear();
    wordEdgesByText.set(text, edges);
    return edges;
}

/** Korean, which writes spaces between words but joins particles to the end of a name. */
const HANGUL = /\p{Script=Hangul}/u;
const HANGUL_RUN = /^\p{Script=Hangul}*/u;
/**
 * What can follow a Korean name inside its word, alone or one after another as in 바다에서는:
 * case, topic and other particles, the vocative, the honorifics 님 and 씨, the plural 들, and
 * the copula's common forms. Anything else joined to the name makes it part of another word.
 */
const KOREAN_PARTICLES = [
    '이', '가', '께서', '은', '는', '을', '를', '의',
    '에', '에서', '에게', '에게서', '한테', '한테서', '께', '로', '으로', '로서', '으로서', '로써', '으로써',
    '와', '과', '랑', '이랑', '하고',
    '도', '만', '까지', '부터', '조차', '마저', '밖에', '뿐', '처럼', '보다', '같이', '만큼', '대로',
    '나', '이나', '든', '이든', '든지', '이든지',
    '아', '야', '여', '이여', '님', '씨', '들',
    '이다', '다', '이야', '예요', '이에요', '입니다', '였다', '이었다',
];
const KOREAN_PARTICLES_ONLY = new RegExp(`^(?:${[...KOREAN_PARTICLES].sort((a, b) => b.length - a.length).join('|')})*$`, 'u');

/**
 * Whether a name found at `start` stands as a word. A name in an unspaced script, such
 * as Chinese or Thai, must start and end a word, so 家 inside 家族 does not count. A
 * Korean name must start a word, with only particles after it in that word, so 바다가
 * counts and 앞바다 and 바다표범 do not; a one-syllable name can still be read inside a
 * word that looks like it with a particle, as 나 in 나이. A Latin name's pattern already
 * keeps to whole words, and a name in another script counts wherever it is found: Arabic
 * and Hebrew join articles and conjunctions to the front of a word, and Greek and Russian
 * change a name's ending.
 */
function standsAsWord(text, start, name) {
    if (UNSPACED_SCRIPT.test(name)) {
        const edges = wordEdgesOf(text);
        return edges.has(start) && edges.has(start + name.length);
    }
    if (HANGUL.test(name)) {
        const isWordStart = !HANGUL.test(text[start - 1] ?? '');
        const restOfWord = text.slice(start + name.length).match(HANGUL_RUN)[0];
        return isWordStart && KOREAN_PARTICLES_ONLY.test(restOfWord);
    }
    return true;
}

/** Whether a text holds a name as a word (standsAsWord): a Latin name only as a whole word, in any case. */
function holdsName(text, name) {
    if (isLatinName(name)) return new RegExp(asPattern(name), 'iu').test(text);
    for (let start = text.indexOf(name); start >= 0; start = text.indexOf(name, start + 1)) {
        if (standsAsWord(text, start, name)) return true;
    }
    return false;
}

/** The kept name of every other name, keyed in lower case. */
function keptNameByOtherName(merges) {
    return new Map(Object.entries(merges).flatMap(([kept, others]) => others.map(other => [other.toLowerCase(), kept])));
}

/** The kept name of every name a merge holds, the kept name itself included, keyed in lower case. */
function keptNameByName(merges) {
    return new Map([...Object.keys(merges).map(kept => [kept.toLowerCase(), kept]), ...keptNameByOtherName(merges)]);
}

/**
 * @param {Record<string, string[]>} merges
 * @returns {boolean}
 */
export function hasEntityMerges(merges) {
    return Object.keys(merges ?? {}).length > 0;
}

/**
 * Longer names that merely hold an other name, which the writer leaves alone: a
 * different person's name can end in a short name. A full name with the other name as
 * one of its parts is still that person, and so is a spelling few events tag.
 *
 * @param {Record<string, string[]>} merges
 * @param {object[]} storedEvents
 * @returns {string[]}
 */
export function entityNamesLeftAlone(merges, storedEvents) {
    const otherNames = Object.values(merges).flat().filter(name => !isLatinName(name));
    const tagEventCount = new Map();
    for (const event of storedEvents) {
        for (const tag of new Set((event.characters ?? []).map(name => String(name).trim()))) tagEventCount.set(tag, (tagEventCount.get(tag) ?? 0) + 1);
    }
    const ownEntities = [...tagEventCount].filter(([, count]) => count >= OWN_ENTITY_MIN_EVENTS).map(([tag]) => tag);
    return [...new Set([...Object.keys(merges), ...ownEntities])]
        .filter(name => otherNames.some(other => name.length > other.length && name.includes(other) && !name.split(NAME_PART_SEPARATORS).includes(other)));
}

/**
 * A function that writes every other name as its kept name, where the name stands as a
 * word (standsAsWord). The longest name wins where names overlap.
 *
 * @param {Record<string, string[]>} merges
 * @param {object[]} [storedEvents] - Their `characters` tags say which longer names are other people (entityNamesLeftAlone)
 * @returns {(text: string) => string}
 */
export function buildEntityNameWriter(merges, storedEvents = []) {
    if (!hasEntityMerges(merges)) return text => text;
    const keptByOther = keptNameByOtherName(merges);
    const alternatives = [...new Set([...keptByOther.keys(), ...entityNamesLeftAlone(merges, storedEvents)])]
        .sort((a, b) => b.length - a.length)
        .map(asPattern);
    const pattern = new RegExp(alternatives.join('|'), 'giu');
    return text => text.replace(pattern, (match, start) => {
        const keptName = keptByOther.get(match.toLowerCase());
        return keptName && standsAsWord(text, start, match) ? keptName : match;
    });
}

/**
 * Events as StoryArc reads them, with kept names. The events given stay as they are.
 *
 * @param {object[]} events
 * @param {(text: string) => string} writeName - From buildEntityNameWriter
 * @returns {object[]}
 */
export function withKeptEntityNames(events, writeName) {
    return events.map((event) => {
        const written = { ...event };
        for (const field of NAME_FIELDS) {
            const value = event[field];
            if (typeof value === 'string') written[field] = writeName(value);
            else if (Array.isArray(value)) written[field] = value.map(entry => (typeof entry === 'string' ? writeName(entry) : entry));
        }
        if (Array.isArray(event.story_links)) {
            written.story_links = event.story_links.map(link => (link.thread ? { ...link, thread: writeName(link.thread) } : link));
        }
        return written;
    });
}

/**
 * The text to search for a question: stored vectors keep the names they were built
 * from, so it also asks for the other names of anyone the question or its subject
 * names, in any case, except the rare ones.
 *
 * @param {object} params
 * @param {string} params.queryText
 * @param {string} params.subject - The router's subject, or '' for none
 * @param {Record<string, string[]>} params.merges
 * @param {object[]} params.storedEvents
 * @returns {string}
 */
export function entitySearchText({ queryText, subject, merges, storedEvents }) {
    const isInQuestion = name => holdsName(queryText, name);
    const isAsked = name => isInQuestion(name) || (subject && isSameName(subject, name));
    const addedNames = Object.entries(merges)
        .map(([kept, others]) => [kept, ...others])
        .filter(names => names.some(isAsked))
        .flatMap((names) => {
            const counts = names.map(name => storedEvents.filter(event => holdsName(String(event.text ?? ''), name)).length);
            const total = counts.reduce((sum, count) => sum + count, 0);
            return names.filter((name, place) => !isInQuestion(name) && counts[place] / Math.max(total, 1) >= SEARCHED_NAME_SHARE);
        });
    return addedNames.length ? `${queryText} ${addedNames.join(' ')}` : queryText;
}

/**
 * The other names a player's message uses, since the block below it reads with the
 * kept names.
 *
 * @param {string} message
 * @param {Record<string, string[]>} merges
 * @returns {{name: string, keptName: string}[]}
 */
export function entityNamesInMessage(message, merges) {
    return Object.entries(merges).flatMap(([keptName, others]) => others
        .filter(name => holdsName(message, name))
        .map(name => ({ name, keptName })));
}

/**
 * One kind's entities, most named first. A name's spellings that differ only in case
 * are one row, shown in the spelling most events tag. A merged entity goes by its kept
 * name, counts every event naming it, and shows under the kinds that tag one of its
 * names. One that no tag names still shows, under people, so it can be split again.
 *
 * @param {object[]} storedEvents
 * @param {Record<string, string[]>} merges
 * @param {string} kind - people, factions or places
 * @returns {{name: string, otherNames: string[], eventCount: number}[]}
 */
export function listEntities(storedEvents, merges, kind) {
    const keptByName = keptNameByName(merges);
    const keptNameOf = name => keptByName.get(name.toLowerCase()) ?? name;
    // Each name in lower case, with how many events tag it, in all and in each spelling.
    const tallyOfKind = (wantedKind) => {
        const tallyByLowerCaseName = new Map();
        for (const event of storedEvents) {
            const tags = Array.isArray(event[ENTITY_TAG_BY_KIND[wantedKind]]) ? event[ENTITY_TAG_BY_KIND[wantedKind]] : [];
            const spellings = new Set(tags.map(tag => String(tag).trim()).filter(Boolean).map(keptNameOf));
            for (const lowerCaseName of new Set([...spellings].map(spelling => spelling.toLowerCase()))) {
                const tally = tallyByLowerCaseName.get(lowerCaseName) ?? { eventCount: 0, eventCountBySpelling: new Map() };
                tally.eventCount += 1;
                tallyByLowerCaseName.set(lowerCaseName, tally);
            }
            for (const spelling of spellings) {
                const { eventCountBySpelling } = tallyByLowerCaseName.get(spelling.toLowerCase());
                eventCountBySpelling.set(spelling, (eventCountBySpelling.get(spelling) ?? 0) + 1);
            }
        }
        return tallyByLowerCaseName;
    };
    const tallyByLowerCaseName = tallyOfKind(kind);
    if (kind === KIND_OF_UNTAGGED_ENTITY) {
        const tagged = new Set(Object.keys(ENTITY_TAG_BY_KIND).flatMap(eachKind => [...tallyOfKind(eachKind).keys()]));
        for (const kept of Object.keys(merges)) {
            if (!tagged.has(kept.toLowerCase())) tallyByLowerCaseName.set(kept.toLowerCase(), { eventCount: 0, eventCountBySpelling: new Map([[kept, 0]]) });
        }
    }
    for (const [kept, others] of Object.entries(merges)) {
        const tally = tallyByLowerCaseName.get(kept.toLowerCase());
        if (!tally) continue;
        const names = [kept, ...others];
        tally.eventCount = storedEvents.filter(event => names.some(name => holdsName(String(event.text ?? ''), name))).length;
    }
    return [...tallyByLowerCaseName.values()]
        .map(({ eventCount, eventCountBySpelling }) => {
            const [name] = [...eventCountBySpelling].reduce((most, spelling) => (spelling[1] > most[1] ? spelling : most));
            return { name, otherNames: merges[name] ?? [], eventCount };
        })
        .sort((a, b) => (b.eventCount - a.eventCount) || a.name.localeCompare(b.name));
}

/**
 * Rows whose name or other names hold a search word.
 *
 * @param {{name: string, otherNames: string[]}[]} rows
 * @param {string} word
 * @returns {object[]}
 */
export function filterEntities(rows, word) {
    const wanted = word.trim().toLowerCase();
    if (!wanted) return rows;
    return rows.filter(row => [row.name, ...row.otherNames].some(name => name.toLowerCase().includes(wanted)));
}

/**
 * Whether the Entity tab hides a name. A name is hidden in any case, since its row
 * shows the spelling most events tag, which can change as events are added.
 *
 * @param {string[]} hiddenNames
 * @param {string} name
 * @returns {boolean}
 */
export function isHiddenEntityName(hiddenNames, name) {
    return hiddenNames.some(hidden => isSameName(hidden, name));
}

/**
 * The hidden names without a name, in every case it is hidden in.
 *
 * @param {string[]} hiddenNames
 * @param {string} name
 * @returns {string[]} a new array
 */
export function showEntityNameAgain(hiddenNames, name) {
    return hiddenNames.filter(hidden => !isSameName(hidden, name));
}

/**
 * Rows split by whether the Entity tab hides their name. Hiding keeps a name off that
 * list only: StoryArc still reads every hidden name, in the search, the router and the
 * block.
 *
 * @param {{name: string}[]} rows
 * @param {string[]} hiddenNames - Kept names
 * @returns {{shownRows: object[], hiddenRows: object[]}}
 */
export function separateHiddenEntities(rows, hiddenNames) {
    const isHidden = row => isHiddenEntityName(hiddenNames, row.name);
    return {
        shownRows: rows.filter(row => !isHidden(row)),
        hiddenRows: rows.filter(isHidden),
    };
}

/**
 * Merge one name into another: the target stays the kept name, and the source's name
 * and its own other names become other names of it. A name already in an entity, as
 * its kept name or an other name and in any case, means that entity.
 *
 * @param {Record<string, string[]>} merges
 * @param {string} sourceName
 * @param {string} targetName
 * @returns {{isMerged: boolean, merges: Record<string, string[]>, keptName?: string, reason?: string}} merges is a
 *          new object, and keptName the name the merged entity goes by
 */
export function mergeEntityNames(merges, sourceName, targetName) {
    const keptByName = keptNameByName(merges);
    const keptOf = name => keptByName.get(name.toLowerCase()) ?? name;
    const source = keptOf(sourceName.trim());
    const target = keptOf(targetName.trim());
    if (!source || !target) return { isMerged: false, merges, reason: 'Choose a name to merge into.' };
    if (isSameName(source, target)) return { isMerged: false, merges, reason: `"${sourceName.trim()}" and "${targetName.trim()}" are already one entity.` };
    const { [source]: sourceOthers = [], ...rest } = merges;
    return { isMerged: true, merges: { ...rest, [target]: [...(merges[target] ?? []), source, ...sourceOthers] }, keptName: target };
}

/**
 * Take an other name back out of its entity.
 *
 * @param {Record<string, string[]>} merges
 * @param {string} keptName
 * @param {string} otherName
 * @returns {Record<string, string[]>} a new object
 */
export function splitEntityName(merges, keptName, otherName) {
    const { [keptName]: others = [], ...rest } = merges;
    const remaining = others.filter(name => name !== otherName);
    return remaining.length ? { ...rest, [keptName]: remaining } : rest;
}

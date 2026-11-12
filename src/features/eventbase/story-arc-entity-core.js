/**
 * ============================================================================
 * STORY ARC ENTITIES
 * ============================================================================
 * A person, place or faction can go by several names in a chat's stored events.
 * An entity merge records which names are one entity and which name is kept, as
 * { kept name: [other names] }. It applies when StoryArc reads: stored events and
 * their vectors never change, so a merge costs nothing and can be split again.
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

const isLatinName = (name) => /^[\x20-\x7e]+$/.test(name);
const asPattern = (name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return isLatinName(name) ? `(?<![A-Za-z])${escaped}(?![A-Za-z])` : escaped;
};
const isSameName = (a, b) => a.toLowerCase() === b.toLowerCase();

/** Whether a text holds a name: a Latin name only as a whole word, in any case. */
function holdsName(text, name) {
    return isLatinName(name) ? new RegExp(asPattern(name), 'i').test(text) : text.includes(name);
}

/** The kept name of every other name, keyed in lower case. */
function keptNameByOtherName(merges) {
    return new Map(Object.entries(merges).flatMap(([kept, others]) => others.map(other => [other.toLowerCase(), kept])));
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
 * A function that writes every other name as its kept name. The longest name wins
 * where names overlap.
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
    const pattern = new RegExp(alternatives.join('|'), 'gi');
    return text => text.replace(pattern, match => keptByOther.get(match.toLowerCase()) ?? match);
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
 * names, except the rare ones.
 *
 * @param {object} params
 * @param {string} params.queryText
 * @param {string} params.subject - The router's subject, or '' for none
 * @param {Record<string, string[]>} params.merges
 * @param {object[]} params.storedEvents
 * @returns {string}
 */
export function entitySearchText({ queryText, subject, merges, storedEvents }) {
    const isAsked = name => queryText.includes(name) || (subject && isSameName(subject, name));
    const addedNames = Object.entries(merges)
        .map(([kept, others]) => [kept, ...others])
        .filter(names => names.some(isAsked))
        .flatMap((names) => {
            const counts = names.map(name => storedEvents.filter(event => holdsName(String(event.text ?? ''), name)).length);
            const total = counts.reduce((sum, count) => sum + count, 0);
            return names.filter((name, place) => !queryText.includes(name) && counts[place] / Math.max(total, 1) >= SEARCHED_NAME_SHARE);
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
 * One kind's entities, most named first. A merged entity counts every event naming
 * it, and shows under the kinds that tag one of its names. One that no tag names
 * still shows, under people, so it can be split again.
 *
 * @param {object[]} storedEvents
 * @param {Record<string, string[]>} merges
 * @param {string} kind - people, factions or places
 * @returns {{name: string, otherNames: string[], eventCount: number}[]}
 */
export function listEntities(storedEvents, merges, kind) {
    const keptByOther = keptNameByOtherName(merges);
    const keptNameOf = name => keptByOther.get(name.toLowerCase()) ?? name;
    const namesOfKind = (wantedKind) => {
        const eventCountByName = new Map();
        for (const event of storedEvents) {
            const tags = Array.isArray(event[ENTITY_TAG_BY_KIND[wantedKind]]) ? event[ENTITY_TAG_BY_KIND[wantedKind]] : [];
            const names = new Set(tags.map(tag => String(tag).trim()).filter(Boolean).map(keptNameOf));
            for (const name of names) eventCountByName.set(name, (eventCountByName.get(name) ?? 0) + 1);
        }
        return eventCountByName;
    };
    const eventCountByName = namesOfKind(kind);
    if (kind === KIND_OF_UNTAGGED_ENTITY) {
        const tagged = new Set(Object.keys(ENTITY_TAG_BY_KIND).flatMap(eachKind => [...namesOfKind(eachKind).keys()]));
        for (const kept of Object.keys(merges)) {
            if (!tagged.has(kept)) eventCountByName.set(kept, 0);
        }
    }
    for (const [kept, others] of Object.entries(merges)) {
        if (!eventCountByName.has(kept)) continue;
        const names = [kept, ...others];
        eventCountByName.set(kept, storedEvents.filter(event => names.some(name => holdsName(String(event.text ?? ''), name))).length);
    }
    return [...eventCountByName]
        .map(([name, eventCount]) => ({ name, otherNames: merges[name] ?? [], eventCount }))
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
 * Rows split by whether the Entity tab hides their name. Hiding keeps a name off that
 * list only: StoryArc still reads every hidden name, in the search, the router and the
 * block.
 *
 * @param {{name: string}[]} rows
 * @param {string[]} hiddenNames - Kept names
 * @returns {{shownRows: object[], hiddenRows: object[]}}
 */
export function separateHiddenEntities(rows, hiddenNames) {
    const hidden = new Set(hiddenNames);
    return {
        shownRows: rows.filter(row => !hidden.has(row.name)),
        hiddenRows: rows.filter(row => hidden.has(row.name)),
    };
}

/**
 * Merge one name into another: the target stays the kept name, and the source's name
 * and its own other names become other names of it. A target that is already another
 * entity's other name means that entity.
 *
 * @param {Record<string, string[]>} merges
 * @param {string} sourceName
 * @param {string} targetName
 * @returns {{isMerged: boolean, merges: Record<string, string[]>, keptName?: string, reason?: string}} merges is a
 *          new object, and keptName the name the merged entity goes by
 */
export function mergeEntityNames(merges, sourceName, targetName) {
    const keptByOther = keptNameByOtherName(merges);
    const keptOf = name => keptByOther.get(name.toLowerCase()) ?? name;
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

/**
 * ============================================================================
 * EVENTBASE WINDOW REPLACEMENT — pure logic
 * ============================================================================
 * A chat window EventBase extracts again replaces the events it holds. A window
 * is extracted again when one of its messages changed, as an edit or a script
 * rewriting old replies does, or when the record of extracted windows lost it.
 * Its earlier events would otherwise stay beside the new ones: two versions of
 * the same moment.
 *
 * A stored event is replaced when it is of the same window (the same first and
 * last message), shares at least one message with the new extraction, and was
 * written before it. Every run numbers its windows from the chat's first
 * message, a run from a later message included (runEventBaseIngestion), so the
 * same first and last message is the same window. The shared message keeps a
 * window from removing the events of other messages stored under its number, as
 * a message deleted or added earlier in the chat leaves them. It is a loose
 * check: a message repeated word for word, as a short user reply often is, has
 * the same hash wherever it sits. The time keeps two sessions extracting one
 * window at once from removing each other's newer events.
 *
 * StoryArc links that pointed at a replaced event move to the first new event of
 * its window, so a walk still passes through that moment.
 *
 * createWindowReplacement (eventbase-store.js) reads and writes the collection.
 * ============================================================================
 */

/**
 * A window's place in the chat, its first and last message, as one key.
 *
 * @param {{source_window_start?: number, source_window_end?: number}} event
 * @returns {string}
 */
export function windowSpanOf(event) {
    return `${event.source_window_start}-${event.source_window_end}`;
}

/**
 * When an event's extraction call ran: its created_at, or else the time its event_id begins with.
 *
 * @param {{created_at?: number, event_id?: string}} event
 * @returns {number|null} null when the event records neither
 */
export function extractionTimeOf(event) {
    if (typeof event.created_at === 'number') return event.created_at;
    const idTime = /^eb_(\d+)_/.exec(String(event.event_id ?? ''))?.[1];
    return idTime === undefined ? null : Number(idTime);
}

/**
 * Whether a run's windows can hold events of earlier extractions, so the collection has to be
 * read. A window before the tip can, and with no tip known any window can. So can a run that
 * extracts more than one window, since a settings file saved by an older session puts back an
 * older tip along with an older record of extracted windows. A run that extracts only the window
 * after the newest, as an ordinary turn does, cannot.
 *
 * @param {object[]} runEvents - Every event the run stored so far
 * @param {number|null|undefined} tipAtRunStart - One past the last message extracted when the run began
 * @returns {boolean}
 */
export function mayHoldEarlierEvents(runEvents, tipAtRunStart) {
    if (typeof tipAtRunStart !== 'number') return true;
    if (new Set(runEvents.map(windowSpanOf)).size > 1) return true;
    return runEvents.some(event => event.source_window_start < tipAtRunStart);
}

/**
 * The stored events that new events replace: of the same window, sharing a message with the new
 * extraction, and written before it. An event that records no time counts as written before.
 *
 * @param {object[]} storedEvents - The collection's events, as read from the store
 * @param {object[]} newEvents - Events a run stored, of the windows it extracted
 * @param {Set<string>} runEventIds - event_id of every event the run stored
 * @returns {object[]}
 */
export function findReplacedEvents(storedEvents, newEvents, runEventIds) {
    const newCallBySpan = new Map();
    for (const event of newEvents) {
        const span = windowSpanOf(event);
        const time = extractionTimeOf(event);
        if (time === null || newCallBySpan.has(span)) continue;
        newCallBySpan.set(span, { time, messageHashes: new Set((event.source_message_hashes ?? []).map(String)) });
    }
    return storedEvents.filter((event) => {
        const newCall = newCallBySpan.get(windowSpanOf(event));
        if (!newCall || runEventIds.has(event.event_id)) return false;
        const sharesMessage = (event.source_message_hashes ?? []).some(hash => newCall.messageHashes.has(String(hash)));
        const time = extractionTimeOf(event);
        return sharesMessage && (time === null || time < newCall.time);
    });
}

/**
 * Which new event takes the links of each replaced one: the first new event of its window.
 *
 * @param {object[]} replacedEvents
 * @param {object[]} newEvents
 * @returns {Map<string, string>} replaced event_id → new event_id
 */
export function replacementIdsOf(replacedEvents, newEvents) {
    const firstNewBySpan = new Map();
    for (const event of newEvents) {
        const span = windowSpanOf(event);
        const first = firstNewBySpan.get(span);
        if (!first || (event.window_event_order ?? 0) < (first.window_event_order ?? 0)) firstNewBySpan.set(span, event);
    }
    return new Map(replacedEvents
        .filter(event => firstNewBySpan.has(windowSpanOf(event)))
        .map(event => [event.event_id, firstNewBySpan.get(windowSpanOf(event)).event_id]));
}

/**
 * The events whose StoryArc links change when the links to replaced events move to their
 * replacements. Two links that end up the same, as links to two earlier versions of one window
 * do, become one.
 *
 * @param {object[]} storedEvents - The collection's events, with their story_links
 * @param {Map<string, string>} replacementById - From replacementIdsOf
 * @returns {{event: object, links: object[]}[]} each event whose links change, with its new links
 */
export function linksMovedToReplacements(storedEvents, replacementById) {
    const writes = [];
    for (const event of storedEvents) {
        const links = Array.isArray(event.story_links) ? event.story_links : [];
        if (replacementById.has(event.event_id) || !links.some(link => replacementById.has(link?.event_id))) continue;
        const movedKeys = new Set();
        const newLinks = [];
        for (const link of links) {
            const target = replacementById.get(link?.event_id);
            if (target === undefined) {
                newLinks.push(link);
                continue;
            }
            const key = `${target}|${link.type}`;
            if (movedKeys.has(key)) continue;
            movedKeys.add(key);
            newLinks.push({ ...link, event_id: target });
        }
        writes.push({ event, links: newLinks });
    }
    return writes;
}

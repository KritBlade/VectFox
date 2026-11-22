/**
 * LoreBase's files (§3.3 of InternalProject/Vectfox/plans/executed/vectfox-multi-collection-per-chat.md), with no host imports:
 * a book's keys file and a book tenant's vectors file, each opening with the header every VectFox file has, and what
 * a file would write to a book before anything is written: the keys of the entries whose number and title both match,
 * selected or not, and the vectors of the parts of the entries LoreBase would decide now, selected or not. The Database
 * Browser's words for an export, an import and a delete are here too, and Remove from LoreBase's confirm and outcome,
 * which the Database Browser and the WorldInfo page both show.
 */
import { counted } from '../../shared/counted.js';
import { KEYS, VECTORS } from './lorebase-storage-core.js';
import { entryTitle } from './lorebase-splitter.js';
import { embeddingModelKey, pointHash } from './lorebase-vectors-core.js';

/** Tells a LoreBase keys file from any other JSON a person might pick. */
export const LOREBASE_KEYS_FILE_TYPE = 'vectfox-lorebase-keys';
/** Tells a LoreBase vectors file from any other JSON a person might pick. */
export const LOREBASE_VECTORS_FILE_TYPE = 'vectfox-lorebase-vectors';

// What Similharity stores for one entry's keys (its lorebase-keys.js); a file's entry past these is damaged.
const MOST_KEYS_PER_ENTRY = 200;
const LONGEST_KEY = 300;
const LONGEST_TITLE = 2000;

const NOT_A_FILE = Object.freeze({
    [KEYS]: "This is not a LoreBase keys file. Export on a lorebook's keys row in the Database Browser makes one.",
    [VECTORS]: "This is not a LoreBase vectors file. Export on a lorebook's vectors row in the Database Browser makes one.",
});

/**
 * An embedding model in words, as a row, a delete and an import name the one that made a book's vectors.
 * @param {string|null|undefined} source
 * @param {string|null|undefined} model
 * @returns {string}
 */
export const modelWords = (source, model) => `${source || 'unknown'}/${model || 'default'}`;

const isKeyList = keys => Array.isArray(keys) && keys.length <= MOST_KEYS_PER_ENTRY
    && keys.every(key => typeof key === 'string' && key.trim() !== '' && key.length <= LONGEST_KEY);

const isStorableKeysEntry = entry => Boolean(entry) && typeof entry === 'object' && String(entry.uid ?? '') !== ''
    && typeof entry.title === 'string' && entry.title.length <= LONGEST_TITLE && isKeyList(entry.keys);

const isStorablePoint = (point, dimension) => Boolean(point) && typeof point === 'object' && String(point.uid ?? '') !== ''
    && typeof point.text === 'string' && Array.isArray(point.vector) && point.vector.length > 0
    && (!dimension || point.vector.length === dimension) && point.vector.every(Number.isFinite);

/**
 * A book's keys as a file: each entry with keys, by its uid, title and keys. The title is the one SillyTavern's book
 * gives the entry now or, when SillyTavern no longer has the book or the entry, the one stored with its keys (D11); an
 * entry with neither is left out and counted, as keys written before titles were stored have none.
 * @param {{book: string, header: object, keys: Record<string, string[]>, titles: Record<string, string>, entries: object[]}} parts
 *   keys and titles: by uid, as Similharity holds them; entries: the book's entries as SillyTavern loads it now, none
 *   when it has no such book
 * @returns {{file: object, count: number, leftOutCount: number}}
 */
export function keysFileOf({ book, header, keys, titles, entries }) {
    const titlesNow = new Map(entries.map(entry => [String(entry.uid), entryTitle(entry)]));
    const fileEntries = [];
    for (const [uid, entryKeys] of Object.entries(keys)) {
        const title = titlesNow.get(uid) ?? titles[uid];
        if (typeof title === 'string') fileEntries.push({ uid, title, keys: entryKeys });
    }
    return {
        file: { ...header, type: LOREBASE_KEYS_FILE_TYPE, book: { name: book }, entries: fileEntries },
        count: fileEntries.length,
        leftOutCount: Object.keys(keys).length - fileEntries.length,
    };
}

/**
 * What a keys file would write to a book, without writing it: the keys of each of its entries whose uid and title both
 * match an entry of SillyTavern's book now, selected or not, as keys are kept for an unselected entry; how many of those
 * replace keys the entry has; and how many of the file's entries match no entry here, or are damaged or listed twice.
 * @param {unknown} file - Parsed JSON
 * @param {{entries: object[], storedKeys: Record<string, string[]>}} book - The book's entries as SillyTavern loads it
 *   now, and the keys Similharity holds for them by uid
 * @returns {{writes: Array<{uid: string, title: string, keys: string[]}>, replaceCount: number, unmatchedCount: number,
 *   damagedCount: number}}
 * @throws {Error} When it is not a LoreBase keys file
 */
export function planKeysImport(file, { entries, storedKeys }) {
    if (file?.type !== LOREBASE_KEYS_FILE_TYPE || !Array.isArray(file.entries)) throw new Error(NOT_A_FILE[KEYS]);
    const titlesNow = new Map(entries.map(entry => [String(entry.uid), entryTitle(entry)]));
    const writes = [];
    const written = new Set();
    let unmatchedCount = 0;
    let damagedCount = 0;
    for (const fileEntry of file.entries) {
        const uid = String(fileEntry?.uid ?? '');
        if (!isStorableKeysEntry(fileEntry) || written.has(uid)) {
            damagedCount += 1;
        } else if (titlesNow.get(uid) !== fileEntry.title) {
            unmatchedCount += 1;
        } else {
            written.add(uid);
            writes.push({ uid, title: fileEntry.title, keys: fileEntry.keys });
        }
    }
    return { writes, replaceCount: writes.filter(write => storedKeys[write.uid]).length, unmatchedCount, damagedCount };
}

/**
 * A book tenant's vectors as a file: the points of the embedding model most of them were made by, each with its hash,
 * entry, part, text and dense vector, under that model's source, name and vector size. Points of another model, or
 * with no vector, are left out and counted.
 * @param {{book: string|null, header: object, points: Array<{hash: number, text: string, vector: number[]|null, metadata: object}>}} parts
 *   points: the tenant's points as Similharity lists them (readTenantPoints)
 * @returns {{file: object, count: number, leftOutCount: number}}
 */
export function vectorsFileOf({ book, header, points }) {
    const byModel = new Map();
    for (const point of points) {
        if (!Array.isArray(point.vector) || !point.vector.length) continue;
        const modelKey = embeddingModelKey(point.metadata?.embeddingSource, point.metadata?.embeddingModel);
        if (!byModel.has(modelKey)) byModel.set(modelKey, []);
        byModel.get(modelKey).push(point);
    }
    const kept = [...byModel.values()].reduce((most, group) => (group.length > most.length ? group : most), []);
    const sample = kept[0];
    return {
        file: {
            ...header,
            type: LOREBASE_VECTORS_FILE_TYPE,
            book: { name: book },
            embedding: { source: sample?.metadata?.embeddingSource ?? '', model: sample?.metadata?.embeddingModel ?? '', dimension: sample?.vector.length ?? 0 },
            points: kept.map(point => ({
                hash: Number(point.hash),
                uid: String(point.metadata?.entryUid ?? ''),
                partNumber: Number(point.metadata?.partNumber ?? 0),
                text: point.text,
                vector: point.vector,
            })),
        },
        count: kept.length,
        leftOutCount: points.length - kept.length,
    };
}

/**
 * What a vectors file would write to a book, without writing it: each of its points whose hash, made again from its uid
 * and text, is a part of an entry LoreBase would decide in the book now, selected or not; how many of those replace a
 * part the book has; how many belong to an entry not selected, which the book's next vectors write erases; and how many
 * of the file's points are no such part, or are damaged or listed twice. When the file's embedding model is not the one
 * set now its vectors cannot go in, and the selected entries' matched parts are embedded again, as Generate vectors
 * embeds them; an unselected entry's are skipped, as that write would erase them, and counted.
 * @param {unknown} file - Parsed JSON
 * @param {{candidates: Array<{uid: string, points: Array<{hash: number, uid: string}>}>, selectedUids: Set<string>,
 *   stored: Map<number, object>, modelKey: string}} book - candidates: the entries LoreBase would decide, selected or
 *   not, with their points (entriesWithPoints); selectedUids: the book's selected entries; stored: what Qdrant holds for
 *   the book, by hash; modelKey: the embedding model set now (embeddingModelKey)
 * @returns {{writes: Array<{point: object, vector: number[]}>, uids: string[], replaceCount: number, unselectedCount: number,
 *   unmatchedCount: number, damagedCount: number, embedding: {source: string, model: string, dimension: number},
 *   needsEmbedding: boolean}} unselectedCount: the parts of entries not selected, written, or skipped when embedding
 * @throws {Error} When it is not a LoreBase vectors file
 */
export function planVectorsImport(file, { candidates, selectedUids, stored, modelKey }) {
    if (file?.type !== LOREBASE_VECTORS_FILE_TYPE || !Array.isArray(file.points)) throw new Error(NOT_A_FILE[VECTORS]);
    const embedding = {
        source: String(file.embedding?.source ?? ''),
        model: String(file.embedding?.model ?? ''),
        dimension: Number(file.embedding?.dimension) || 0,
    };
    const parts = new Map(candidates.flatMap(entry => entry.points.map(point => [point.hash, point])));
    const matched = [];
    const written = new Set();
    let unmatchedCount = 0;
    let damagedCount = 0;
    for (const filePoint of file.points) {
        if (!isStorablePoint(filePoint, embedding.dimension)) {
            damagedCount += 1;
            continue;
        }
        const part = parts.get(pointHash(String(filePoint.uid), filePoint.text));
        if (!part) {
            unmatchedCount += 1;
        } else if (written.has(part.hash)) {
            damagedCount += 1;
        } else {
            written.add(part.hash);
            matched.push({ point: part, vector: filePoint.vector });
        }
    }
    const needsEmbedding = embeddingModelKey(embedding.source, embedding.model) !== modelKey;
    const isSelected = write => selectedUids.has(String(write.point.uid));
    const writes = needsEmbedding ? matched.filter(isSelected) : matched;
    return {
        writes,
        uids: [...new Set(writes.map(write => write.point.uid))],
        replaceCount: writes.filter(write => stored.has(write.point.hash)).length,
        unselectedCount: matched.filter(write => !isSelected(write)).length,
        unmatchedCount,
        damagedCount,
        embedding,
        needsEmbedding,
    };
}

/**
 * What an export put in its file, in a line: how many entries' keys or parts' vectors, and how many were left out, and
 * why.
 * @param {string} kind - KEYS or VECTORS
 * @param {{count: number, leftOutCount: number}} exported - From keysFileOf or vectorsFileOf
 * @returns {string}
 */
export function describeExport(kind, { count, leftOutCount }) {
    if (kind === KEYS) {
        const leftOut = leftOutCount
            ? `; ${counted(leftOutCount, 'entry was', 'entries were')} left out, as neither SillyTavern nor the stored keys name ${leftOutCount === 1 ? 'its' : 'their'} title`
            : '';
        return `Exported the keys of ${counted(count, 'entry', 'entries')}${leftOut}`;
    }
    const leftOut = leftOutCount
        ? `; ${counted(leftOutCount, 'part was', 'parts were')} left out, made by another embedding model or holding no vector`
        : '';
    return `Exported the vectors of ${counted(count, 'part')}${leftOut}`;
}

function skippedSentence({ unmatchedCount, damagedCount }, one, many, unmatchedWhy, otherReasons = []) {
    const why = typeof unmatchedWhy === 'function' ? unmatchedWhy(unmatchedCount) : unmatchedWhy;
    const skipped = [
        ...otherReasons,
        unmatchedCount ? `${counted(unmatchedCount, one, many)} ${why}` : '',
        damagedCount ? `${counted(damagedCount, one, many)} the file holds damaged or twice` : '',
    ].filter(Boolean);
    return skipped.length ? `It skips ${skipped.join(', and ')}.` : '';
}

/** What becomes of the parts of entries not selected that a vectors import writes, in a sentence. */
function unselectedPartsSentence(count) {
    return count === 1
        ? "1 of them belongs to an entry not selected, so the next write of this lorebook's vectors erases it unless you select that entry first."
        : `${count} of them belong to entries not selected, so the next write of this lorebook's vectors erases them unless you select those entries first.`;
}

/**
 * What an import would write, in sentences for its confirm: how much, how much of it replaces what the book has, what it
 * skips, and for vectors what becomes of the parts of entries not selected, and whether the file's vectors go in or the
 * parts are embedded again with the model set now.
 * @param {string} kind - KEYS or VECTORS
 * @param {object} plan - From planKeysImport or planVectorsImport
 * @param {{source: string, model: string}} [current] - The embedding model set now, for vectors
 * @returns {string[]}
 */
export function describeImport(kind, plan, current = { source: '', model: '' }) {
    const { writes, replaceCount } = plan;
    if (kind === KEYS) {
        const replacing = replaceCount ? `, ${replaceCount} of them replacing the keys ${replaceCount === 1 ? 'that entry has' : 'those entries have'}` : '';
        return [
            `It writes the keys of ${counted(writes.length, 'entry', 'entries')}${replacing}.`,
            skippedSentence(plan, 'entry', 'entries', 'whose number and title match no entry of this lorebook'),
        ].filter(Boolean);
    }
    const replacing = replaceCount ? `, ${replaceCount} of them replacing ${replaceCount === 1 ? 'a part' : 'parts'} this lorebook has` : '';
    const fileModel = modelWords(plan.embedding.source, plan.embedding.model);
    const unselectedSkipped = plan.needsEmbedding && plan.unselectedCount
        ? `${counted(plan.unselectedCount, 'part')} of entries not selected, as only a selected entry's parts are embedded again`
        : '';
    return [
        `It writes the vectors of ${counted(writes.length, 'part')} of ${counted(plan.uids.length, 'entry', 'entries')}${replacing}.`,
        !plan.needsEmbedding && plan.unselectedCount ? unselectedPartsSentence(plan.unselectedCount) : '',
        skippedSentence(plan, 'part', 'parts', count => `that ${count === 1 ? 'is' : 'are'} no part of an entry here now`, [unselectedSkipped]),
        plan.needsEmbedding
            ? `The file's vectors were made by ${fileModel} and yours by ${modelWords(current.source, current.model)}, so the parts are embedded`
                + ` again with yours, as Generate vectors embeds them. To use the saved vectors, switch to ${fileModel} first.`
            : `The file's vectors were made by ${fileModel}, the model set now, so they go in as they are, with no embedding call.`,
    ].filter(Boolean);
}

/**
 * What an import wrote, in a line for its toast.
 * @param {string} kind - KEYS or VECTORS
 * @param {{written: number, failed: number, isEmbedded: boolean}} outcome - From writeImport
 * @param {string} bookName
 * @returns {string}
 */
export function describeImported(kind, { written, failed, isEmbedded }, bookName) {
    let what = `the vectors of ${counted(written, 'part')}`;
    if (kind === KEYS) what = `the keys of ${counted(written, 'entry', 'entries')}`;
    else if (isEmbedded) what = `the vectors of ${counted(written, 'entry', 'entries')}, embedded again with your model,`;
    const notWritten = failed ? `; ${counted(failed, 'entry was', 'entries were')} not written, as the other toast says` : '';
    return `Imported ${what} into ${bookName}${notWritten}`;
}

/**
 * Why an import wrote nothing, in a line: nothing in the file matched this lorebook, or, for a vectors file of another
 * embedding model, only entries not selected did, whose parts are not embedded again.
 * @param {string} kind - KEYS or VECTORS
 * @param {object} plan - From planKeysImport or planVectorsImport
 * @param {string} bookName
 * @returns {string}
 */
export function nothingToImportText(kind, plan, bookName) {
    const skippedUnselected = plan.needsEmbedding ? plan.unselectedCount : 0;
    const total = plan.writes.length + plan.unmatchedCount + plan.damagedCount + skippedUnselected;
    if (kind === KEYS) return `None of this file's ${counted(total, 'entry', 'entries')} matches an entry of ${bookName} by number and title, so nothing was written.`;
    if (skippedUnselected) {
        return `This file's vectors were made by another embedding model, and the parts of ${bookName} it matches belong to entries`
            + ' not selected, so nothing was embedded again. Select those entries first, or switch to the model the file names.';
    }
    return `None of this file's ${counted(total, 'part')} is a part of an entry of ${bookName} now, so nothing was written.`;
}

const NOTHING_IN_REPLIES = 'No entry of this lorebook takes part in replies now, so replies lose nothing. Export them first to keep a copy.';

/**
 * What deleting a row loses, and what follows, for its confirm. Entries send nothing afterwards only when the row's book
 * is listed with selected entries LoreBase decides (selectedCount, decidedCountOf), and only where a selection of them
 * is in use; a leftover's book and a book that decides none have no entry in replies.
 * @param {{kind: string, entryCount?: number, pointCount?: number, isHere?: boolean, embeddingSource?: string,
 *   embeddingModel?: string, selectedCount: number, isLeftover: boolean}} row - From storageRowsOf
 * @returns {{lost: string, after: string}}
 */
export function describeDelete(row) {
    const isInReplies = !row.isLeftover && row.selectedCount > 0;
    if (row.kind === KEYS) {
        return {
            lost: `the keys of ${counted(row.entryCount, 'entry', 'entries')}, those edited by hand included`,
            after: isInReplies
                ? "Its selected entries send nothing where they are in use until Generate keys writes their keys again, at the cost of LoreBase's model. LoreBase stays on. Export them first to keep a copy."
                : NOTHING_IN_REPLIES,
        };
    }
    const lost = `the vectors of ${counted(row.pointCount, 'part')}, made by ${modelWords(row.embeddingSource, row.embeddingModel)}`;
    if (!row.isHere) return { lost, after: 'LoreBase reads its vectors from another collection now, so it does not read these. Export them first to keep a copy.' };
    return {
        lost,
        after: isInReplies
            ? 'Its selected entries send nothing where they are in use until Generate vectors writes their vectors again. LoreBase stays on. Export them first to keep a copy.'
            : NOTHING_IN_REPLIES,
    };
}

const listWords = new Intl.ListFormat('en', { type: 'conjunction' });

// The places SillyTavern loads a book from for the open chat, in words, by their names in lorebase-chat-books.js.
const CHAT_BOOK_PLACE_WORDS = Object.freeze({
    globalList: 'the global list every chat loads',
    characterBooks: "this character's Additional Lorebooks",
    characterOwnBook: "the character's own lorebook",
    chatBook: "this chat's Chat Lorebook",
    personaBook: "your persona's lorebook",
});
const placesInWords = places => listWords.format(places.map(place => CHAT_BOOK_PLACE_WORDS[place]));
const stillLoadedSentence = places => `This chat still loads it through ${placesInWords(places)}: take it out there in SillyTavern.`;

/**
 * The confirm of Remove from LoreBase, the same on the Database Browser's lorebook row and the WorldInfo page's book
 * row, and of the WorldInfo page's Unlink. Its question in red: Remove's as it deletes the whole book, Unlink's saying
 * that unlinking deletes the whole book too. With more than one selection, Remove's green line naming Choose entries,
 * which deletes one. Then the book, with Unlink the open chat's lists it is unlinked from, each part of it that goes
 * (its selections, when it has more than one, the entries they select and their pinned sections, their locks, its keys
 * and its vectors in every collection holding them), and what stays, with Unlink the places that still load it there.
 * @param {{bookName: string, selectionCount: number, selectedCount: number, pinnedCount: number, chatLockCount: number,
 *   characterLockCount: number, keyCount: number, tenants: Array<{pointCount: number}>}} holdings - From loreBookHoldings
 *   in lorebase-storage.js
 * @param {{unlinkedFrom: string[], stillLoadedBy: string[]}|null} [links] - chatBookLinks in lorebase-chat-books.js,
 *   for Unlink; null for Remove
 * @returns {object[]} confirmPopup's lines
 */
export function removalConfirmLines({ bookName, selectionCount, selectedCount, pinnedCount, chatLockCount, characterLockCount, keyCount, tenants }, links = null) {
    const partCount = tenants.reduce((sum, tenant) => sum + tenant.pointCount, 0);
    const listOrNone = parts => (parts.length ? listWords.format(parts) : 'none');
    const countedIfAny = (count, singular, plural) => (count ? counted(count, singular, plural) : '');
    const isSeveral = selectionCount > 1;
    const isUnlink = links !== null;
    const selection = [
        isSeveral ? counted(selectionCount, 'selection') : '', countedIfAny(selectedCount, 'selected entry', 'selected entries'),
        countedIfAny(pinnedCount, 'pinned section'),
    ].filter(Boolean);
    const locks = [countedIfAny(chatLockCount, 'chat'), countedIfAny(characterLockCount, 'character')].filter(Boolean);
    const collections = tenants.length > 1 ? ` in ${counted(tenants.length, 'collection')}` : '';
    const keepCopy = keyCount || partCount ? ' Export its keys and vectors in the Database Browser first to keep a copy.' : '';
    return [
        isUnlink
            ? { text: 'Unlink this lorebook? Unlinking also deletes ALL of it from LoreBase: its vectors, keys, selections and locks.', status: 'danger' }
            : { text: 'Remove ALL of this lorebook from LoreBase?', status: 'danger' },
        isSeveral && !isUnlink ? { text: 'To delete one selection only, use Choose entries on the WorldInfo page.', status: 'success' } : null,
        { text: 'Lorebook:', name: bookName },
        isUnlink ? { text: 'Unlinked from:', name: listOrNone(links.unlinkedFrom.map(place => CHAT_BOOK_PLACE_WORDS[place])) } : null,
        { text: isSeveral ? 'Selections:' : 'Selection:', name: listOrNone(selection) },
        { text: 'Locked to:', name: listOrNone(locks) },
        { text: 'Keys:', name: keyCount ? `the keys of ${counted(keyCount, 'entry', 'entries')}, those edited by hand included` : 'none' },
        { text: 'Vectors:', name: partCount ? `${counted(partCount, 'part')}${collections}` : 'none' },
        { text: `The lorebook stays in SillyTavern${isUnlink ? '' : ', where every entry fires by its keys, as SillyTavern does'}.${keepCopy}` },
        links?.stillLoadedBy.length ? { text: stillLoadedSentence(links.stillLoadedBy) } : null,
        { text: `${isUnlink ? 'Unlink' : 'Remove'} deletes all of it. Cancel keeps it.` },
    ].filter(Boolean);
}

/**
 * What Remove from LoreBase or Unlink did, each count with its unit: with Unlink, the open chat's lists the book was
 * unlinked from first, and the places that still load it there.
 * @param {{bookName: string, keysDeleted: number, partsDeleted: number, unlinkedFrom?: string[], stillLoadedBy?: string[]}} removed -
 *   From removeLoreBookAfterConfirm in lorebase-removal.js
 * @returns {string}
 */
export function describeRemovedLoreBook({ bookName, keysDeleted, partsDeleted, unlinkedFrom = [], stillLoadedBy = [] }) {
    const stored = [
        keysDeleted ? `the keys of ${counted(keysDeleted, 'entry', 'entries')}` : '',
        partsDeleted ? `the vectors of ${counted(partsDeleted, 'part')}` : '',
    ].filter(Boolean);
    const withStored = stored.length ? `, with ${listWords.format(stored)}` : '';
    const done = unlinkedFrom.length
        ? `Unlinked "${bookName}" from ${placesInWords(unlinkedFrom)}, and removed it from LoreBase${withStored}`
        : `Removed "${bookName}" from LoreBase${withStored}`;
    return `${done}.${stillLoadedBy.length ? ` ${stillLoadedSentence(stillLoadedBy)}` : ''}`;
}

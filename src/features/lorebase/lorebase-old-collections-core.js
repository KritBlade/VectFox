/**
 * The old vectorized lorebook collections LoreBase replaced (D5 and §6.4 of InternalProject/Vectfox/plans/
 * executed/lorebook-semantic-overhaul-passage-index.md): which collections they are, the book each was made from, the chats and
 * characters each was locked to, and the notice that says they are deleted. Pure: no SillyTavern, no network.
 */
import { COLLECTION_PREFIXES, parseRegistryKey, sanitizeNameSegment } from '../../shared/collection-ids.js';

// An old lorebook collection's ID kept at most this many characters of its book's name.
const ID_NAME_LENGTH = 50;

/**
 * The book an old lorebook collection was made from. Its ID ends in the book's name, cut and sanitized, then the time
 * it was made (`vf_lorebook_<backend>_<handle>_<name>_<timestamp>`), and no other record of the book was kept. The
 * longest name that fits wins, so "Harbor Atlas" is not mistaken for "Atlas". Null when no book SillyTavern has fits:
 * the book was deleted or renamed.
 * @param {string} collectionId
 * @param {Iterable<string>} bookNames - SillyTavern's lorebooks
 * @returns {string|null}
 */
export function bookOfOldCollection(collectionId, bookNames) {
    const timestamp = /_(\d+)$/.exec(collectionId)?.[1];
    if (!timestamp) return null;
    let match = null;
    let matchLength = 0;
    for (const bookName of bookNames) {
        const segment = sanitizeNameSegment(bookName, ID_NAME_LENGTH);
        if (segment && segment.length > matchLength && collectionId.endsWith(`_${segment}_${timestamp}`)) {
            match = bookName;
            matchLength = segment.length;
        }
    }
    return match;
}

/**
 * The old lorebook collections in the collection registry, each with its book and its locks. A collection's character
 * locks name characters by their place in SillyTavern's list, as the collection lock always did; a book names them by
 * avatar file name, so each place is read in today's list, and a place no character holds is dropped.
 * @param {string[]} registryKeys - The collection registry, "backend:id" or a bare ID
 * @param {object} host
 * @param {Iterable<string>} host.bookNames - SillyTavern's lorebooks
 * @param {(key: string) => string[]} host.chatLocksOf - A collection's chat locks, by its registry key or bare ID
 * @param {(key: string) => Array<string|number>} host.characterLocksOf - Its character locks, the same way
 * @param {(characterId: string) => string|null} host.avatarOf - The avatar file name of the character at that place
 * @returns {Array<{registryKey: string, collectionId: string, backend: string|null, bookName: string|null,
 *   chatIds: string[], characterAvatars: string[]}>}
 */
export function oldLorebookCollections(registryKeys, { bookNames, chatLocksOf, characterLocksOf, avatarOf }) {
    const books = [...bookNames];
    return registryKeys.flatMap(registryKey => {
        const { backend, collectionId } = parseRegistryKey(registryKey);
        if (!collectionId.startsWith(COLLECTION_PREFIXES.VECTFOX_LOREBOOK)) return [];
        // Locks were written under the registry key, and under the bare ID by older versions.
        const keys = [...new Set([registryKey, collectionId])];
        const chatIds = [...new Set(keys.flatMap(chatLocksOf).map(String))];
        const characterAvatars = [...new Set(keys.flatMap(characterLocksOf).map(id => avatarOf(String(id))).filter(Boolean))];
        return [{ registryKey, collectionId, backend, bookName: bookOfOldCollection(collectionId, books), chatIds, characterAvatars }];
    });
}

/**
 * The notice once old collections are deleted: that their vectors are not needed, as LoreBase writes its own, the books
 * they came from, each once, which keep working as plain lorebooks, the steps to have LoreBase decide a book's
 * entries, ending with the keys and vectors whose writing locks the book to the chat (§6.1 of lorebook-multi-vector.md),
 * whether locks moved to the books, how many came from no book SillyTavern still has, and how many others could not be
 * deleted. Shown only when at least one was deleted.
 * @param {{deleted: Array<{bookName: string|null, chatIds: string[], characterAvatars: string[]}>, failedCount: number}} outcome
 * @returns {object[]} The dialog's lines (sillytavern/popup-core.js)
 */
export function oldCollectionsNoticeLines({ deleted, failedCount }) {
    const books = [...new Set(deleted.map(collection => collection.bookName).filter(Boolean))].sort((first, second) => first.localeCompare(second));
    const bookless = deleted.filter(collection => !collection.bookName).length;
    const hasMovedLocks = deleted.some(collection => collection.bookName && (collection.chatIds.length || collection.characterAvatars.length));
    const lines = [
        { icon: 'fa-circle-info', text: 'LoreBase replaced vectorized lorebooks, so VectFox deleted their old collections.' },
        { text: 'Their old vectors are not needed: LoreBase writes its own keys and vectors for the entries you choose.' },
    ];
    if (books.length) {
        lines.push({ text: 'These books keep working as plain SillyTavern lorebooks:' });
        lines.push(...books.map(bookName => ({ icon: 'fa-book', name: bookName })));
        lines.push(
            { text: "To have LoreBase decide a book's entries instead:" },
            { text: '1. Open a chat that uses the book. On the WorldInfo page, turn on Use LoreBase and set up the LoreBase model card: its notice names anything still missing.' },
            { text: '2. Press Choose entries in the LoreBase books card, and pick the book at the top.' },
            { text: '3. Turn on the entries LoreBase should decide. Every entry starts off.' },
            { text: "4. Close the screen and press Write keys and vectors. The book then locks to this chat, as LoreBase uses a book only where it is locked. Lock to this character, on the same screen, uses it in all of the character's chats." },
        );
    }
    if (hasMovedLocks) {
        lines.push({ text: 'A book whose old collections were locked to chats or characters is already locked to the same ones.' });
    }
    if (bookless) {
        lines.push({ parts: [{ name: bookless }, { text: ' of them came from books SillyTavern no longer has under that name.' }] });
    }
    if (failedCount) {
        lines.push({
            icon: 'fa-triangle-exclamation',
            parts: [{ text: 'VectFox could not delete ' }, { name: failedCount }, { text: ' other old lorebook collections. It tries again at the next start.' }],
        });
    }
    return lines;
}

// A lorebook's LoreBase record as lorebase-books.js keeps it, for the tests that put records in VectFox's settings:
// one selection holding what the test gives, and the entries the selection screen last saw when given.
export function oneSelectionRecord({
    selectedUids = [], pinnedSections = [], lockedToChatIds = [], lockedToCharacterAvatars = [], seenEntries, id = 'first', name = 'First',
} = {}) {
    const record = { selections: [{ id, name, selectedUids, pinnedSections, lockedToChatIds, lockedToCharacterAvatars }] };
    if (seenEntries) record.seenEntries = seenEntries;
    return record;
}

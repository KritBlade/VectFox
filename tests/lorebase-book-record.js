// A lorebook's LoreBase record as lorebase-books.js keeps it, for the tests that put records in VectFox's settings:
// one selection holding what the test gives, its uids kept as runs as the record keeps them, and the entries the
// selection screen last saw when given.
import { uidRunsOf } from '../src/features/lorebase/lorebase-uid-runs-core.js';

export function oneSelectionRecord({
    selectedUids = [], pinnedSections = [], lockedToChatIds = [], lockedToCharacterAvatars = [], seenEntries, id = 'first', name = 'First',
} = {}) {
    const record = { selections: [{ id, name, selectedEntries: uidRunsOf(selectedUids), pinnedSections, lockedToChatIds, lockedToCharacterAvatars }] };
    if (seenEntries) record.seenEntries = seenEntries;
    return record;
}

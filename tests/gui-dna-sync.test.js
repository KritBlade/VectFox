/**
 * Tests that src/shared/gui-dna/ is what tools/sync-gui-dna.mjs writes from mvu-helper. A change to the DNA is made in
 * mvu-helper and synced here, so a copy edited by hand fails. Needs mvu-helper beside this repo, as the sync does.
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { SYNCED_FILES, syncedCopyText } from '../tools/sync-gui-dna.mjs';

describe('gui-dna copies', () => {
    for (const file of SYNCED_FILES) {
        it(`${file.name} is what the sync writes`, () => {
            const copy = readFileSync(file.copy, 'utf8').replace(/\r\n/g, '\n');
            expect(copy).toBe(syncedCopyText(file, readFileSync(file.source, 'utf8')));
        });

        it(`${file.name} holds no mvu-helper class`, () => {
            const copy = readFileSync(file.copy, 'utf8').replace(/\r\n/g, '\n');
            const belowHeader = copy.slice(copy.indexOf('\n\n'));
            expect(belowHeader).not.toContain('mvuh-');
        });
    }
});

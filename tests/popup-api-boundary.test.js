/**
 * Guard G9 (GUI-DNA, connection plan §8): one door to SillyTavern's dialogs.
 *
 * Only src/sillytavern/ touches SillyTavern's popup API (`Popup`, `callGenericPopup`, `POPUP_TYPE`, `POPUP_RESULT`).
 * Everything else opens a dialog through sillytavern/popup.js, so how every dialog behaves, looks and fails can be
 * changed in that one file. The uses left are in surfaces whose phase has not run yet; each phase moves its own, and
 * its file's count drops in the same change. A new use fails. Every dialog the door opens scrolls once it is taller
 * than the window.
 *
 * Code only: a mention in a comment or a string is not a use.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOnly, countsByFile, jsFilesUnder, relativePath } from './code-scan.mjs';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const HOST_FOLDER = 'sillytavern/';

// The uses left, by file, until their phase moves them behind sillytavern/popup.js.
const USES_LEFT = {
    'features/chunkbase/content-vectorizer.js': 12,
    'features/database-browser/database-browser.js': 12,
    'features/settings-panel/settings-panel.js': 18,
    'features/vector-backend/tokenizer-lock.js': 4,
    'features/world-info/lorebook-rename-detector.js': 4,
};

// `new Popup(`, `callGenericPopup(`, `POPUP_TYPE`, `POPUP_RESULT` — but not popup.js's own doors, whose names merely
// end in "Popup" (confirmPopup(…) has no word boundary before "Popup").
const POPUP_API_USE = /\bPopup\s*\(|\bcallGenericPopup\b|\bPOPUP_TYPE\b|\bPOPUP_RESULT\b/g;

function popupApiUses(code) {
    return [...code.matchAll(POPUP_API_USE)].map((match) => match[0].replace(/\s*\($/, ''));
}

describe('SillyTavern popup API boundary (G9)', () => {
    it('no file outside src/sillytavern/ uses the popup API beyond the uses left', () => {
        const offenders = [];
        for (const file of jsFilesUnder(SRC)) {
            const relative = relativePath(SRC, file);
            if (relative.startsWith(HOST_FOLDER)) continue;
            codeOnly(readFileSync(file, 'utf8')).split('\n').forEach((line, index) => {
                for (const use of popupApiUses(line)) offenders.push(`${relative}:${index + 1} ${use}`);
            });
        }
        expect(countsByFile(offenders)).toEqual(USES_LEFT);
    });

    it('sees the API in code, and ignores the doors, comments and strings', () => {
        const scanned = codeOnly("new Popup(el, POPUP_TYPE.CONFIRM); await confirmPopup('x'); openPanelPopup(p);\n"
            + "// callGenericPopup(1)\nconst s = 'POPUP_RESULT'; callGenericPopup(q);\n");
        expect(popupApiUses(scanned)).toEqual(['Popup', 'POPUP_TYPE', 'callGenericPopup']);
    });
});

describe('every dialog scrolls', () => {
    // SillyTavern's popup clips its content unless the dialog allows vertical scrolling, so a field below the cut cannot
    // be reached.
    it('showDialog opens every dialog with allowVerticalScrolling', () => {
        const code = codeOnly(readFileSync(path.join(SRC, 'sillytavern', 'popup.js'), 'utf8'));
        const options = (code.match(/new Popup\(([^;]*)\);/) || [])[1];
        expect(options).toMatch(/allowVerticalScrolling: true/);
    });
});

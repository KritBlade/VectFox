/**
 * The start of a text on one line (src/shared/text-preview.js), as the Chunk Visualizer names a chunk with no name and
 * the public API's delete question names events.
 */

import { describe, expect, it } from 'vitest';
import { textPreview } from '../src/shared/text-preview.js';

describe('textPreview', () => {
    it('puts a text on one line and cuts it after the length given, with an ellipsis', () => {
        expect(textPreview('  The   tide\ncame  in.  ', 8)).toBe('The tide…');
    });

    it('keeps a text that fits whole, and reads nothing as empty', () => {
        expect(textPreview('The tide came in.', 60)).toBe('The tide came in.');
        expect(textPreview(undefined, 60)).toBe('');
    });
});

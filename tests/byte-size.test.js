/**
 * Unit tests for src/shared/byte-size.js — the byte count every size VectFox shows is measured
 * and written with: B, whole KB, then MB from 1 MB and GB from 1 GB.
 */

import { describe, it, expect } from 'vitest';
import { formatBytes, utf8ByteLength } from '../src/shared/byte-size.js';

describe('formatBytes', () => {
    it('shows bytes below 1 KB and whole KB below 1 MB', () => {
        expect(formatBytes(0)).toBe('0 B');
        expect(formatBytes(1023)).toBe('1023 B');
        expect(formatBytes(1024)).toBe('1 KB');
        expect(formatBytes(266 * 1024 + 300)).toBe('266 KB');
        expect(formatBytes(1024 ** 2 - 1024)).toBe('1023 KB');
    });

    it('shows MB from 1 MB and GB from 1 GB, with one decimal', () => {
        expect(formatBytes(1024 ** 2)).toBe('1 MB');
        expect(formatBytes(1.5 * 1024 ** 2)).toBe('1.5 MB');
        expect(formatBytes(400 * 1024 ** 2)).toBe('400 MB');
        expect(formatBytes(1024 ** 3)).toBe('1 GB');
        expect(formatBytes(2.25 * 1024 ** 3)).toBe('2.3 GB');
    });

    it('moves a count that rounds up to 1024 into the next unit', () => {
        expect(formatBytes(1024 ** 2 - 100)).toBe('1 MB');
        expect(formatBytes(1024 ** 3 - 1000)).toBe('1 GB');
    });
});

describe('utf8ByteLength', () => {
    it('counts UTF-8 bytes, not characters', () => {
        expect(utf8ByteLength('')).toBe(0);
        expect(utf8ByteLength('river')).toBe(5);
        expect(utf8ByteLength('é')).toBe(2);
        expect(utf8ByteLength('山')).toBe(3);
        expect(utf8ByteLength('🦊')).toBe(4);
        expect(utf8ByteLength('{"text":"山河"}')).toBe(17);
    });
});

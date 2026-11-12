/**
 * @vitest-environment jsdom
 *
 * VectFox's key boxes (src/features/settings-panel/api-key-saving.js): a pasted key is saved in each slot its provider
 * uses, and SillyTavern's writeSecret, which answers null rather than throwing when it did not save a key, never
 * leaves a box reading as saved. Every key box under src/features goes through that file.
 */
/* global document -- this file runs under the jsdom environment */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import $ from 'jquery';

const host = vi.hoisted(() => ({
    writeSecret: vi.fn(),
    readSecretState: vi.fn(),
    logWarn: vi.fn(),
}));

vi.mock('../src/sillytavern/secrets.js', () => ({
    writeSecret: host.writeSecret,
    readSecretState: host.readSecretState,
    SECRET_KEYS: { OPENROUTER: 'api_key_openrouter', CUSTOM: 'api_key_custom', VLLM: 'api_key_vllm' },
}));
vi.mock('../src/sillytavern/log.js', () => ({ log: { warn: host.logWarn, lifecycle: () => {}, error: () => {} } }));

const toastr = { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() };
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const MADE_UP_KEY = 'made-up-key-for-a-test';

describe('key boxes', () => {
    let saving;

    beforeEach(async () => {
        vi.resetModules();
        vi.stubGlobal('$', $);
        vi.stubGlobal('toastr', toastr);
        for (const mock of [...Object.values(host), ...Object.values(toastr)]) mock.mockReset();
        host.readSecretState.mockResolvedValue(undefined);
        $(document).off();
        document.body.innerHTML = '<input type="password" id="key_box" placeholder="Paste a key to save it">';
        saving = await import('../src/features/settings-panel/api-key-saving.js');
    });

    it('saves a key in every slot of its box, and says nothing more once SillyTavern saved it', async () => {
        host.writeSecret.mockResolvedValue('saved-id');
        expect(await saving.saveKeyInSillyTavern(MADE_UP_KEY, saving.VLLM_KEY_BOX)).toBe('saved');
        expect(host.writeSecret.mock.calls).toEqual([['api_key_custom', MADE_UP_KEY], ['api_key_vllm', MADE_UP_KEY]]);
        expect(host.readSecretState).toHaveBeenCalledTimes(1);
        expect(toastr.error).not.toHaveBeenCalled();
        expect(toastr.warning).not.toHaveBeenCalled();
    });

    it('says the key was not saved when SillyTavern answers null, without the key', async () => {
        host.writeSecret.mockResolvedValue(null);
        expect(await saving.saveKeyInSillyTavern(MADE_UP_KEY, saving.OPENROUTER_KEY_BOX)).toBe('notSaved');
        expect(toastr.error).toHaveBeenCalledWith('SillyTavern did not save your OpenRouter key. Paste it again to try once more.', 'Key not saved');
        expect(JSON.stringify([toastr.error.mock.calls, host.logWarn.mock.calls])).not.toContain(MADE_UP_KEY);
    });

    it('says which uses got the key when SillyTavern saved it in only some slots', async () => {
        host.writeSecret.mockResolvedValueOnce('saved-id').mockResolvedValueOnce(null);
        expect(await saving.saveKeyInSillyTavern(MADE_UP_KEY, saving.VLLM_KEY_BOX)).toBe('partlySaved');
        expect(toastr.warning).toHaveBeenCalledWith('SillyTavern saved your vLLM key for EventBase and Agent Mode, but not for embedding. Paste it again to save it for both.', 'Key partly saved');
        expect(toastr.error).not.toHaveBeenCalled();
    });

    it('takes a SillyTavern that answers nothing at all as saved, as before', async () => {
        host.writeSecret.mockResolvedValue(undefined);
        expect(await saving.saveKeyInSillyTavern(MADE_UP_KEY, saving.OPENROUTER_KEY_BOX)).toBe('saved');
        expect(toastr.error).not.toHaveBeenCalled();
    });

    it('leaves SillyTavern\'s key list alone for Qdrant\'s slot, which never appears in it', async () => {
        host.writeSecret.mockResolvedValue('saved-id');
        expect(await saving.saveKeyInSillyTavern(MADE_UP_KEY, saving.QDRANT_KEY_BOX)).toBe('saved');
        expect(host.writeSecret).toHaveBeenCalledWith('api_key_qdrant', MADE_UP_KEY);
        expect(host.readSecretState).not.toHaveBeenCalled();
    });

    describe('a wired box', () => {
        let rerender;
        const paste = async (value) => {
            $('#key_box').val(value).trigger('change');
            await settle();
        };

        beforeEach(() => {
            // As the settings panel's display updaters do on the provider's event.
            rerender = vi.fn(() => $('#key_box').attr('placeholder', 'Key saved'));
            $(document).on(saving.VLLM_KEY_BOX.changedEvent, rerender);
            saving.wireKeyBox('#key_box', saving.VLLM_KEY_BOX);
        });

        it('saves the trimmed key, empties itself and re-renders the provider\'s boxes', async () => {
            host.writeSecret.mockResolvedValue('saved-id');
            await paste(`  ${MADE_UP_KEY}  `);
            expect(host.writeSecret).toHaveBeenCalledWith('api_key_custom', MADE_UP_KEY);
            expect($('#key_box').val()).toBe('');
            expect(rerender).toHaveBeenCalledTimes(1);
            expect($('#key_box').attr('placeholder')).toBe('Key saved');
        });

        it('reads "Not saved" when SillyTavern saved nothing, and re-renders nothing', async () => {
            host.writeSecret.mockResolvedValue(null);
            await paste(MADE_UP_KEY);
            expect($('#key_box').val()).toBe('');
            expect(rerender).not.toHaveBeenCalled();
            expect($('#key_box').attr('placeholder')).toBe('Not saved. Paste the key again');
        });

        it('reads "Partly saved" after the re-render, when one slot saved it', async () => {
            host.writeSecret.mockResolvedValueOnce(null).mockResolvedValueOnce('saved-id');
            await paste(MADE_UP_KEY);
            expect(rerender).toHaveBeenCalledTimes(1);
            expect($('#key_box').attr('placeholder')).toBe('Partly saved. Paste the key again');
        });

        it('does nothing for a box left empty', async () => {
            await paste('   ');
            expect(host.writeSecret).not.toHaveBeenCalled();
            expect(rerender).not.toHaveBeenCalled();
        });
    });

    it('every key box under src/features goes through api-key-saving.js, which keeps writeSecret\'s answer', () => {
        // vitest runs from the repository root; under jsdom import.meta.url is not a file URL.
        const repoRoot = process.cwd();
        const jsFilesUnder = folder => readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
            const path = join(folder, entry.name);
            if (entry.isDirectory()) return jsFilesUnder(path);
            return entry.name.endsWith('.js') ? [path] : [];
        });
        const calls = jsFilesUnder(join(repoRoot, 'src/features')).flatMap(path => readFileSync(path, 'utf8').split(/\r?\n/)
            .filter(line => /\bwriteSecret\(/.test(line) && !/^\s*(\/\/|\/?\*)/.test(line))
            .map(line => `${relative(repoRoot, path).replaceAll('\\', '/')}: ${line.trim()}`));
        expect(calls).toEqual(['src/features/settings-panel/api-key-saving.js: const savedId = await writeSecret(slot, value);']);
    });
});

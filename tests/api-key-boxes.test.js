/**
 * @vitest-environment jsdom
 *
 * VectFox's key boxes (src/features/settings-panel/api-key-boxes.js): a pasted key is saved in each slot its provider
 * uses, and a trash button deletes the key the provider uses now. SillyTavern's writeSecret answers null rather than
 * throwing when it did not save a key, and its deleteSecret answers nothing at all, so a box never reads as saved or
 * deleted when it is not. Every key box and trash button under src/features goes through that file.
 */
/* global document -- this file runs under the jsdom environment */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import $ from 'jquery';

const host = vi.hoisted(() => ({
    writeSecret: vi.fn(),
    readSecretState: vi.fn(),
    deleteSecret: vi.fn(),
    confirmPopup: vi.fn(),
    logWarn: vi.fn(),
    // SillyTavern's secret_state as the page holds it, and the list its server holds, which readSecretState copies.
    secretState: {},
    serverState: {},
}));

vi.mock('../src/sillytavern/secrets.js', () => ({
    writeSecret: host.writeSecret,
    readSecretState: host.readSecretState,
    deleteSecret: host.deleteSecret,
    secret_state: host.secretState,
    SECRET_KEYS: { OPENROUTER: 'api_key_openrouter', CUSTOM: 'api_key_custom', VLLM: 'api_key_vllm' },
}));
vi.mock('../src/sillytavern/popup.js', () => ({ confirmPopup: host.confirmPopup }));
vi.mock('../src/sillytavern/log.js', () => ({ log: { warn: host.logWarn, lifecycle: () => {}, error: () => {} } }));

const toastr = { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() };
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const MADE_UP_KEY = 'made-up-key-for-a-test';

/** SillyTavern 1.19.0's list for a slot: each key's ID, masked value and label, the first one in use. */
const listed = (...ids) => ids.map((id, index) => ({ id, value: '*******abc', label: `key ${index + 1}`, active: index === 0 }));

function replaceWith(target, state) {
    for (const key of Object.keys(target)) delete target[key];
    Object.assign(target, JSON.parse(JSON.stringify(state)));
}

/** The page and SillyTavern's server both hold these keys. */
const holdKeys = (state) => {
    replaceWith(host.secretState, state);
    replaceWith(host.serverState, state);
};

/** A delete as SillyTavern 1.19.0's server makes it: by ID, the first key left becomes the one in use. */
async function deleteOnServer(slot, id) {
    const list = host.serverState[slot];
    if (!Array.isArray(list)) {
        host.serverState[slot] = null;
        return;
    }
    const index = list.findIndex(secret => (id ? secret.id === id : secret.active));
    if (index !== -1) list.splice(index, 1);
    if (list.length && !list.some(secret => secret.active)) list[0].active = true;
    if (!list.length) host.serverState[slot] = null;
}

describe('key boxes', () => {
    let boxes;
    let changed;

    beforeEach(async () => {
        vi.resetModules();
        vi.stubGlobal('$', $);
        vi.stubGlobal('toastr', toastr);
        for (const mock of [host.writeSecret, host.readSecretState, host.deleteSecret, host.confirmPopup, host.logWarn, ...Object.values(toastr)]) mock.mockReset();
        host.readSecretState.mockImplementation(async () => replaceWith(host.secretState, host.serverState));
        holdKeys({});
        $(document).off();
        document.body.innerHTML = '<input type="password" id="key_box" placeholder="Paste a key to save it">';
        boxes = await import('../src/features/settings-panel/api-key-boxes.js');
        // As the settings panel's display updaters do on a provider's event.
        changed = vi.fn(() => $('#key_box').attr('placeholder', 'Key saved'));
        $(document).on(`${boxes.VLLM_KEY_BOX.changedEvent} ${boxes.OPENROUTER_KEY_BOX.changedEvent}`, changed);
    });

    describe('saving a pasted key', () => {
        it('saves the key in every slot of its box, and says nothing more once SillyTavern saved it', async () => {
            host.writeSecret.mockResolvedValue('saved-id');
            expect(await boxes.saveKeyInSillyTavern(MADE_UP_KEY, boxes.VLLM_KEY_BOX)).toBe('saved');
            expect(host.writeSecret.mock.calls).toEqual([['api_key_custom', MADE_UP_KEY], ['api_key_vllm', MADE_UP_KEY]]);
            expect(host.readSecretState).toHaveBeenCalledTimes(1);
            expect(toastr.error).not.toHaveBeenCalled();
            expect(toastr.warning).not.toHaveBeenCalled();
        });

        it('says the key was not saved when SillyTavern answers null, without the key', async () => {
            host.writeSecret.mockResolvedValue(null);
            expect(await boxes.saveKeyInSillyTavern(MADE_UP_KEY, boxes.OPENROUTER_KEY_BOX)).toBe('notSaved');
            expect(toastr.error).toHaveBeenCalledWith('SillyTavern did not save your OpenRouter key. Paste it again to try once more.', 'Key not saved');
            expect(JSON.stringify([toastr.error.mock.calls, host.logWarn.mock.calls])).not.toContain(MADE_UP_KEY);
        });

        it('says which uses got the key when SillyTavern saved it in only some slots', async () => {
            host.writeSecret.mockResolvedValueOnce('saved-id').mockResolvedValueOnce(null);
            expect(await boxes.saveKeyInSillyTavern(MADE_UP_KEY, boxes.VLLM_KEY_BOX)).toBe('partlySaved');
            expect(toastr.warning).toHaveBeenCalledWith('SillyTavern saved your vLLM key for EventBase and Agent Mode, but not for embedding. Paste it again to save it for both.', 'Key partly saved');
            expect(toastr.error).not.toHaveBeenCalled();
        });

        it('takes a SillyTavern that answers nothing at all as saved, as before', async () => {
            host.writeSecret.mockResolvedValue(undefined);
            expect(await boxes.saveKeyInSillyTavern(MADE_UP_KEY, boxes.OPENROUTER_KEY_BOX)).toBe('saved');
            expect(toastr.error).not.toHaveBeenCalled();
        });

        it('leaves SillyTavern\'s key list alone for Qdrant\'s slot, which never appears in it', async () => {
            host.writeSecret.mockResolvedValue('saved-id');
            expect(await boxes.saveKeyInSillyTavern(MADE_UP_KEY, boxes.QDRANT_KEY_BOX)).toBe('saved');
            expect(host.writeSecret).toHaveBeenCalledWith('api_key_qdrant', MADE_UP_KEY);
            expect(host.readSecretState).not.toHaveBeenCalled();
        });
    });

    describe('a wired box', () => {
        const paste = async (value) => {
            $('#key_box').val(value).trigger('change');
            await settle();
        };

        beforeEach(() => boxes.wireKeyBox('#key_box', boxes.VLLM_KEY_BOX));

        it('saves the trimmed key, empties itself and re-renders the provider\'s boxes', async () => {
            host.writeSecret.mockResolvedValue('saved-id');
            await paste(`  ${MADE_UP_KEY}  `);
            expect(host.writeSecret).toHaveBeenCalledWith('api_key_custom', MADE_UP_KEY);
            expect($('#key_box').val()).toBe('');
            expect(changed).toHaveBeenCalledTimes(1);
            expect($('#key_box').attr('placeholder')).toBe('Key saved');
        });

        it('reads "Not saved" when SillyTavern saved nothing, and re-renders nothing', async () => {
            host.writeSecret.mockResolvedValue(null);
            await paste(MADE_UP_KEY);
            expect($('#key_box').val()).toBe('');
            expect(changed).not.toHaveBeenCalled();
            expect($('#key_box').attr('placeholder')).toBe('Not saved. Paste the key again');
        });

        it('reads "Partly saved" after the re-render, when one slot saved it', async () => {
            host.writeSecret.mockResolvedValueOnce(null).mockResolvedValueOnce('saved-id');
            await paste(MADE_UP_KEY);
            expect(changed).toHaveBeenCalledTimes(1);
            expect($('#key_box').attr('placeholder')).toBe('Partly saved. Paste the key again');
        });

        it('does nothing for a box left empty', async () => {
            await paste('   ');
            expect(host.writeSecret).not.toHaveBeenCalled();
            expect(changed).not.toHaveBeenCalled();
        });
    });

    describe('a trash button', () => {
        beforeEach(() => host.confirmPopup.mockResolvedValue(true));

        it('asks nothing and deletes nothing when no key is saved', async () => {
            expect(await boxes.clearKeyBox(boxes.OPENROUTER_KEY_BOX)).toBe('nothingSaved');
            expect(host.confirmPopup).not.toHaveBeenCalled();
            expect(host.deleteSecret).not.toHaveBeenCalled();
        });

        it('deletes nothing when the confirm is cancelled', async () => {
            holdKeys({ api_key_openrouter: listed('openrouter-1') });
            host.confirmPopup.mockResolvedValue(false);
            expect(await boxes.clearKeyBox(boxes.OPENROUTER_KEY_BOX)).toBe('kept');
            expect(host.deleteSecret).not.toHaveBeenCalled();
        });

        it('deletes the key in use in each slot by its ID, and says nothing more once SillyTavern deleted it', async () => {
            holdKeys({ api_key_custom: listed('custom-1'), api_key_vllm: listed('vllm-1') });
            host.deleteSecret.mockImplementation(deleteOnServer);
            expect(await boxes.clearKeyBox(boxes.VLLM_KEY_BOX)).toBe('deleted');
            expect(host.deleteSecret.mock.calls).toEqual([['api_key_custom', 'custom-1'], ['api_key_vllm', 'vllm-1']]);
            expect(changed).toHaveBeenCalledTimes(1);
            expect(toastr.error).not.toHaveBeenCalled();
            expect(toastr.warning).not.toHaveBeenCalled();
        });

        it('counts the key as deleted when another key of the slot becomes the one in use', async () => {
            holdKeys({ api_key_openrouter: listed('openrouter-1', 'openrouter-2') });
            host.deleteSecret.mockImplementation(deleteOnServer);
            expect(await boxes.clearKeyBox(boxes.OPENROUTER_KEY_BOX)).toBe('deleted');
            expect(host.secretState.api_key_openrouter.map(secret => secret.id)).toEqual(['openrouter-2']);
        });

        it('says the key was not deleted when SillyTavern still lists it', async () => {
            holdKeys({ api_key_openrouter: listed('openrouter-1') });
            host.deleteSecret.mockResolvedValue(undefined);
            expect(await boxes.clearKeyBox(boxes.OPENROUTER_KEY_BOX)).toBe('notDeleted');
            expect(toastr.error).toHaveBeenCalledWith('SillyTavern did not delete your OpenRouter key. It is still saved. Try again.', 'Key not deleted');
            expect(changed).toHaveBeenCalledTimes(1);
        });

        it('says which uses lost the key when SillyTavern deleted it in only some slots', async () => {
            holdKeys({ api_key_custom: listed('custom-1'), api_key_vllm: listed('vllm-1') });
            host.deleteSecret.mockImplementation(async (slot, id) => { if (slot === 'api_key_vllm') await deleteOnServer(slot, id); });
            expect(await boxes.clearKeyBox(boxes.VLLM_KEY_BOX)).toBe('partlyDeleted');
            expect(toastr.warning).toHaveBeenCalledWith('SillyTavern deleted your vLLM key for embedding, but not for EventBase and Agent Mode. Try again to delete it for both.', 'Key partly deleted');
        });

        it('deletes only the slots that hold a key', async () => {
            holdKeys({ api_key_custom: null, api_key_vllm: listed('vllm-1') });
            host.deleteSecret.mockImplementation(deleteOnServer);
            expect(await boxes.clearKeyBox(boxes.VLLM_KEY_BOX)).toBe('deleted');
            expect(host.deleteSecret.mock.calls).toEqual([['api_key_vllm', 'vllm-1']]);
        });

        it('reads a SillyTavern list with no IDs by whether the slot still holds a key', async () => {
            holdKeys({ api_key_openrouter: true });
            host.deleteSecret.mockImplementation(deleteOnServer);
            expect(await boxes.clearKeyBox(boxes.OPENROUTER_KEY_BOX)).toBe('deleted');
            expect(host.deleteSecret).toHaveBeenCalledWith('api_key_openrouter', undefined);

            holdKeys({ api_key_openrouter: true });
            host.deleteSecret.mockReset().mockResolvedValue(undefined);
            expect(await boxes.clearKeyBox(boxes.OPENROUTER_KEY_BOX)).toBe('notDeleted');
        });
    });

    it('every key box and trash button under src/features goes through api-key-boxes.js', () => {
        // vitest runs from the repository root; under jsdom import.meta.url is not a file URL.
        const repoRoot = process.cwd();
        const jsFilesUnder = folder => readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
            const path = join(folder, entry.name);
            if (entry.isDirectory()) return jsFilesUnder(path);
            return entry.name.endsWith('.js') ? [path] : [];
        });
        const calls = jsFilesUnder(join(repoRoot, 'src/features')).flatMap(path => readFileSync(path, 'utf8').split(/\r?\n/)
            .filter(line => /\b(?:writeSecret|deleteSecret)\(/.test(line) && !/^\s*(\/\/|\/?\*)/.test(line))
            .map(line => `${relative(repoRoot, path).replaceAll('\\', '/')}: ${line.trim()}`));
        expect(calls).toEqual([
            'src/features/settings-panel/api-key-boxes.js: const savedId = await writeSecret(slot, value);',
            'src/features/settings-panel/api-key-boxes.js: for (const { slot, key } of saved) await deleteSecret(slot, key.id ?? undefined);',
        ]);
    });
});

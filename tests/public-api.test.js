/**
 * The `VectFox` object (A1 of InternalProject/Vectfox/plans/vectfox-public-api.md, §4.1): there as soon as
 * src/index.js is evaluated, frozen, ready once initialization ends, and `vectfox_ready` emitted once, without
 * waiting for its listeners. The emitter here behaves as SillyTavern's does: it awaits each listener in turn.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
    listeners: {},
    manifest: { version: '3.6.300' },
    manifestError: null,
}));

vi.mock('../src/sillytavern/events.js', () => ({
    eventSource: {
        on: (event, listener) => { (host.listeners[event] ??= []).push(listener); },
        removeListener: (event, listener) => {
            const listeners = host.listeners[event] ?? [];
            const index = listeners.indexOf(listener);
            if (index > -1) listeners.splice(index, 1);
        },
        emit: async (event, ...args) => {
            for (const listener of (host.listeners[event] ?? []).slice()) {
                await listener(...args);
            }
        },
    },
    event_types: {},
}));
vi.mock('../src/sillytavern/log.js', () => ({ log: { warn: vi.fn(), error: vi.fn(), lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn() } }));
vi.mock('../src/shared/extension-manifest.js', () => ({
    loadExtensionManifest: async () => {
        if (host.manifestError) throw host.manifestError;
        return host.manifest;
    },
}));

/** The modules fresh, as a page load gives them: one readiness, nothing published. */
async function loadPublicApi() {
    vi.resetModules();
    const { log } = await import('../src/sillytavern/log.js');
    const publicApi = await import('../src/features/public-api/index.js');
    return { log, ...publicApi };
}

/** Whether a promise has settled after pending work runs. */
async function hasSettled(promise) {
    let settled = false;
    promise.then(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 0));
    return settled;
}

beforeEach(() => {
    host.listeners = {};
    host.manifest = { version: '3.6.300' };
    host.manifestError = null;
    delete globalThis.VectFox;
});

afterEach(() => {
    delete globalThis.VectFox;
    vi.clearAllMocks();
});

describe('the VectFox object', () => {
    it('is there once published, frozen, at API 1.0.0, and not ready until initialization ends', async () => {
        const { publishPublicApi } = await loadPublicApi();
        publishPublicApi();
        const api = globalThis.VectFox;

        expect(Object.isFrozen(api)).toBe(true);
        expect(api.apiVersion).toBe('1.0.0');
        expect(api.capabilities).toEqual(['events']);
        expect(Object.isFrozen(api.capabilities)).toBe(true);
        expect(api.isReady()).toBe(false);
        expect(api.extensionVersion).toBeNull();
        expect(() => { api.apiVersion = '2.0.0'; }).toThrow(TypeError);
        expect(() => { api.on = () => {}; }).toThrow(TypeError);
        expect(await hasSettled(api.whenReady())).toBe(false);
    });

    it('turns ready once, and a consumer loaded before VectFox hears vectfox_ready once, frozen', async () => {
        const { publishPublicApi, announcePublicApiReady } = await loadPublicApi();
        const heard = [];
        // A consumer loaded before VectFox listens on SillyTavern's eventSource, as no VectFox object exists yet.
        host.listeners.vectfox_ready = [payload => heard.push(payload)];
        publishPublicApi();
        const api = globalThis.VectFox;
        const waiting = api.whenReady();

        await announcePublicApiReady();
        await announcePublicApiReady();

        expect(api.isReady()).toBe(true);
        expect(await hasSettled(waiting)).toBe(true);
        expect(api.whenReady()).toBe(waiting);
        expect(heard).toEqual([{ apiVersion: '1.0.0' }]);
        expect(Object.isFrozen(heard[0])).toBe(true);
        expect(api.extensionVersion).toBe('3.6.300');
    });

    it('does not wait for a listener that never resolves', async () => {
        const { publishPublicApi, announcePublicApiReady } = await loadPublicApi();
        host.listeners.vectfox_ready = [() => new Promise(() => {})];
        publishPublicApi();

        expect(await hasSettled(announcePublicApiReady())).toBe(true);
        expect(globalThis.VectFox.isReady()).toBe(true);
    });

    it('turns ready with extensionVersion null when the manifest cannot be read, and says so', async () => {
        const { publishPublicApi, announcePublicApiReady, log } = await loadPublicApi();
        host.manifestError = new Error('manifest.json answered HTTP 404');
        const heard = [];
        host.listeners.vectfox_ready = [payload => heard.push(payload)];
        publishPublicApi();

        await announcePublicApiReady();

        expect(globalThis.VectFox.isReady()).toBe(true);
        expect(globalThis.VectFox.extensionVersion).toBeNull();
        expect(heard).toHaveLength(1);
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('extensionVersion stays null'), host.manifestError);
    });

    it('says so when it replaces the object of another copy of VectFox', async () => {
        const { publishPublicApi, log } = await loadPublicApi();
        const other = Object.freeze({ apiVersion: '1.0.0' });
        globalThis.VectFox = other;

        publishPublicApi();

        expect(globalThis.VectFox).not.toBe(other);
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('another copy of VectFox'));
    });
});

describe('VectFox.on and VectFox.off', () => {
    it('on subscribes and returns its own unsubscribe, and off unsubscribes', async () => {
        const { publishPublicApi, announcePublicApiReady } = await loadPublicApi();
        publishPublicApi();
        const api = globalThis.VectFox;
        const kept = vi.fn();
        const unsubscribed = vi.fn();
        const offed = vi.fn();

        api.on('vectfox_ready', kept);
        const unsubscribe = api.on('vectfox_ready', unsubscribed);
        api.on('vectfox_ready', offed);
        unsubscribe();
        api.off('vectfox_ready', offed);
        await announcePublicApiReady();

        expect(kept).toHaveBeenCalledTimes(1);
        expect(kept).toHaveBeenCalledWith({ apiVersion: '1.0.0' });
        expect(unsubscribed).not.toHaveBeenCalled();
        expect(offed).not.toHaveBeenCalled();
    });

    it('subscribes nothing to an event this VectFox does not emit, and says so', async () => {
        const { publishPublicApi, log } = await loadPublicApi();
        publishPublicApi();

        const unsubscribe = globalThis.VectFox.on('vectfox_not_an_event', () => {});

        expect(typeof unsubscribe).toBe('function');
        expect(host.listeners.vectfox_not_an_event).toBeUndefined();
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("'vectfox_not_an_event'"));
        expect(() => unsubscribe()).not.toThrow();
    });

    it('throws a TypeError for a handler that is not a function', async () => {
        const { publishPublicApi } = await loadPublicApi();
        publishPublicApi();

        expect(() => globalThis.VectFox.on('vectfox_ready', 'not a function')).toThrow(TypeError);
        expect(host.listeners.vectfox_ready).toBeUndefined();
    });
});

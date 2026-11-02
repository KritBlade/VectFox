import path from 'node:path';
import { defineConfig } from 'vitest/config';

// SillyTavern serves this extension from public/scripts/extensions/third-party/VectFox/, and the
// source imports host modules (script.js, scripts/extensions.js, ...) relative to that location.
const SILLYTAVERN_EXTENSION_URL = '/scripts/extensions/third-party/VectFox';
const HOST_MODULE_ID_PREFIX = '\0sillytavern-host:';

/**
 * Resolves every SillyTavern host-module import (a relative specifier that escapes the repo) to one
 * virtual module per host URL, so a test's `vi.mock('../../../../extensions.js', ...)` and the
 * source's static or dynamic import of the same file share one module ID and the mock applies.
 * A host module that a test does not mock throws on import, naming its host URL.
 */
function sillyTavernHostModules() {
    let repoRoot;
    const isOutsideRepo = (pathFromRoot) =>
        pathFromRoot === '..' || pathFromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(pathFromRoot);
    return {
        name: 'vectfox:sillytavern-host-modules',
        enforce: 'pre',
        configResolved(config) {
            repoRoot = config.root;
        },
        resolveId(specifier, importer) {
            if (!importer || !specifier.startsWith('../')) return null;
            const importerPath = importer.split('?')[0];
            const importerFromRoot = path.relative(repoRoot, importerPath);
            if (isOutsideRepo(importerFromRoot)) return null;
            if (!isOutsideRepo(path.relative(repoRoot, path.resolve(path.dirname(importerPath), specifier)))) return null;
            const importerUrl = path.posix.join(SILLYTAVERN_EXTENSION_URL, importerFromRoot.split(path.sep).join('/'));
            return HOST_MODULE_ID_PREFIX + path.posix.resolve(path.posix.dirname(importerUrl), specifier);
        },
        load(id) {
            if (!id.startsWith(HOST_MODULE_ID_PREFIX)) return null;
            const hostUrl = id.slice(HOST_MODULE_ID_PREFIX.length);
            const message = `SillyTavern host module ${hostUrl} does not exist under vitest; vi.mock() it in the test.`;
            return `throw new Error(${JSON.stringify(message)});`;
        },
    };
}

export default defineConfig({
    plugins: [sillyTavernHostModules()],
    test: {
        // Test file patterns
        include: ['tests/**/*.test.js'],

        // Environment
        environment: 'node',

        // Globals (describe, it, expect available without import)
        globals: true,

        // Coverage configuration
        coverage: {
            provider: 'v8',
            reporter: ['text', 'html', 'lcov'],
            include: ['core/**/*.js', 'src/**/*.js', 'utils/**/*.js'],
            exclude: ['**/node_modules/**', 'tests/**']
        },

        // Reporter
        reporters: ['verbose'],

        // Timeouts
        testTimeout: 10000,
        hookTimeout: 10000
    }
});

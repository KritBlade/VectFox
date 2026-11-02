// .dependency-cruiser.cjs — the import rules `npm test` holds the shipped code to (dependency-cruiser).
//
// `npm run check:import-graph` walks the import graph from the manifest's entry, index.js, and checks two rules:
// every in-repo import resolves, and no new import cycle appears. The cycles that exist today are recorded in
// .dependency-cruiser-known-violations.json and pass until they are removed; any other cycle fails. After removing
// cycles, refresh that file with `npm run check:import-graph -- --baseline --baseline-mode shrink-only`, which can
// drop entries but never add one.
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
    forbidden: [
        {
            name: 'no-circular',
            severity: 'error',
            comment: 'Modules in a cycle cannot be read, tested or moved one at a time.',
            from: {},
            to: { circular: true },
        },
        {
            name: 'not-to-unresolvable',
            severity: 'error',
            comment: 'An import whose file does not exist stops the extension loading in the browser. Paths that '
                + 'leave this repo are SillyTavern\'s own modules; tools/check-host-imports.mjs checks those.',
            from: {},
            to: { couldNotResolve: true, pathNot: '^(\\.\\./){3,}' },
        },
    ],
    options: {
        doNotFollow: { path: 'node_modules' },
        moduleSystems: ['es6'],
    },
};

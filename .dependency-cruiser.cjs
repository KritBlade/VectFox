// .dependency-cruiser.cjs — the import rules `npm test` holds the shipped code to (dependency-cruiser).
//
// `npm run check:import-graph` walks the import graph from the manifest's entry, src/index.js, static and dynamic
// imports alike, and checks that every in-repo import resolves, that no module imports itself back through a cycle,
// that the layers import downward only (src/index.js and src/app/ over the features, the features over src/shared/,
// everything over src/sillytavern/), and that code outside a feature imports it through its index.js.
//
// Together the barrel rules and no-circular keep the features acyclic: every file of a feature is reached through
// its index.js, so a cycle between two features is also a cycle between modules.
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
        {
            name: 'host-layer-imports-only-itself',
            severity: 'error',
            comment: 'src/sillytavern/ wraps SillyTavern for the rest of VectFox: it imports SillyTavern and its own '
                + 'files, nothing above it.',
            from: { path: '^src/sillytavern/' },
            to: { path: '^src/', pathNot: '^src/sillytavern/' },
        },
        {
            name: 'shared-not-to-features-or-bootstrap',
            severity: 'error',
            comment: 'src/shared/ holds ownerless primitives under the features: it never imports a feature, src/app/ '
                + 'or src/index.js. A call upward goes through a hook that src/index.js registers.',
            from: { path: '^src/shared/' },
            to: { path: '^src/(features/|app/|index\\.js$)' },
        },
        {
            name: 'feature-not-to-bootstrap',
            severity: 'error',
            comment: 'src/index.js and src/app/ wire the features together; a feature never imports them.',
            from: { path: '^src/features/' },
            to: { path: '^src/(app/|index\\.js$)' },
        },
        {
            name: 'feature-to-feature-through-barrel',
            severity: 'error',
            comment: 'Another feature\'s files are its own: import the feature through its index.js.',
            from: { path: '^src/features/([^/]+)/' },
            to: { path: '^src/features/', pathNot: '^src/features/($1/|[^/]+/index\\.js$)' },
        },
        {
            name: 'bootstrap-to-feature-through-barrel',
            severity: 'error',
            comment: 'src/index.js and src/app/ import a feature through its index.js, like the features do.',
            from: { path: '^src/(index\\.js$|app/)' },
            to: { path: '^src/features/', pathNot: '^src/features/[^/]+/index\\.js$' },
        },
        {
            name: 'feature-not-to-own-barrel',
            severity: 'error',
            comment: 'A feature\'s index.js is for code outside it; its own files import each other directly.',
            from: { path: '^src/features/([^/]+)/', pathNot: '^src/features/[^/]+/index\\.js$' },
            to: { path: '^src/features/$1/index\\.js$' },
        },
        {
            name: 'barrel-re-exports-own-feature',
            severity: 'error',
            comment: 'A feature\'s index.js re-exports that feature\'s files and nothing else.',
            from: { path: '^src/features/([^/]+)/index\\.js$' },
            to: { pathNot: '^src/features/$1/' },
        },
    ],
    options: {
        doNotFollow: { path: 'node_modules' },
        moduleSystems: ['es6'],
    },
};

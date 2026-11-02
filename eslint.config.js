// eslint.config.js — the guard for the defect class the test suite cannot see.
//
// vitest loads only the modules a unit test imports. Most of ui/, and every path that needs a live
// SillyTavern page, never loads there, so a reference to a deleted or renamed helper stays invisible
// until it throws in the browser. `no-undef` catches that in milliseconds; `no-unused-vars` catches
// the other half of a move: an import or helper left behind after its last use.

import js from '@eslint/js';
import globals from 'globals';

const unusedVariablesRule = ['error', {
    args: 'after-used',
    // `_`-prefixed names are the documented opt-out (e.g. `catch (_ignored)`).
    argsIgnorePattern: '^_',
    varsIgnorePattern: '^_',
    caughtErrorsIgnorePattern: '^_',
    // `const { drop, ...rest } = obj` names a key precisely so that it is NOT in `rest`.
    ignoreRestSiblings: true,
}];

const runtimeRules = {
    ...js.configs.recommended.rules,
    'no-undef': 'error',
    'no-unused-vars': unusedVariablesRule,
    // Aligns with "never hide a caught error"; style and format are not this tool's job.
    'no-empty': ['error', { allowEmptyCatch: false }],
};

export default [
    { ignores: ['node_modules/**', 'src/vendor/**', 'playwright-report/**', 'test-results/**', 'coverage/**'] },

    // ── extension source: runs in the SillyTavern page ──────────────────────────
    {
        files: ['src/**/*.js'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            globals: {
                ...globals.browser,
                // Provided by the ST page, not imported — declaring them is what lets no-undef
                // stay strict everywhere else instead of being switched off.
                $: 'readonly',            // jQuery, bundled by ST
                jQuery: 'readonly',
                toastr: 'readonly',       // ST's toast library
                SillyTavern: 'readonly',  // ST's public context accessor
            },
        },
        rules: runtimeRules,
    },

    // ── abstract backend: each method's parameters are the contract its subclasses implement ──
    {
        files: ['src/features/vector-backend/backend-interface.js'],
        rules: { 'no-unused-vars': ['error', { ...unusedVariablesRule[1], args: 'none' }] },
    },

    // ── Node tooling and config files ───────────────────────────────────────────
    {
        files: ['scripts/**/*.mjs', 'tools/**/*.mjs', '*.config.js'],
        languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.node } },
        rules: runtimeRules,
    },
    {
        files: ['.dependency-cruiser.cjs'],
        languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: { ...globals.node } },
        rules: runtimeRules,
    },

    // ── unit tests: vitest with `globals: true`, in Node ────────────────────────
    {
        files: ['tests/**/*.test.js'],
        languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.node, ...globals.vitest } },
        rules: runtimeRules,
    },

    // ── e2e spec: Node test code plus page code passed to page.evaluate ─────────
    {
        files: ['tests/**/*.spec.js'],
        languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.node, ...globals.browser } },
        rules: runtimeRules,
    },
];

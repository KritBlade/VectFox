// tools/es-module-scan.mjs — reads what an ES module imports and exports, for the import checks in tools/.
//
// Parsed with acorn, so comments, strings and regex literals cannot fool it. It sees literal paths only: an import of
// a path held in a variable is invisible here, as it is to every static check. bm25-scorer.js imports the jieba glue
// that way; the `new URL('./vendor/…', import.meta.url)` literal that builds the path is read instead.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse } from 'acorn';

/**
 * One import of a module.
 * @typedef {object} ModuleImport
 * @property {string} specifier  the path as written
 * @property {'static' | 'reexport' | 'dynamic' | 'url'} kind  `url` is `new URL('<path>', import.meta.url)`: a file
 *     fetched by URL, not imported
 * @property {string[] | null} names  the names it takes from the target (`default` for a default import); empty when
 *     it takes none; null when they cannot be read statically (a dynamic import whose module is used whole)
 * @property {number} line
 */

const programs = new Map();
function programOf(filePath) {
    if (!programs.has(filePath)) {
        programs.set(filePath, parse(readFileSync(filePath, 'utf8'), {
            ecmaVersion: 'latest', sourceType: 'module', locations: true, allowHashBang: true,
        }));
    }
    return programs.get(filePath);
}

const nameOf = (node) => (node.type === 'Identifier' ? node.name : String(node.value));

const isImportMetaUrl = (node) => node?.type === 'MemberExpression' && !node.computed
    && node.object.type === 'MetaProperty' && node.object.meta.name === 'import' && nameOf(node.property) === 'url';

const isFunction = (node) => /^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(node.type);

/** Calls `onNode(node, ancestors)` for every node below `node`, outermost ancestor first. */
function walk(node, ancestors, onNode) {
    onNode(node, ancestors);
    ancestors.push(node);
    for (const key of Object.keys(node)) {
        if (key === 'loc') continue;
        const value = node[key];
        if (Array.isArray(value)) {
            for (const child of value) if (child && typeof child.type === 'string') walk(child, ancestors, onNode);
        } else if (value && typeof value.type === 'string') {
            walk(value, ancestors, onNode);
        }
    }
    ancestors.pop();
}

/** The keys an object pattern takes, or null when one is computed and so cannot be read. */
function patternKeys(objectPattern) {
    const keys = [];
    for (const property of objectPattern.properties) {
        if (property.type === 'RestElement') continue;
        if (property.computed) return null;
        keys.push(nameOf(property.key));
    }
    return keys;
}

/** The members read as `<name>.<member>` inside `scope`. */
function membersRead(scope, name) {
    const members = new Set();
    walk(scope, [], (node) => {
        if (node.type === 'MemberExpression' && !node.computed
            && node.object.type === 'Identifier' && node.object.name === name) members.add(nameOf(node.property));
    });
    return [...members];
}

/** The names a dynamic import's module is bound to and then read through, or null when that cannot be read. */
function namesTakenBy(binding, ancestors) {
    if (binding.type === 'AssignmentPattern') return namesTakenBy(binding.left, ancestors);
    if (binding.type === 'ObjectPattern') return patternKeys(binding);
    if (binding.type !== 'Identifier') return null;
    const scope = [...ancestors].reverse().find(isFunction) ?? ancestors[0];
    return membersRead(scope, binding.name);
}

/** The pattern `holder` binds `value` to (`const <pattern> = value` or `<pattern> = value`), or null. */
function boundPattern(holder, value) {
    if (holder?.type === 'VariableDeclarator' && holder.init === value) return holder.id;
    if (holder?.type === 'AssignmentExpression' && holder.right === value) return holder.left;
    return null;
}

const isPromiseAll = (callee) => callee.type === 'MemberExpression' && !callee.computed
    && callee.object.type === 'Identifier' && callee.object.name === 'Promise' && nameOf(callee.property) === 'all';

/** The names the dynamic `import()` at `node` takes, from the code around it. */
function dynamicImportNames(node, ancestors) {
    const parent = ancestors.at(-1);
    const grandparent = ancestors.at(-2);
    if (parent.type === 'ExpressionStatement') return [];
    if (parent.type === 'AwaitExpression') {
        if (grandparent.type === 'ExpressionStatement') return [];
        const pattern = boundPattern(grandparent, parent);
        if (pattern) return namesTakenBy(pattern, ancestors.slice(0, -2));
        if (grandparent.type === 'MemberExpression' && grandparent.object === parent && !grandparent.computed) {
            return [nameOf(grandparent.property)];
        }
        return null;
    }
    // const [{ a }, { b }] = await Promise.all([import('./x.js'), import('./y.js')])
    if (parent.type === 'ArrayExpression' && grandparent.type === 'CallExpression' && isPromiseAll(grandparent.callee)
        && grandparent.arguments[0] === parent && ancestors.at(-3)?.type === 'AwaitExpression') {
        const pattern = boundPattern(ancestors.at(-4), ancestors.at(-3));
        if (pattern?.type !== 'ArrayPattern') return null;
        const element = pattern.elements[parent.elements.indexOf(node)];
        return element ? namesTakenBy(element, ancestors.slice(0, -4)) : [];
    }
    // import('./x.js').then((module) => …)
    if (parent.type === 'MemberExpression' && !parent.computed && nameOf(parent.property) === 'then'
        && grandparent.type === 'CallExpression' && grandparent.callee === parent) {
        const callback = grandparent.arguments[0];
        if (!callback || !isFunction(callback)) return null;
        if (!callback.params.length) return [];
        return namesTakenBy(callback.params[0], [...ancestors.slice(0, -2), callback]);
    }
    return null;
}

const importsCache = new Map();
/** @returns {ModuleImport[]} every import in the module at `filePath`, with a literal path */
export function importsOf(filePath) {
    if (importsCache.has(filePath)) return importsCache.get(filePath);
    const imports = [];
    walk(programOf(filePath), [], (node, ancestors) => {
        const line = node.loc.start.line;
        if (node.type === 'ImportDeclaration') {
            const names = node.specifiers
                .filter((s) => s.type !== 'ImportNamespaceSpecifier')
                .map((s) => (s.type === 'ImportDefaultSpecifier' ? 'default' : nameOf(s.imported)));
            imports.push({ specifier: node.source.value, kind: 'static', names, line });
        } else if (node.type === 'ExportNamedDeclaration' && node.source) {
            imports.push({ specifier: node.source.value, kind: 'reexport', names: node.specifiers.map((s) => nameOf(s.local)), line });
        } else if (node.type === 'ExportAllDeclaration') {
            imports.push({ specifier: node.source.value, kind: 'reexport', names: [], line });
        } else if (node.type === 'ImportExpression') {
            if (node.source.type === 'Literal' && typeof node.source.value === 'string') {
                imports.push({ specifier: node.source.value, kind: 'dynamic', names: dynamicImportNames(node, ancestors), line });
            }
        } else if (node.type === 'NewExpression' && node.callee.type === 'Identifier' && node.callee.name === 'URL'
            && node.arguments[0]?.type === 'Literal' && typeof node.arguments[0].value === 'string'
            && isImportMetaUrl(node.arguments[1])) {
            imports.push({ specifier: node.arguments[0].value, kind: 'url', names: [], line });
        }
    });
    importsCache.set(filePath, imports);
    return imports;
}

/** Every name a binding pattern declares (`export const { a, b } = …` exports a and b). */
function boundNames(pattern, names = []) {
    if (pattern.type === 'Identifier') names.push(pattern.name);
    else if (pattern.type === 'ObjectPattern') {
        for (const property of pattern.properties) boundNames(property.type === 'RestElement' ? property.argument : property.value, names);
    } else if (pattern.type === 'ArrayPattern') {
        for (const element of pattern.elements) if (element) boundNames(element, names);
    } else if (pattern.type === 'RestElement') boundNames(pattern.argument, names);
    else if (pattern.type === 'AssignmentPattern') boundNames(pattern.left, names);
    return names;
}

/**
 * Every name the module at `filePath` exports, following `export * from` into the modules it names.
 * @returns {{ names: Set<string>, unreadStars: string[] }}  unreadStars: `export * from` paths with no file
 *     behind them, whose names are therefore unknown
 */
export function exportedNamesOf(filePath, visited = new Set()) {
    const names = new Set();
    const unreadStars = [];
    if (visited.has(filePath)) return { names, unreadStars };
    visited.add(filePath);
    for (const statement of programOf(filePath).body) {
        if (statement.type === 'ExportDefaultDeclaration') names.add('default');
        else if (statement.type === 'ExportNamedDeclaration') {
            for (const specifier of statement.specifiers) names.add(nameOf(specifier.exported));
            const declaration = statement.declaration;
            if (declaration?.type === 'VariableDeclaration') {
                for (const declarator of declaration.declarations) boundNames(declarator.id).forEach((n) => names.add(n));
            } else if (declaration?.id) names.add(declaration.id.name);
        } else if (statement.type === 'ExportAllDeclaration') {
            if (statement.exported) { names.add(nameOf(statement.exported)); continue; }
            const target = resolve(dirname(filePath), statement.source.value);
            if (!existsSync(target)) { unreadStars.push(statement.source.value); continue; }
            const starred = exportedNamesOf(target, visited);
            starred.names.forEach((n) => { if (n !== 'default') names.add(n); });
            unreadStars.push(...starred.unreadStars);
        }
    }
    return { names, unreadStars };
}

/** Whether `target` lies below `folder`. */
export function isInside(folder, target) {
    const path = relative(folder, target);
    return path !== '' && !path.startsWith('..') && !isAbsolute(path);
}

const listings = new Map();
/**
 * How `target`, which lies below `folder`, stands on disk, spelled exactly as written: Windows ignores letter case,
 * a Linux server does not.
 * @returns {{ state: 'exact' } | { state: 'case', written: string, onDisk: string } | { state: 'missing' }}
 */
export function findOnDisk(folder, target) {
    let current = folder;
    for (const segment of relative(folder, target).split(sep)) {
        if (!statSync(current).isDirectory()) return { state: 'missing' };
        if (!listings.has(current)) listings.set(current, readdirSync(current));
        const entries = listings.get(current);
        if (!entries.includes(segment)) {
            const onDisk = entries.find((entry) => entry.toLowerCase() === segment.toLowerCase());
            return onDisk ? { state: 'case', written: segment, onDisk } : { state: 'missing' };
        }
        current = join(current, segment);
    }
    return statSync(current).isFile() ? { state: 'exact' } : { state: 'missing' };
}

/** Every module in `repoRoot` that the manifest's "js" entry reaches through literal imports, as absolute paths. */
export function shippedModules(repoRoot) {
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'manifest.json'), 'utf8'));
    const pending = [resolve(repoRoot, manifest.js)];
    const reached = new Set();
    while (pending.length) {
        const file = pending.pop();
        if (reached.has(file)) continue;
        reached.add(file);
        for (const entry of importsOf(file)) {
            if (entry.kind === 'url' || !entry.specifier.startsWith('.')) continue;
            const target = resolve(dirname(file), entry.specifier);
            if (isInside(repoRoot, target) && findOnDisk(repoRoot, target).state === 'exact') pending.push(target);
        }
    }
    return [...reached];
}

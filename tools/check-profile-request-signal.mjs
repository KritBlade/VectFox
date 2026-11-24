// tools/check-profile-request-signal.mjs — SillyTavern must hand the signal VectFox gives a request on a connection
// profile to fetch as is. VectFox's mark on its own requests rides that signal (Doc/public-api.md, "The mark on
// VectFox's requests"), and on a profile SillyTavern makes the fetch. VectFox passes the signal as `custom.signal` to
// getContext().ConnectionManagerRequestService.sendRequest (src/sillytavern/connection-profiles.js). This check reads
// SillyTavern's source and follows the signal from there to every fetch that can send the request:
//   public/scripts/st-context.js          getContext() gives the three classes below, as imported from their files
//   public/scripts/extensions/shared.js   ConnectionManagerRequestService.sendRequest takes `signal` from `custom` and
//                                         passes it to ChatCompletionService.processRequest and
//                                         TextCompletionService.processRequest
//   public/scripts/custom-request.js      each processRequest passes it to its own sendRequest, and each sendRequest
//                                         puts it into every fetch it makes, as `signal` or `signal ?? <its own>`
// A signal assigned anew, wrapped (AbortSignal.any, or a controller of SillyTavern's own) or left out of a call fails
// the check, as a profile's request would then go out without the mark. vectfox_llm_call_finished still reports every
// call, so nothing breaks for a user: the check makes sure such a SillyTavern update is read before a release.
//   node tools/check-profile-request-signal.mjs                  the folder tools/sillytavern-folder.mjs finds
//   ST_ROOT=<SillyTavern folder> node tools/check-profile-request-signal.mjs

import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { boundNames, importsOf, isFunction, nameOf, programOf, walk } from './es-module-scan.mjs';
import { findSillyTavernFolder } from './sillytavern-folder.mjs';

const TAG = 'profile-request-signal';
const sillyTavernFolder = findSillyTavernFolder(TAG);
const scriptsFolder = join(sillyTavernFolder, 'public', 'scripts');
const CONTEXT_FILE = join(scriptsFolder, 'st-context.js');
const MANAGER_FILE = join(scriptsFolder, 'extensions', 'shared.js');
const SERVICES_FILE = join(scriptsFolder, 'custom-request.js');
// What getContext() gives VectFox's request, each from the file st-context.js imports it from.
const CONTEXT_CLASSES = {
    ConnectionManagerRequestService: './extensions/shared.js',
    ChatCompletionService: './custom-request.js',
    TextCompletionService: './custom-request.js',
};
const SERVICES = ['ChatCompletionService', 'TextCompletionService'];

const problems = [];
let fetchCount = 0;
const shown = (file) => relative(sillyTavernFolder, file).replaceAll('\\', '/');
const at = (file, node) => `${shown(file)}:${node.loc.start.line}`;
const isIdentifier = (node, name) => node?.type === 'Identifier' && node.name === name;
const isMember = (node, name) => node?.type === 'MemberExpression' && !node.computed && nameOf(node.property) === name;
const isPropertyNamed = (node, name) => node?.type === 'Property' && !node.computed && nameOf(node.key) === name;

/** Every node below `root` that `test` accepts. */
function nodesIn(root, test) {
    const found = [];
    walk(root, [], (node) => { if (test(node)) found.push(node); });
    return found;
}

/** The static method `methodName` of the class `className` in `file`; null, with the problem noted, when it is gone. */
function staticMethod(file, className, methodName) {
    const [classNode] = nodesIn(programOf(file), (node) => node.type === 'ClassDeclaration' && node.id?.name === className);
    if (!classNode) {
        problems.push(`${shown(file)}: no class ${className}`);
        return null;
    }
    const method = classNode.body.body.find((member) => member.type === 'MethodDefinition' && member.static
        && !member.computed && nameOf(member.key) === methodName);
    if (!method) problems.push(`${at(file, classNode)} ${className} has no static ${methodName}`);
    return method ?? null;
}

/** The name of a method's parameter at `index`, a default value allowed; null when it is not a plain name. */
function parameterName(method, index) {
    const parameter = method.value.params[index];
    const binding = parameter?.type === 'AssignmentPattern' ? parameter.left : parameter;
    return binding?.type === 'Identifier' ? binding.name : null;
}

/** Whether `node` declares `name`: a variable, a function or one of its parameters, a class, or a caught error. */
function declares(node, name) {
    if (node.type === 'VariableDeclarator') return boundNames(node.id).includes(name);
    if (isFunction(node)) return node.id?.name === name || node.params.some((parameter) => boundNames(parameter).includes(name));
    if (node.type === 'ClassDeclaration') return node.id?.name === name;
    if (node.type === 'CatchClause') return Boolean(node.param) && boundNames(node.param).includes(name);
    return false;
}

/** Whether `node` gives `name` a new value. */
const writes = (node, name) => (node.type === 'AssignmentExpression' && boundNames(node.left).includes(name))
    || (node.type === 'UpdateExpression' && isIdentifier(node.argument, name));

/** Notes each place the method's body declares `name` again, past the `declaredHere` it may, or gives it a new value. */
function checkKeptAsIs(file, method, label, name, declaredHere = 0) {
    const declarations = nodesIn(method.value.body, (node) => declares(node, name));
    if (declarations.length > declaredHere) problems.push(`${at(file, declarations[declaredHere])} ${label} declares \`${name}\` again`);
    for (const write of nodesIn(method.value.body, (node) => writes(node, name))) {
        problems.push(`${at(file, write)} ${label} gives \`${name}\` a new value`);
    }
}

/**
 * Whether a declarator gives `variable` the `signal` of `custom` as is: `const { signal } = custom`,
 * `const signal = custom.signal`, or `const { signal } = { ...defaults, ...custom }` with nothing after `...custom` that
 * could set it.
 */
function holdsSignalOf(declarator, variable, custom) {
    const { id, init } = declarator;
    if (id.type === 'Identifier') return isMember(init, 'signal') && isIdentifier(init.object, custom);
    if (id.type !== 'ObjectPattern') return false;
    const property = id.properties.find((entry) => isPropertyNamed(entry, 'signal'));
    const target = property?.value.type === 'AssignmentPattern' ? property.value.left : property?.value;
    if (!isIdentifier(target, variable)) return false;
    if (isIdentifier(init, custom)) return true;
    if (init?.type !== 'ObjectExpression') return false;
    const spread = init.properties.findLastIndex((entry) => entry.type === 'SpreadElement' && isIdentifier(entry.argument, custom));
    return spread !== -1 && init.properties.slice(spread + 1).every((entry) => entry.type === 'Property' && !entry.computed
        && nameOf(entry.key) !== 'signal');
}

/** getContext() gives each class VectFox's request goes through, as st-context.js imports it from its file. */
function checkContext() {
    const imported = new Map();
    for (const entry of importsOf(CONTEXT_FILE)) {
        if (entry.kind === 'static') entry.names.forEach((name) => imported.set(name, entry.specifier));
    }
    const [getContext] = nodesIn(programOf(CONTEXT_FILE), (node) => node.type === 'FunctionDeclaration' && node.id?.name === 'getContext');
    if (!getContext) {
        problems.push(`${shown(CONTEXT_FILE)}: no getContext function`);
        return;
    }
    for (const [name, specifier] of Object.entries(CONTEXT_CLASSES)) {
        if (imported.get(name) !== specifier) problems.push(`${shown(CONTEXT_FILE)}: ${name} is not imported from ${specifier}`);
        const given = nodesIn(getContext, (node) => isPropertyNamed(node, name));
        if (!given.length || !given.every((property) => isIdentifier(property.value, name))) {
            problems.push(`${at(CONTEXT_FILE, given[0] ?? getContext)} getContext() does not give ${name} as imported`);
        }
    }
}

/** ConnectionManagerRequestService.sendRequest takes the signal from `custom` and passes it to both services. */
function checkConnectionManager() {
    const label = 'ConnectionManagerRequestService.sendRequest';
    const method = staticMethod(MANAGER_FILE, 'ConnectionManagerRequestService', 'sendRequest');
    if (!method) return;
    const custom = parameterName(method, 3);
    if (!custom) {
        problems.push(`${at(MANAGER_FILE, method)} ${label} no longer takes \`custom\` as its 4th parameter`);
        return;
    }
    checkKeptAsIs(MANAGER_FILE, method, label, custom);
    const signalWrites = nodesIn(method.value.body, (node) => node.type === 'AssignmentExpression'
        && isMember(node.left, 'signal') && isIdentifier(node.left.object, custom));
    signalWrites.forEach((write) => problems.push(`${at(MANAGER_FILE, write)} ${label} gives \`${custom}.signal\` a new value`));

    const passed = new Set();
    for (const service of SERVICES) {
        const calls = nodesIn(method.value.body, (node) => node.type === 'CallExpression' && isMember(node.callee, 'processRequest')
            && (isMember(node.callee.object, service) || isIdentifier(node.callee.object, service)));
        if (!calls.length) problems.push(`${at(MANAGER_FILE, method)} ${label} no longer calls ${service}.processRequest`);
        for (const call of calls) {
            const signal = call.arguments[3];
            if (signal?.type === 'Identifier') passed.add(signal.name);
            else problems.push(`${at(MANAGER_FILE, call)} ${label} passes ${service}.processRequest no variable as its signal (4th argument)`);
        }
    }
    for (const variable of passed) {
        checkKeptAsIs(MANAGER_FILE, method, label, variable, 1);
        const [declarator] = nodesIn(method.value.body, (node) => node.type === 'VariableDeclarator' && boundNames(node.id).includes(variable));
        if (!declarator || !holdsSignalOf(declarator, variable, custom)) {
            problems.push(`${at(MANAGER_FILE, declarator ?? method)} ${label}: \`${variable}\` does not hold \`${custom}.signal\` as is`);
        }
    }
}

/**
 * Whether a fetch's init, written out, sets `signal` to the signal as is, or to `signal ?? <another>`, with nothing
 * after it that could set it again.
 */
function givesSignalAsIs(init, signal) {
    if (init?.type !== 'ObjectExpression') return false;
    const index = init.properties.findIndex((entry) => isPropertyNamed(entry, 'signal'));
    if (index === -1) return false;
    const { value } = init.properties[index];
    const isAsIs = isIdentifier(value, signal)
        || (value.type === 'LogicalExpression' && ['??', '||'].includes(value.operator) && isIdentifier(value.left, signal));
    const isSetAgain = init.properties.slice(index + 1).some((entry) => entry.type === 'SpreadElement' || entry.computed
        || nameOf(entry.key) === 'signal');
    return isAsIs && !isSetAgain;
}

/** Each service's processRequest passes the signal to its own sendRequest, which puts it into every fetch it makes. */
function checkService(service) {
    const processRequest = staticMethod(SERVICES_FILE, service, 'processRequest');
    const processSignal = processRequest && parameterName(processRequest, 3);
    if (processRequest && !processSignal) {
        problems.push(`${at(SERVICES_FILE, processRequest)} ${service}.processRequest no longer takes a signal as its 4th parameter`);
    }
    if (processSignal) {
        const label = `${service}.processRequest`;
        checkKeptAsIs(SERVICES_FILE, processRequest, label, processSignal);
        const calls = nodesIn(processRequest.value.body, (node) => node.type === 'CallExpression' && isMember(node.callee, 'sendRequest')
            && (node.callee.object.type === 'ThisExpression' || isIdentifier(node.callee.object, service)));
        if (!calls.length) problems.push(`${at(SERVICES_FILE, processRequest)} ${label} no longer calls its sendRequest`);
        for (const call of calls) {
            if (!isIdentifier(call.arguments[2], processSignal)) {
                problems.push(`${at(SERVICES_FILE, call)} ${label} does not pass \`${processSignal}\` to sendRequest as is (3rd argument)`);
            }
        }
    }

    const sendRequest = staticMethod(SERVICES_FILE, service, 'sendRequest');
    const sendSignal = sendRequest && parameterName(sendRequest, 2);
    if (sendRequest && !sendSignal) {
        problems.push(`${at(SERVICES_FILE, sendRequest)} ${service}.sendRequest no longer takes a signal as its 3rd parameter`);
    }
    if (sendSignal) {
        const label = `${service}.sendRequest`;
        checkKeptAsIs(SERVICES_FILE, sendRequest, label, sendSignal);
        const fetches = nodesIn(sendRequest.value.body, (node) => node.type === 'CallExpression' && isIdentifier(node.callee, 'fetch'));
        if (!fetches.length) problems.push(`${at(SERVICES_FILE, sendRequest)} ${label} makes no fetch`);
        for (const call of fetches) {
            fetchCount++;
            if (!givesSignalAsIs(call.arguments[1], sendSignal)) {
                problems.push(`${at(SERVICES_FILE, call)} ${label} does not give its fetch \`${sendSignal}\` as is`);
            }
        }
    }
}

const packageFile = join(sillyTavernFolder, 'package.json');
const version = existsSync(packageFile) ? JSON.parse(readFileSync(packageFile, 'utf8')).version : '(no package.json)';
console.log(`[${TAG}] reading SillyTavern ${version} at ${sillyTavernFolder}`);

checkContext();
checkConnectionManager();
SERVICES.forEach(checkService);

if (problems.length) {
    problems.forEach((problem) => console.error(`[${TAG}] ${problem}`));
    console.error(`[${TAG}] FAIL: ${problems.length} problem(s). SillyTavern ${version} no longer hands a profile `
        + "request's signal to fetch in a way this check can follow. If it now wraps or drops the signal, VectFox's mark "
        + 'no longer goes out with a request on a profile, though vectfox_llm_call_finished still reports the call. '
        + 'Read the change, then update this check, or how VectFox hands over its signal and what Doc/public-api.md '
        + 'tells a tracker.');
    process.exit(1);
}
console.log(`[${TAG}] OK: SillyTavern ${version} hands a profile request's signal to fetch as is: getContext(), `
    + `ConnectionManagerRequestService.sendRequest, ${SERVICES.join(' and ')} (processRequest, sendRequest), `
    + `${fetchCount} fetch calls`);

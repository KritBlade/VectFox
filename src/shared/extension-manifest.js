/**
 * VectFox's manifest.json, the one file that says which VectFox this is (`version`) and the oldest Similharity it
 * works with (`similharity_minimum_version`). SillyTavern reads only the manifest keys it knows, so it ignores the
 * second. Read once per session; a failed read is not kept, so the next caller reads it again.
 */

let manifestRequest = null;

/**
 * The manifest's fields.
 *
 * @returns {Promise<object>}
 * @throws {Error} When the file cannot be fetched or read
 */
export function loadExtensionManifest() {
    manifestRequest ??= (async () => {
        // The manifest sits beside src/, where SillyTavern serves the extension from. The query string skips a copy
        // the browser cached before an update.
        const response = await fetch(`${new URL('../../manifest.json', import.meta.url).href}?_=${Date.now()}`);
        if (!response.ok) throw new Error(`manifest.json answered HTTP ${response.status}`);
        return response.json();
    })().catch((error) => {
        manifestRequest = null;
        throw error;
    });
    return manifestRequest;
}

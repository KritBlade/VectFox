/**
 * Hash of one chat message as EventBase records it in `source_message_hashes`.
 *
 * Window fingerprints (eventbase-store.js), the extractor's stored source hashes,
 * and the branch-fork shared-prefix match (eventbase-fork-core.js) all compare
 * these values, so every caller must hash through this function.
 *
 * Uses the message's own `hash` when present, otherwise a djb2 hash of
 * `name:trimmedText`.
 *
 * @param {{ hash?: number|string, name?: string, mes?: string }} message
 * @returns {number|string}
 */
export function hashSourceMessage(message) {
    if (message?.hash != null) return message.hash;
    const text = (message?.mes || '').trim();
    return djb2(`${message?.name || ''}:${text}`);
}

function djb2(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) + h) ^ str.charCodeAt(i);
        h >>>= 0;
    }
    return h;
}

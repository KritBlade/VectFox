// byte-size.js — measures text in bytes and writes a byte count the way VectFox shows sizes to the user.

const utf8Encoder = new TextEncoder();

/**
 * The bytes a text takes as UTF-8, the encoding a saved settings file, an export and a Qdrant
 * payload use. A CJK character takes 3 bytes, so a character count understates such text.
 *
 * @param {string} text
 * @returns {number}
 */
export function utf8ByteLength(text) {
    return utf8Encoder.encode(text).length;
}

/**
 * A byte count in the largest unit it reaches: B, then whole KB, then MB and GB with one decimal
 * (a trailing .0 dropped). A count that rounds up to 1024 of a unit is shown in the next one.
 *
 * @param {number} bytes
 * @returns {string} Such as "512 B", "266 KB", "1.5 MB" or "2 GB"
 */
export function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    const kilobytes = Math.round(bytes / 1024);
    if (kilobytes < 1024) return `${kilobytes} KB`;
    const megabytes = Number((bytes / 1024 ** 2).toFixed(1));
    if (megabytes < 1024) return `${megabytes} MB`;
    return `${Number((bytes / 1024 ** 3).toFixed(1))} GB`;
}

// html-escape.js — escapes text for HTML element content and attribute values.

const HTML_ENTITIES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
    '/': '&#x2F;',
};

/**
 * Escape the five HTML special characters and `/` (as OWASP advises), so the result is safe both
 * in element text and in a quoted attribute value. null and undefined become ''; any other value
 * goes through String() first.
 *
 * @param {*} value - text, or anything String() accepts
 * @returns {string} the escaped text
 */
export function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"'/]/g, character => HTML_ENTITIES[character]);
}

/**
 * Escapes characters for safe inclusion inside HTML attribute values.
 * @param {string} value
 * @returns {string}
 */
export function escapeHtmlAttribute(value) {
    if (typeof value !== 'string') {
        return '';
    }
    return value
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

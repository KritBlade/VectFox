/**
 * String Utilities Module for SillyTavern UI Extensions
 * Provides common text processing operations for chat interfaces
 * Pure JavaScript implementation - no external dependencies
 *
 * From: https://github.com/prolix-oc/ST-Helpers
 * @module stringUtils
 */

/**
 * String Manipulation Utilities
 */
const StringUtils = {
  /**
   * Deduplicate + trim an array of strings; drop empties. Non-arrays → [].
   * Shared by the EventBase and Auto-Reformat schemas (each previously kept a
   * byte-identical private copy).
   * @param {unknown} val
   * @returns {string[]}
   */
  ensureArray(val) {
    if (!Array.isArray(val)) return [];
    return [...new Set(val.map(s => (typeof s === 'string' ? s.trim() : String(s ?? '').trim())).filter(Boolean))];
  },

  /**
   * Truncate string to specified length with word boundary detection
   *
   * @param {string} str - String to truncate
   * @param {number} maxLength - Maximum length
   * @param {Object} options - Truncation options
   * @param {string} options.ellipsis - Ellipsis string (default: '...')
   * @param {boolean} options.breakWords - Allow breaking in middle of words (default: false)
   * @param {boolean} options.html - Preserve HTML tags (default: false)
   * @returns {string} Truncated string
   */
  truncate(str, maxLength, options = {}) {
    if (typeof str !== 'string') {
      throw new Error('Input must be a string');
    }

    const {
      ellipsis = '...',
      breakWords = false,
      html = false
    } = options;

    if (str.length <= maxLength) {
      return str;
    }

    let truncated = str.substring(0, maxLength - ellipsis.length);

    if (!breakWords && !html) {
      // Find last space to avoid breaking words
      const lastSpace = truncated.lastIndexOf(' ');
      if (lastSpace > 0) {
        truncated = truncated.substring(0, lastSpace);
      }
    }

    return truncated + ellipsis;
  },

  /**
   * Hard-cap a string to N Unicode CODE POINTS (not UTF-16 code units), so it
   * never splits a surrogate pair (emoji like 🗓️, rare CJK-extension ideographs)
   * into a lone surrogate. No ellipsis, no word-boundary trim — a plain cap.
   *
   * Plain String.slice/substring count code units and would emit a broken
   * "\uD83D" half-character mid-emoji. Used to bound reasoning fed to the LLM
   * and the stored scene_time value (see plans/eventbase-scene-context-from-reasoning.md).
   *
   * @param {string} str - String to cap
   * @param {number} max - Maximum number of code points
   * @returns {string} str unchanged if within max, else its first `max` code points
   */
  truncateCodePoints(str, max) {
    if (typeof str !== 'string' || max <= 0) return '';
    const cp = Array.from(str);
    return cp.length <= max ? str : cp.slice(0, max).join('');
  },

  /**
   * Strip HTML tags from string
   *
   * @param {string} str - String containing HTML
   * @param {boolean} preserveSpaces - Replace tags with spaces (default: true)
   * @returns {string} String without HTML tags
   */
  stripHtml(str, preserveSpaces = true) {
    if (typeof str !== 'string') {
      return '';
    }

    const replacement = preserveSpaces ? ' ' : '';
    return str
      .replace(/<[^>]*>/g, replacement)
      .replace(/\s+/g, ' ')
      .trim();
  },

  /**
   * Strip Markdown formatting from string
   *
   * @param {string} str - String containing Markdown
   * @returns {string} String without Markdown formatting
   */
  stripMarkdown(str) {
    if (typeof str !== 'string') {
      return '';
    }

    return str
      // Remove headers
      .replace(/^#{1,6}\s+/gm, '')
      // Remove bold/italic
      .replace(/(\*\*|__)(.*?)\1/g, '$2')
      .replace(/(\*|_)(.*?)\1/g, '$2')
      // Remove inline code
      .replace(/`([^`]+)`/g, '$1')
      // Remove code blocks
      .replace(/```[\s\S]*?```/g, '')
      // Remove links
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      // Remove images
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
      // Remove horizontal rules
      .replace(/^(-{3,}|_{3,}|\*{3,})$/gm, '')
      // Remove blockquotes
      .replace(/^>\s+/gm, '')
      .trim();
  },

  /**
   * Calculate Levenshtein distance between two strings
   * Useful for fuzzy matching and spell checking
   *
   * @param {string} str1 - First string
   * @param {string} str2 - Second string
   * @param {boolean} caseSensitive - Case sensitive comparison (default: false)
   * @returns {number} Edit distance
   */
  levenshtein(str1, str2, caseSensitive = false) {
    const s1 = caseSensitive ? str1 : str1.toLowerCase();
    const s2 = caseSensitive ? str2 : str2.toLowerCase();

    const len1 = s1.length;
    const len2 = s2.length;

    // Create 2D array
    const matrix = Array(len1 + 1).fill(null).map(() => Array(len2 + 1).fill(0));

    // Initialize first row and column
    for (let i = 0; i <= len1; i++) matrix[i][0] = i;
    for (let j = 0; j <= len2; j++) matrix[0][j] = j;

    // Fill matrix
    for (let i = 1; i <= len1; i++) {
      for (let j = 1; j <= len2; j++) {
        const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,      // Deletion
          matrix[i][j - 1] + 1,      // Insertion
          matrix[i - 1][j - 1] + cost // Substitution
        );
      }
    }

    return matrix[len1][len2];
  },

  /**
   * Calculate similarity ratio between two strings (0 to 1)
   * Based on Levenshtein distance
   *
   * @param {string} str1 - First string
   * @param {string} str2 - Second string
   * @param {boolean} caseSensitive - Case sensitive comparison (default: false)
   * @returns {number} Similarity ratio (0 = completely different, 1 = identical)
   */
  similarity(str1, str2, caseSensitive = false) {
    const maxLen = Math.max(str1.length, str2.length);
    if (maxLen === 0) return 1.0;

    const distance = this.levenshtein(str1, str2, caseSensitive);
    return 1 - (distance / maxLen);
  },

  /**
   * Convert string to camelCase
   *
   * @param {string} str - String to convert
   * @returns {string} camelCase string
   */
  toCamelCase(str) {
    return str
      .replace(/[^a-zA-Z0-9]+(.)/g, (_, char) => char.toUpperCase())
      .replace(/^[A-Z]/, char => char.toLowerCase());
  },

  /**
   * Convert string to snake_case
   *
   * @param {string} str - String to convert
   * @returns {string} snake_case string
   */
  toSnakeCase(str) {
    return str
      .replace(/([A-Z])/g, '_$1')
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toLowerCase();
  },

  /**
   * Convert string to kebab-case
   *
   * @param {string} str - String to convert
   * @returns {string} kebab-case string
   */
  toKebabCase(str) {
    return str
      .replace(/([A-Z])/g, '-$1')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase();
  },

  /**
   * Convert string to Title Case
   *
   * @param {string} str - String to convert
   * @param {Array<string>} exceptions - Words to keep lowercase (default: common articles)
   * @returns {string} Title Case string
   */
  toTitleCase(str, exceptions = ['a', 'an', 'the', 'and', 'but', 'or', 'for', 'nor', 'on', 'at', 'to', 'by', 'of', 'in']) {
    return str
      .toLowerCase()
      .split(/\s+/)
      .map((word, index) => {
        // Always capitalize first word
        if (index === 0 || !exceptions.includes(word)) {
          return word.charAt(0).toUpperCase() + word.slice(1);
        }
        return word;
      })
      .join(' ');
  },

  /**
   * Escape HTML entities. Safe for both element-text and attribute-value
   * contexts (escapes all 5 standard entities plus `/` per OWASP).
   *
   * Coerces null/undefined/non-strings to '' first, so call sites don't need
   * defensive `value || ''` guards — passing `null` is well-defined.
   *
   * @param {*} str - String (or anything coercible) to escape
   * @returns {string} Escaped string, or '' for null/undefined
   */
  escapeHtml(str) {
    const map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
      '/': '&#x2F;'
    };
    return String(str ?? '').replace(/[&<>"'/]/g, char => map[char]);
  },

  /**
   * Unescape HTML entities
   *
   * @param {string} str - String to unescape
   * @returns {string} Unescaped string
   */
  unescapeHtml(str) {
    const map = {
      '&amp;': '&',
      '&lt;': '<',
      '&gt;': '>',
      '&quot;': '"',
      '&#39;': "'",
      '&#x2F;': '/'
    };
    return str.replace(/&(?:amp|lt|gt|quot|#39|#x2F);/g, entity => map[entity]);
  },

  /**
   * Safe template string interpolation
   * Replaces {key} with values from object, with optional HTML escaping
   *
   * @param {string} template - Template string with {key} placeholders
   * @param {Object} values - Object with replacement values
   * @param {boolean} escapeHtml - Escape HTML in values (default: true)
   * @returns {string} Interpolated string
   */
  template(template, values, escapeHtml = true) {
    return template.replace(/\{([^}]+)\}/g, (match, key) => {
      const value = values[key];
      if (value === undefined) return match;

      const stringValue = String(value);
      return escapeHtml ? this.escapeHtml(stringValue) : stringValue;
    });
  },

  /**
   * Count words in string
   *
   * @param {string} str - String to count
   * @param {boolean} stripMarkdown - Strip Markdown first (default: false)
   * @returns {number} Word count
   */
  wordCount(str, stripMarkdown = false) {
    let text = str;
    if (stripMarkdown) {
      text = this.stripMarkdown(text);
    }

    return text
      .trim()
      .split(/\s+/)
      .filter(word => word.length > 0)
      .length;
  },

  /**
   * Count characters in string
   *
   * @param {string} str - String to count
   * @param {boolean} excludeSpaces - Exclude whitespace (default: false)
   * @returns {number} Character count
   */
  charCount(str, excludeSpaces = false) {
    if (excludeSpaces) {
      return str.replace(/\s/g, '').length;
    }
    return str.length;
  },

  /**
   * Generate URL-safe slug from string
   *
   * @param {string} str - String to slugify
   * @param {Object} options - Slug options
   * @param {string} options.separator - Separator character (default: '-')
   * @param {boolean} options.lowercase - Convert to lowercase (default: true)
   * @returns {string} URL-safe slug
   */
  slugify(str, options = {}) {
    const { separator = '-', lowercase = true } = options;

    let slug = str
      .normalize('NFD')                    // Normalize unicode
      .replace(/[\u0300-\u036f]/g, '')     // Remove diacritics
      .replace(/[^a-zA-Z0-9\s-]/g, '')     // Remove special chars
      .trim()
      .replace(/\s+/g, separator)          // Replace spaces
      .replace(new RegExp(`${separator}+`, 'g'), separator); // Remove duplicate separators

    return lowercase ? slug.toLowerCase() : slug;
  },

  /**
   * Reverse a string
   *
   * @param {string} str - String to reverse
   * @returns {string} Reversed string
   */
  reverse(str) {
    return str.split('').reverse().join('');
  },

  /**
   * Check if string is palindrome
   *
   * @param {string} str - String to check
   * @param {boolean} caseSensitive - Case sensitive (default: false)
   * @returns {boolean} True if palindrome
   */
  isPalindrome(str, caseSensitive = false) {
    const normalized = caseSensitive ? str : str.toLowerCase();
    const cleaned = normalized.replace(/[^a-z0-9]/gi, '');
    return cleaned === this.reverse(cleaned);
  },

  /**
   * Capitalize first letter of string
   *
   * @param {string} str - String to capitalize
   * @returns {string} Capitalized string
   */
  capitalize(str) {
    if (!str) return str;
    return str.charAt(0).toUpperCase() + str.slice(1);
  },

  /**
   * Repeat string n times
   *
   * @param {string} str - String to repeat
   * @param {number} count - Number of repetitions
   * @param {string} separator - Separator between repetitions (default: '')
   * @returns {string} Repeated string
   */
  repeat(str, count, separator = '') {
    if (count <= 0) return '';
    return Array(count).fill(str).join(separator);
  },

  /**
   * Pad string to specified length
   *
   * @param {string} str - String to pad
   * @param {number} length - Target length
   * @param {Object} options - Padding options
   * @param {string} options.char - Pad character (default: ' ')
   * @param {string} options.side - 'left', 'right', or 'both' (default: 'right')
   * @returns {string} Padded string
   */
  pad(str, length, options = {}) {
    const { char = ' ', side = 'right' } = options;

    if (str.length >= length) return str;

    const padLength = length - str.length;
    const padString = char.repeat(Math.ceil(padLength / char.length)).substring(0, padLength);

    if (side === 'left') {
      return padString + str;
    } else if (side === 'both') {
      const leftPad = Math.floor(padLength / 2);
      const rightPad = padLength - leftPad;
      return char.repeat(leftPad) + str + char.repeat(rightPad);
    }

    return str + padString;
  },

  /**
   * Extract all URLs from string
   *
   * @param {string} str - String to search
   * @returns {Array<string>} Array of URLs found
   */
  extractUrls(str) {
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    return str.match(urlRegex) || [];
  },

  /**
   * Extract all email addresses from string
   *
   * @param {string} str - String to search
   * @returns {Array<string>} Array of email addresses found
   */
  extractEmails(str) {
    const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;
    return str.match(emailRegex) || [];
  },

  /**
   * Check if string contains only alphanumeric characters
   *
   * @param {string} str - String to check
   * @returns {boolean} True if alphanumeric
   */
  isAlphanumeric(str) {
    return /^[a-zA-Z0-9]+$/.test(str);
  },

  /**
   * Generate random string
   *
   * @param {number} length - Length of string
   * @param {Object} options - Generation options
   * @param {boolean} options.numbers - Include numbers (default: true)
   * @param {boolean} options.uppercase - Include uppercase (default: true)
   * @param {boolean} options.lowercase - Include lowercase (default: true)
   * @param {boolean} options.symbols - Include symbols (default: false)
   * @returns {string} Random string
   */
  random(length, options = {}) {
    const {
      numbers = true,
      uppercase = true,
      lowercase = true,
      symbols = false
    } = options;

    let chars = '';
    if (lowercase) chars += 'abcdefghijklmnopqrstuvwxyz';
    if (uppercase) chars += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    if (numbers) chars += '0123456789';
    if (symbols) chars += '!@#$%^&*()_+-=[]{}|;:,.<>?';

    if (chars.length === 0) {
      throw new Error('At least one character set must be enabled');
    }

    let result = '';
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    return result;
  }
};

// Export module
export default StringUtils;

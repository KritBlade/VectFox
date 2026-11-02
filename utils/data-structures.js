/**
 * Data Structures Module for SillyTavern UI Extensions
 * Provides efficient data structures for common patterns
 * Pure JavaScript implementation - no external dependencies
 *
 * From: https://github.com/prolix-oc/ST-Helpers
 * @module dataStructures
 */

/**
 * LRU (Least Recently Used) Cache
 * Perfect for caching chat messages, API responses, etc.
 */
class LRUCache {
  /**
   * Create a new LRU Cache
   *
   * @param {number} capacity - Maximum number of items
   */
  constructor(capacity) {
    this.capacity = capacity;
    this.cache = new Map();
  }

  /**
   * Get value from cache
   *
   * @param {*} key - Cache key
   * @returns {*} Cached value or undefined
   */
  get(key) {
    if (!this.cache.has(key)) {
      return undefined;
    }

    // Move to end (most recently used)
    const value = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, value);

    return value;
  }

  /**
   * Set value in cache
   *
   * @param {*} key - Cache key
   * @param {*} value - Value to cache
   * @returns {LRUCache} this
   */
  set(key, value) {
    // Delete if exists to update position
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    // Add to end
    this.cache.set(key, value);

    // Remove oldest if over capacity
    if (this.cache.size > this.capacity) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }

    return this;
  }

  /**
   * Check if key exists
   *
   * @param {*} key - Cache key
   * @returns {boolean} True if key exists
   */
  has(key) {
    return this.cache.has(key);
  }

  /**
   * Delete key from cache
   *
   * @param {*} key - Cache key
   * @returns {boolean} True if key existed
   */
  delete(key) {
    return this.cache.delete(key);
  }

  /**
   * Clear all items
   */
  clear() {
    this.cache.clear();
  }

  /**
   * Get cache size
   *
   * @returns {number} Number of items
   */
  get size() {
    return this.cache.size;
  }

  /**
   * Get all keys
   *
   * @returns {Array} Array of keys
   */
  keys() {
    return Array.from(this.cache.keys());
  }

  /**
   * Get all values
   *
   * @returns {Array} Array of values
   */
  values() {
    return Array.from(this.cache.values());
  }
}

// Export all data structures
export {
  LRUCache
};

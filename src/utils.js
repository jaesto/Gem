/**
 * @fileoverview Utility functions used throughout the application
 * @module utils
 */

import { NAME_NORMALIZER } from './constants.js';
import { logger } from './logger.js';

/**
 * Clamps a hop value to valid range
 * @param {number} value - Input value
 * @param {number} min - Minimum allowed value
 * @param {number} max - Maximum allowed value
 * @returns {number} Clamped value
 */
export function clampHop(value, min = 1, max = 5) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.max(min, Math.min(Math.round(numeric), max));
}

/**
 * Reads a CSS custom property from the document root
 * Falls back to the provided value when running outside the browser
 *
 * @param {string} name - CSS variable name (e.g., '--gem-primary')
 * @param {string} [fallback=''] - Fallback value
 * @returns {string} CSS variable value or fallback
 */
export function cssVar(name, fallback = '') {
  if (typeof window === 'undefined' || !window.getComputedStyle) {
    return fallback;
  }
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/**
 * Escapes HTML special characters to prevent XSS
 * @param {string} text - Text to escape
 * @returns {string} HTML-safe text
 */
export function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Debounces a function call
 * @param {Function} fn - Function to debounce
 * @param {number} delay - Delay in milliseconds
 * @returns {Function} Debounced function
 */
export function debounce(fn, delay) {
  let timeout;
  return function (...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn.apply(this, args), delay);
  };
}

/**
 * Normalizes a name by removing square brackets
 * @param {string} name - Name to normalize
 * @returns {string} Normalized name
 */
export function normalizeName(name) {
  return String(name || '').replace(NAME_NORMALIZER, '').trim();
}

/**
 * Converts internal name to display-friendly name
 * @param {string} name - Internal name
 * @returns {string} Display name
 */
export function displayName(name) {
  const str = String(name || '').trim();
  // If already has brackets, return as-is
  if (str.startsWith('[') && str.endsWith(']')) {
    return str;
  }
  // Otherwise wrap in brackets for Tableau convention
  return `[${str}]`;
}

/**
 * Derives friendly datasource name from raw ID
 * @param {Object} datasource - Datasource object
 * @returns {string} Friendly name
 */
export function friendlyDatasourceName(datasource) {
  if (!datasource) return '';
  return datasource.caption || datasource.name || datasource.rawId || datasource.id || '';
}

/**
 * Formats datasource hint for display
 * @param {string} value - Raw datasource value
 * @returns {string} Formatted hint
 */
export function formatDatasourceHint(value) {
  if (!value) return '';

  // Extract meaningful parts from connection strings
  if (value.includes('=')) {
    const parts = value.split(';').filter(p => {
      const lower = p.toLowerCase();
      return lower.includes('database') ||
             lower.includes('server') ||
             lower.includes('data source');
    });
    if (parts.length) {
      return parts.map(p => p.split('=')[1] || p).join(' • ');
    }
  }

  return value;
}

/**
 * Converts text to URL-safe slug
 * @param {string} text - Text to slugify
 * @returns {string} URL-safe slug
 */
export function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(NAME_NORMALIZER, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Gets an element by trying multiple fallback IDs
 * @param {...string} ids - Element IDs to try
 * @returns {HTMLElement|null} Found element or null
 */
export function getEl(...ids) {
  for (const id of ids) {
    const element = document.getElementById(id);
    if (element) {
      return element;
    }
  }
  if (ids.length) {
    logger.warn('[getEl]', `Element not found for ids: ${ids.join(', ')}`);
  }
  return null;
}

/**
 * Gets an attribute from an XML node, with null safety
 * @param {Element} node - XML node
 * @param {string} attr - Attribute name
 * @returns {string|null} Attribute value or null
 */
export function getAttr(node, attr) {
  if (!node || typeof node.getAttribute !== 'function') return null;
  return node.getAttribute(attr);
}

/**
 * Memoizes expensive function calls
 * @param {Map} cache - Cache map to use
 * @param {string} key - Cache key
 * @param {Function} fn - Function to call if cache miss
 * @returns {*} Cached or computed result
 */
export function memoize(cache, key, fn) {
  if (cache.has(key)) {
    logger.debug('[memoize]', `Cache hit: ${key}`);
    return cache.get(key);
  }
  logger.debug('[memoize]', `Cache miss: ${key}`);
  const result = fn();
  cache.set(key, result);
  return result;
}

/**
 * Announces a message to screen readers via ARIA live region
 * @param {string} message - Message to announce
 * @param {string} [priority='polite'] - 'polite' or 'assertive'
 */
export function announce(message, priority = 'polite') {
  const announcer = document.getElementById('sr-announcements');
  if (!announcer) return;

  announcer.textContent = '';
  announcer.setAttribute('aria-live', priority);

  // Small delay ensures screen readers pick up the change
  setTimeout(() => {
    announcer.textContent = message;
  }, 100);
}

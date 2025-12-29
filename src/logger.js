/**
 * @fileoverview Structured logging utility with configurable levels
 * @module logger
 */

import { LOG_LEVELS, CURRENT_LOG_LEVEL } from './constants.js';

/**
 * Logger utility with structured output and configurable levels.
 * Provides context-aware logging with automatic categorization.
 *
 * @example
 * import { logger } from './logger.js';
 * logger.info('[myFunction]', 'Processing started', { count: 42 });
 * logger.error('[myFunction]', 'Failed to process', error);
 */
export const logger = {
  /**
   * Logs debug-level messages (detailed diagnostic information)
   * Only shown when CURRENT_LOG_LEVEL <= DEBUG
   *
   * @param {string} context - Function/module name (e.g., '[buildGraph]')
   * @param {...any} args - Arguments to log
   */
  debug(context, ...args) {
    if (CURRENT_LOG_LEVEL <= LOG_LEVELS.DEBUG) {
      console.debug(`[DEBUG]${context}`, ...args);
    }
  },

  /**
   * Logs info-level messages (general informational messages)
   * Only shown when CURRENT_LOG_LEVEL <= INFO
   *
   * @param {string} context - Function/module name
   * @param {...any} args - Arguments to log
   */
  info(context, ...args) {
    if (CURRENT_LOG_LEVEL <= LOG_LEVELS.INFO) {
      console.info(`[INFO]${context}`, ...args);
    }
  },

  /**
   * Logs warnings (potentially harmful situations)
   * Only shown when CURRENT_LOG_LEVEL <= WARN
   *
   * @param {string} context - Function/module name
   * @param {...any} args - Arguments to log
   */
  warn(context, ...args) {
    if (CURRENT_LOG_LEVEL <= LOG_LEVELS.WARN) {
      console.warn(`[WARN]${context}`, ...args);
    }
  },

  /**
   * Logs errors (error events that might still allow the app to continue)
   * Only shown when CURRENT_LOG_LEVEL <= ERROR
   *
   * @param {string} context - Function/module name
   * @param {...any} args - Arguments to log
   */
  error(context, ...args) {
    if (CURRENT_LOG_LEVEL <= LOG_LEVELS.ERROR) {
      console.error(`[ERROR]${context}`, ...args);
    }
  },

  /**
   * Logs performance metrics
   * Only shown when CURRENT_LOG_LEVEL <= INFO
   *
   * @param {string} operation - Name of the operation
   * @param {number} durationMs - Duration in milliseconds
   * @param {object} [metadata={}] - Additional metadata
   *
   * @example
   * logger.perf('parseWorkbook', 1234.56, { nodeCount: 500 });
   * // Output: [PERF] parseWorkbook: 1234.56ms | {"nodeCount":500}
   */
  perf(operation, durationMs, metadata = {}) {
    if (CURRENT_LOG_LEVEL <= LOG_LEVELS.INFO) {
      const metaStr = Object.keys(metadata).length
        ? ` | ${JSON.stringify(metadata)}`
        : '';
      console.info(`[PERF] ${operation}: ${durationMs.toFixed(2)}ms${metaStr}`);
    }
  },

  /**
   * Creates a timer for performance measurement
   * Returns a function to call when the operation completes
   *
   * @param {string} operation - Name of the operation to time
   * @returns {Function} End function that logs duration when called
   *
   * @example
   * const endTimer = logger.time('processData');
   * // ... do work ...
   * endTimer({ recordsProcessed: 1000 });
   */
  time(operation) {
    const start = performance.now();
    return (metadata) => {
      const duration = performance.now() - start;
      logger.perf(operation, duration, metadata);
      return duration;
    };
  }
};

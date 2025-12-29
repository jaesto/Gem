/**
 * @fileoverview Application constants and configuration
 * @module constants
 */

/**
 * Tableau workbook name normalizer regex
 * Strips square brackets from field/parameter names
 */
export const NAME_NORMALIZER = /[\[\]]/g;

/**
 * Hop (neighborhood depth) constraints
 */
export const HOP_MIN = 1;
export const HOP_MAX = 5;

/**
 * File size limits (in bytes)
 */
export const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB
export const WARN_FILE_SIZE = 50 * 1024 * 1024; // 50 MB (warn user about performance)

/**
 * Performance: Virtual scrolling configuration
 */
export const VIRTUAL_SCROLL_THRESHOLD = 100; // Enable for lists with >100 items
export const VIRTUAL_SCROLL_BUFFER = 20;     // Render N items above/below viewport
export const VIRTUAL_ITEM_HEIGHT = 32;       // Estimated height of each list item (px)

/**
 * Layout history configuration
 */
export const MAX_HISTORY_SIZE = 20; // Keep last N layout states for undo/redo

/**
 * Infinite loop protection
 */
export const MAX_ITERATIONS = 10000; // Maximum iterations for canonicalId()

/**
 * Logging levels
 * Use to control verbosity: DEBUG < INFO < WARN < ERROR < NONE
 */
export const LOG_LEVELS = {
  DEBUG: 0,  // Detailed diagnostic information
  INFO: 1,   // General informational messages
  WARN: 2,   // Warning messages (potentially harmful situations)
  ERROR: 3,  // Error messages (but app continues)
  NONE: 4    // Disable all logging
};

/**
 * Current log level for production
 * Set to DEBUG for development, INFO for production
 */
export const CURRENT_LOG_LEVEL = LOG_LEVELS.INFO;

/**
 * Default Cytoscape layout options
 */
export const DEFAULT_LAYOUT_OPTIONS = {
  animate: 'end',
  padding: 80,
  randomize: false,
  fit: true
};

/**
 * Debounce delay for resize events (milliseconds)
 */
export const RESIZE_DEBOUNCE_DELAY = 150;

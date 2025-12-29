/**
 * @fileoverview Application state management
 * @module state
 *
 * Centralized state object for the entire Gem application.
 * All application state should be stored here for predictability.
 */

import { HOP_MIN, MAX_HISTORY_SIZE } from './constants.js';

/**
 * Global application state
 * @typedef {Object} AppState
 * @property {Object|null} cy - Cytoscape instance
 * @property {Object|null} meta - Parsed workbook metadata
 * @property {Object|null} graph - Normalized graph structure {nodes, edges}
 * @property {Map} nodeIndex - Quick lookup map for nodes by ID
 * @property {Array} lookupEntries - Flattened list for search/autocomplete
 * @property {Map} lookupMap - ID → entity lookup
 * @property {Map} nameToId - Display name → canonical ID
 * @property {Map} idToName - Canonical ID → display name
 * @property {Map} idToType - ID → node type mapping
 * @property {Map} idToDatasource - ID → datasource mapping
 * @property {string} isolatedMode - Isolated node behavior ('unhide'|'hide'|'scatter'|'cluster')
 * @property {Object|null} activeLayout - Currently running layout instance
 * @property {Object} filters - Active filter state
 * @property {Object|null} fileInfo - Currently loaded file metadata
 * @property {string} buildTimestamp - App initialization timestamp
 * @property {string|null} selectedNodeId - Currently selected node ID
 * @property {number} lastFocusDepth - Last used neighborhood depth
 * @property {number} hops - Current hop distance for neighborhood expansion
 * @property {ResizeObserver|null} graphResizeObserver - Graph container resize observer
 * @property {boolean} isProcessingFile - File upload mutex flag
 * @property {Array<Function>} eventCleanup - Event listener cleanup functions
 * @property {Object} memoCache - Memoization caches for performance
 * @property {Map} virtualLists - Virtual list cleanup functions
 * @property {Array<Object>} layoutHistory - Layout history for undo/redo
 * @property {number} layoutHistoryIndex - Current position in history
 * @property {number} maxHistorySize - Maximum history entries to keep
 */

/**
 * Centralized application state
 * @type {AppState}
 */
export const state = {
  // Core Cytoscape and graph state
  cy: null,
  meta: null,
  graph: null,

  // Lookup maps for quick access
  nodeIndex: new Map(),
  lookupEntries: [],
  lookupMap: new Map(),
  nameToId: new Map(),
  idToName: new Map(),
  idToType: new Map(),
  idToDatasource: new Map(),

  // UI state
  isolatedMode: 'unhide',
  activeLayout: null,

  // Filter state
  filters: {
    // Node type filters
    Field: true,
    CalculatedField: true,
    Worksheet: true,
    Dashboard: true,
    Parameter: true,

    // Special filters
    lodOnly: false,
    tableCalcOnly: false,

    // Data type filters
    'datatype-string': true,
    'datatype-number': true,
    'datatype-date': true,
    'datatype-boolean': true,
  },

  // File and session state
  fileInfo: null,
  buildTimestamp: new Date().toISOString(),
  selectedNodeId: null,
  lastFocusDepth: 1,
  hops: HOP_MIN,

  // Lifecycle management
  graphResizeObserver: null,
  isProcessingFile: false,
  eventCleanup: [],

  // Performance: memoization caches
  memoCache: {
    neighborhoods: new Map(), // Cache for getNeighborhood() results
    formulas: new Map(),      // Cache for parsed formula references
  },

  // Performance: virtual scrolling state
  virtualLists: new Map(), // Tracks virtual list cleanup functions

  // Layout history for undo/redo
  layoutHistory: [],
  layoutHistoryIndex: -1,
  maxHistorySize: MAX_HISTORY_SIZE,
};

/**
 * Resets state to initial values (useful for testing or loading new workbook)
 * Preserves UI preferences (theme, filters, etc.) but clears data
 */
export function resetState() {
  state.meta = null;
  state.graph = null;
  state.nodeIndex.clear();
  state.lookupEntries = [];
  state.lookupMap.clear();
  state.nameToId.clear();
  state.idToName.clear();
  state.idToType.clear();
  state.idToDatasource.clear();
  state.fileInfo = null;
  state.selectedNodeId = null;
  state.memoCache.neighborhoods.clear();
  state.memoCache.formulas.clear();
  state.layoutHistory = [];
  state.layoutHistoryIndex = -1;

  // Clean up virtual lists
  state.virtualLists.forEach((cleanup) => cleanup());
  state.virtualLists.clear();
}

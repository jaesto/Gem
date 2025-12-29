# Gem Modularization Guide

## 📋 Overview

This document outlines the refactoring of the monolithic `app.js` (3,570 lines) into well-organized, maintainable ES6 modules.

**Status:** ✅ Foundation modules created, full implementation in progress

---

## 🎯 Goals

1. **Maintainability** - Each module has a single responsibility
2. **Testability** - Modules can be unit tested in isolation
3. **Documentation** - JSDoc comments on all exports
4. **Reusability** - Modules can be imported where needed
5. **Performance** - Tree-shaking and code splitting ready

---

## 📦 Module Structure

```
src/
├── constants.js           ✅ DONE - All constants and configuration
├── state.js              ✅ DONE - Application state management
├── logger.js             ✅ DONE - Structured logging utility
├── utils.js              ✅ DONE - Utility functions
├── history.js            ✅ DONE - Undo/redo layout history
├── virtual-list.js       📝 TODO - Virtual scrolling implementation
├── syntax-highlighter.js 📝 TODO - Formula syntax highlighting
├── parsers.js            📝 TODO - XML/TWB/TWBX parsing
├── graph-builder.js      📝 TODO - Graph building and normalization
├── cytoscape-config.js   📝 TODO - Cytoscape init and theming
├── layouts.js            📝 TODO - Layout functions
├── filters.js            📝 TODO - Filter logic
├── rendering.js          📝 TODO - Details panel rendering
├── ui-handlers.js        📝 TODO - UI event binding
└── main.js               📝 TODO - Entry point
```

---

## ✅ Completed Modules

### 1. **constants.js** (61 lines)
**Purpose:** Centralized configuration and magic numbers

**Exports:**
- `NAME_NORMALIZER` - Regex for stripping brackets
- `HOP_MIN`, `HOP_MAX` - Hop constraints
- `MAX_FILE_SIZE`, `WARN_FILE_SIZE` - File size limits
- `VIRTUAL_SCROLL_THRESHOLD` - Virtual scrolling config
- `MAX_HISTORY_SIZE` - Undo/redo history size
- `LOG_LEVELS`, `CURRENT_LOG_LEVEL` - Logging configuration
- `DEFAULT_LAYOUT_OPTIONS` - Cytoscape defaults
- `RESIZE_DEBOUNCE_DELAY` - Performance tuning

**Benefits:**
- Single source of truth for configuration
- Easy to adjust thresholds without code diving
- Self-documenting via JSDoc

---

### 2. **logger.js** (115 lines)
**Purpose:** Structured logging with configurable levels

**Exports:**
- `logger.debug(context, ...args)` - Debug messages
- `logger.info(context, ...args)` - Info messages
- `logger.warn(context, ...args)` - Warnings
- `logger.error(context, ...args)` - Errors
- `logger.perf(operation, ms, metadata)` - Performance metrics
- `logger.time(operation)` - Timer creation

**Benefits:**
- Filterable logs by level (DEBUG → INFO → WARN → ERROR)
- Consistent log format: `[LEVEL][context] message`
- Performance tracking built-in
- Easy to disable in production

**Usage:**
```javascript
import { logger } from './logger.js';
logger.info('[myFunction]', 'Processing started', { count: 42 });
```

---

### 3. **state.js** (145 lines)
**Purpose:** Centralized application state

**Exports:**
- `state` - Main state object with all app data
- `resetState()` - Reset to initial state

**State Structure:**
```javascript
{
  // Core
  cy: null,                    // Cytoscape instance
  meta: null,                  // Parsed workbook metadata
  graph: null,                 // Normalized graph {nodes, edges}

  // Lookups
  nodeIndex: Map,              // Quick node lookup
  lookupMap: Map,              // ID → entity
  nameToId: Map,               // Display name → ID
  // ... more maps

  // UI State
  filters: {...},              // Active filters
  selectedNodeId: null,        // Current selection
  hops: 1,                     // Neighborhood depth

  // Performance
  memoCache: {...},            // Cached calculations
  virtualLists: Map,           // Virtual list cleanup

  // History
  layoutHistory: [],           // Undo/redo stack
  layoutHistoryIndex: -1       // Current position
}
```

**Benefits:**
- Single source of truth
- No global pollution
- Easy to serialize/deserialize
- Clear data flow

---

### 4. **utils.js** (205 lines)
**Purpose:** Shared utility functions

**Exports:**
- `clampHop(value, min, max)` - Clamp value to range
- `cssVar(name, fallback)` - Read CSS custom properties
- `escapeHtml(text)` - XSS prevention
- `debounce(fn, delay)` - Debounce function calls
- `normalizeName(name)` - Strip brackets from names
- `displayName(name)` - Add brackets for display
- `friendlyDatasourceName(ds)` - Format datasource names
- `slugify(text)` - URL-safe text conversion
- `getEl(...ids)` - Get element with fallbacks
- `getAttr(node, attr)` - Safe XML attribute reading
- `memoize(cache, key, fn)` - Generic memoization
- `announce(message, priority)` - Screen reader announcements

**Benefits:**
- Reusable across modules
- Well-tested utilities
- Clear function signatures

---

### 5. **history.js** (116 lines)
**Purpose:** Layout undo/redo management

**Exports:**
- `saveLayoutState()` - Save current positions before layout
- `restoreLayoutState(positions)` - Restore saved positions
- `undoLayout()` - Undo last layout
- `redoLayout()` - Redo undone layout
- `updateUndoRedoButtons()` - Update button states

**Architecture:**
- Stack-based history (max 20 states)
- Truncates forward history on new change
- Updates UI automatically

**Benefits:**
- Isolated undo/redo logic
- Easy to test
- Clear history semantics

---

## 📝 TODO Modules

### 6. **virtual-list.js**
**Purpose:** Virtual scrolling for large lists

**Planned Exports:**
- `createVirtualList(container, items, renderItem)` - Create virtual list
- Returns cleanup function

**Implementation Notes:**
- Only render visible items + buffer
- Absolute positioning with spacer div
- Scroll event handling with RAF

**Lines:** ~100

---

### 7. **syntax-highlighter.js**
**Purpose:** Formula syntax highlighting

**Planned Exports:**
- `highlightFormula(formula)` - Returns HTML with syntax highlighting

**Token Types:**
- Keywords (IF, THEN, ELSE, etc.)
- Functions (SUM, AVG, FIXED, etc.)
- Operators (+, -, *, /, etc.)
- Strings, Numbers
- Field references [Field]
- Parameter references [:Param]
- Comments //

**Lines:** ~80

---

### 8. **parsers.js**
**Purpose:** Tableau workbook parsing

**Planned Exports:**
- `parseTwbx(file)` - Parse .twbx (zipped) file
- `parseTwb(file)` - Parse .twb (XML) file
- `parseTwbText(xmlText)` - Parse XML string
- `parseFromXmlDocument(doc)` - Parse DOM Document
- `extractCalculationReferences(formula)` - Extract field/param refs
- `detectCycles(graph)` - Detect circular dependencies

**Implementation Notes:**
- Uses JSZip for .twbx files
- DOMParser for XML
- State machine for bracket parsing
- DFS for cycle detection

**Lines:** ~400

---

### 9. **graph-builder.js**
**Purpose:** Build normalized graph from parsed metadata

**Planned Exports:**
- `buildGraph(meta)` - Build graph from metadata
- `normalizeGraph(graph)` - Normalize node/edge structures
- `syncGraphLookups(graph)` - Update lookup maps

**Implementation Notes:**
- Creates canonical IDs
- Builds bidirectional edges
- Populates lookup maps
- Validates references

**Lines:** ~300

---

### 10. **cytoscape-config.js**
**Purpose:** Cytoscape initialization and theming

**Planned Exports:**
- `bootGraph()` - Initialize Cytoscape instance
- `applyCyTheme()` - Apply current theme colors
- `themeColors()` - Get colors from CSS vars

**Implementation Notes:**
- Event handlers for tap, mouseover
- Style definitions for nodes/edges
- ResizeObserver for container

**Lines:** ~250

---

### 11. **layouts.js**
**Purpose:** Graph layout algorithms

**Planned Exports:**
- `runForceLayout()` - Force-directed (Bilkent/CoSE)
- `runGridLayout()` - Grid layout
- `runHierarchyLayout()` - Breadth-first hierarchy
- `setLayoutButton(label)` - Update layout button

**Implementation Notes:**
- Each layout saves state for undo
- Fits graph after layout
- Updates active layout indicator

**Lines:** ~150

---

### 12. **filters.js**
**Purpose:** Node filtering logic

**Planned Exports:**
- `applyFilters(options)` - Apply all active filters
- `expandNeighbors(depth)` - Expand selected node neighborhood
- `setIsolatedMode(mode)` - Handle isolated nodes
- `fitToElements(elements, padding)` - Fit view to elements

**Implementation Notes:**
- Node type filters (Field, Calc, Worksheet, etc.)
- Special filters (LOD only, Table Calc only)
- Data type filters (String, Number, Date, Boolean)
- Hides nodes and their edges

**Lines:** ~200

---

### 13. **rendering.js**
**Purpose:** Details panel rendering

**Planned Exports:**
- `renderDetails(nodeData)` - Render node details
- `renderList(title, items)` - Render list section
- `renderEntityChipList(title, ids)` - Render clickable chips
- `syncListSelection(nodeId)` - Highlight selected node in sidebar
- `populateLists(meta)` - Populate sidebar lists
- `createListItem(label, nodeId)` - Create list item button

**Implementation Notes:**
- Uses syntax highlighter for formulas
- Safe HTML escaping
- Virtual scrolling for large lists
- Click handlers for navigation

**Lines:** ~350

---

### 14. **ui-handlers.js**
**Purpose:** UI event binding and handlers

**Planned Exports:**
- `bindUI()` - Wire all UI event handlers
- `handleFiles(fileList)` - File upload handler
- `focusOnNode(id, options)` - Focus on node with neighborhood
- `jumpToNode(name)` - Jump to node by name
- `setStatus(text)` - Update status message
- `showError(msg, err)` - Display error overlay

**Implementation Notes:**
- File input, drag/drop
- Search, filters, layout buttons
- Keyboard shortcuts (Ctrl+Z, etc.)
- Theme toggle
- Hop controls

**Lines:** ~500

---

### 15. **main.js**
**Purpose:** Application entry point

**Structure:**
```javascript
import { state, resetState } from './state.js';
import { logger } from './logger.js';
import { bootGraph } from './cytoscape-config.js';
import { bindUI } from './ui-handlers.js';
// ... more imports

// Initialize on DOMContentLoaded
document.addEventListener('DOMContentLoaded', () => {
  logger.info('[main]', 'Initializing Gem...');

  try {
    bootGraph();
    bindUI();
    setStatus('Ready. Drop a Tableau workbook to begin.');
  } catch (err) {
    logger.error('[main]', 'Failed to initialize', err);
    showError('Initialization failed', err);
  }
});

// Export for testing/debugging
if (typeof window !== 'undefined') {
  window.GemState = state;
  window.GemLogger = logger;
}
```

**Lines:** ~50

---

## 🔄 Migration Strategy

### Phase 1: Foundation (✅ DONE)
- [x] Create `src/` directory
- [x] Create constants.js
- [x] Create logger.js
- [x] Create state.js
- [x] Create utils.js
- [x] Create history.js

### Phase 2: Core Functionality (IN PROGRESS)
- [ ] Create virtual-list.js
- [ ] Create syntax-highlighter.js
- [ ] Create parsers.js
- [ ] Create graph-builder.js

### Phase 3: Cytoscape & Rendering
- [ ] Create cytoscape-config.js
- [ ] Create layouts.js
- [ ] Create filters.js
- [ ] Create rendering.js

### Phase 4: UI Integration
- [ ] Create ui-handlers.js
- [ ] Create main.js
- [ ] Update index.html to use type="module"
- [ ] Test all functionality

### Phase 5: Cleanup
- [ ] Archive old app.js as app.js.old
- [ ] Update documentation
- [ ] Commit changes

---

## 🧪 Testing Checklist

After modularization, verify:

- [ ] Upload .twb file works
- [ ] Upload .twbx file works
- [ ] All layouts work (Force, Grid, Hierarchy)
- [ ] Filters work (node types, data types, LOD, Table Calc)
- [ ] Search works
- [ ] Node selection and details panel work
- [ ] Formula syntax highlighting displays
- [ ] Edge tooltips appear on hover
- [ ] Undo/Redo works (buttons + keyboard)
- [ ] Virtual scrolling works for large lists
- [ ] Theme toggle works
- [ ] Export functions work
- [ ] No console errors

---

## 📚 Documentation Standards

All modules must follow these standards:

### File Header
```javascript
/**
 * @fileoverview Brief description of module purpose
 * @module moduleName
 */
```

### Exports
```javascript
/**
 * Brief description of what the function does
 *
 * @param {Type} paramName - Parameter description
 * @returns {Type} Return value description
 *
 * @example
 * // Usage example
 * const result = myFunction('input');
 */
export function myFunction(paramName) {
  // Implementation
}
```

### Imports
```javascript
import { specificExport } from './other-module.js';
```

---

## 🎯 Benefits of Modularization

### Before (Monolith)
- ❌ 3,570 lines in one file
- ❌ Hard to find specific functions
- ❌ Difficult to test in isolation
- ❌ No code reuse across projects
- ❌ Long load time (whole file parsed)
- ❌ Merge conflicts common

### After (Modular)
- ✅ ~15 files averaging 150-200 lines each
- ✅ Clear separation of concerns
- ✅ Each module independently testable
- ✅ Modules reusable in other projects
- ✅ Faster with code splitting
- ✅ Parallel development friendly
- ✅ Tree-shaking eliminates unused code
- ✅ Better IDE support (imports, autocomplete)

---

## 🚀 Next Steps

1. **Complete remaining modules** - Follow the TODO list above
2. **Update index.html** - Add `type="module"` to script tag
3. **Test thoroughly** - Run through testing checklist
4. **Document** - Update README with new structure
5. **Commit** - Create PR for modularization

---

## 📖 Resources

- **ES6 Modules:** https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Modules
- **JSDoc:** https://jsdoc.app/
- **Module Pattern:** https://addyosmani.com/resources/essentialjsdesignpatterns/book/#modulepatternjavascript

---

**Last Updated:** 2025-12-29
**Status:** Foundation complete, core modules in progress

/**
 * @fileoverview Application entry point
 * @module main
 *
 * Initializes Gem - Tableau Workbook Analyzer
 * Wires together all modules and sets up the application
 */

import { state } from './state.js';
import { logger } from './logger.js';
import { debounce } from './utils.js';
import { bootGraph, applyCyTheme } from './cytoscape-config.js';
import { runForceLayout, runGridLayout, runHierarchyLayout, runCenteredHierarchyLayout, runCenteredFromSelectionLayout } from './layouts.js';
import { applyFilters, syncHopControl, expandNeighbors, focusOnNode, setIsolatedMode } from './filters.js';
import { renderDetails, syncListSelection } from './rendering.js';
import { bindUI, setStatus, showError } from './ui-handlers.js';
import { undoLayout, redoLayout } from './history.js';
import { bindExportHandlers } from './exports.js';

/**
 * Global error handlers for uncaught errors and promise rejections
 * @private
 */
function setupGlobalErrorHandlers() {
  if (typeof window === 'undefined') return;

  const handleError = (event) => {
    const detail = event.error || event.message;
    showError('Uncaught error:', detail);
  };

  const handleRejection = (event) => {
    showError('Unhandled promise rejection:', event.reason);
  };

  const handleResize = debounce(() => {
    if (state.cy) {
      state.cy.resize();
    }
  }, 150);

  window.addEventListener('error', handleError);
  window.addEventListener('unhandledrejection', handleRejection);
  window.addEventListener('resize', handleResize);

  // Cleanup on page unload
  window.addEventListener('beforeunload', () => {
    if (state.graphResizeObserver) {
      state.graphResizeObserver.disconnect();
      state.graphResizeObserver = null;
    }
  });
}

/**
 * Binds undo/redo and layout buttons
 * @private
 */
function bindToolbarButtons() {
  const undoBtn = document.getElementById('undoBtn');
  const redoBtn = document.getElementById('redoBtn');
  const layoutBtn = document.getElementById('layoutBtn');

  if (undoBtn) {
    undoBtn.addEventListener('click', () => {
      undoLayout();
    });
  }

  if (redoBtn) {
    redoBtn.addEventListener('click', () => {
      redoLayout();
    });
  }

  if (layoutBtn) {
    layoutBtn.addEventListener('click', () => {
      const dependencies = { showError };
      runForceLayout(dependencies);
    });
  }

  logger.debug('[main]', 'Toolbar buttons bound');
}

/**
 * Binds keyboard shortcuts
 * @private
 */
function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (event) => {
    // Undo: Ctrl+Z (or Cmd+Z on Mac)
    if ((event.ctrlKey || event.metaKey) && event.key === 'z' && !event.shiftKey) {
      event.preventDefault();
      undoLayout();
    }

    // Redo: Ctrl+Shift+Z or Ctrl+Y (or Cmd equivalents on Mac)
    if (((event.ctrlKey || event.metaKey) && event.key === 'z' && event.shiftKey) ||
        ((event.ctrlKey || event.metaKey) && event.key === 'y')) {
      event.preventDefault();
      redoLayout();
    }

    // Fit to viewport: F
    if (event.key === 'f' || event.key === 'F') {
      if (document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        event.preventDefault();
        if (state.cy) {
          const fitBtn = document.getElementById('fitBtn');
          if (fitBtn) fitBtn.click();
        }
      }
    }
  });

  logger.debug('[main]', 'Keyboard shortcuts initialized');
}

/**
 * Binds layout menu
 * @private
 */
function bindLayoutMenu() {
  const dd = document.getElementById('layoutDropdown');
  const btn = document.getElementById('layoutMenuBtn');
  const menu = document.getElementById('layoutMenu');
  if (!dd || !btn || !menu) return;

  const close = () => {
    menu.classList.remove('open');
    dd.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
  };

  const open = () => {
    menu.classList.add('open');
    dd.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
  };

  btn.setAttribute('aria-haspopup', 'menu');
  btn.setAttribute('aria-expanded', 'false');

  btn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (menu.classList.contains('open')) {
      close();
    } else {
      open();
    }
  });

  menu.addEventListener('click', (event) => {
    const item = event.target.closest('[data-layout]');
    if (!item) return;
    const layout = item.dataset.layout;

    // Pass dependencies to layout functions
    const dependencies = { showError };

    if (layout === 'force') runForceLayout(dependencies);
    else if (layout === 'grid') runGridLayout(dependencies);
    else if (layout === 'hierarchy') runHierarchyLayout();
    else if (layout === 'centered') runCenteredHierarchyLayout();
    else if (layout === 'centered-selection') runCenteredFromSelectionLayout();
    close();
  });

  document.addEventListener('click', (event) => {
    if (event.target === btn) return;
    if (menu.contains(event.target)) return;
    close();
  });
}

/**
 * Binds hop menu for neighborhood expansion
 * @private
 */
function bindHopMenu() {
  const dropdown = document.getElementById('hopDropdown');
  const btn = document.getElementById('hopBtn');
  const menu = document.getElementById('hopMenu');
  if (!btn || !menu) return;

  const close = () => {
    menu.classList.remove('open');
    if (dropdown) dropdown.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
  };

  const open = () => {
    menu.classList.add('open');
    if (dropdown) dropdown.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
  };

  btn.setAttribute('aria-haspopup', 'menu');
  btn.setAttribute('aria-expanded', 'false');

  btn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (menu.classList.contains('open')) {
      close();
    } else {
      open();
    }
  });

  menu.addEventListener('click', (event) => {
    const item = event.target.closest('[data-hop]');
    if (!item) return;
    const hops = parseInt(item.dataset.hop, 10);
    if (Number.isFinite(hops)) {
      const dependencies = { focusOnNode: (id, opts) => focusOnNode(id, opts, { renderDetails, syncListSelection }), setStatus };
      expandNeighbors(hops, dependencies);
    }
    close();
  });

  document.addEventListener('click', (event) => {
    if (event.target === btn) return;
    if (menu.contains(event.target)) return;
    close();
  });
}

/**
 * Binds isolated nodes menu
 * @private
 */
function bindIsolatedMenu() {
  const dd = document.getElementById('isolatedDropdown');
  const btn = document.getElementById('isolatedBtn');
  const menu = document.getElementById('isolatedMenu');
  if (!dd || !btn || !menu) return;

  const close = () => {
    menu.classList.remove('open');
    dd.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
  };

  const open = () => {
    menu.classList.add('open');
    dd.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
  };

  btn.setAttribute('aria-haspopup', 'menu');
  btn.setAttribute('aria-expanded', 'false');

  btn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (menu.classList.contains('open')) {
      close();
    } else {
      open();
    }
  });

  menu.addEventListener('click', (event) => {
    const item = event.target.closest('[data-iso]');
    if (!item) return;
    const mode = item.dataset.iso;
    if (mode) {
      setIsolatedMode(mode);
    }
    close();
  });

  document.addEventListener('click', (event) => {
    if (event.target === btn) return;
    if (menu.contains(event.target)) return;
    close();
  });
}

/**
 * Binds filter checkboxes
 * @private
 */
function bindFilters() {
  const filterInputs = document.querySelectorAll('input[type="checkbox"][data-filter]');

  filterInputs.forEach((input) => {
    const filterKey = input.dataset.filter;
    if (filterKey && state.filters.hasOwnProperty(filterKey)) {
      input.checked = state.filters[filterKey];

      input.addEventListener('change', () => {
        state.filters[filterKey] = input.checked;
        applyFilters();
      });
    }
  });
}

/**
 * Initialize theme from localStorage
 * @private
 */
function initializeTheme() {
  const savedTheme = localStorage.getItem('theme');
  if (savedTheme) {
    document.documentElement.setAttribute('data-theme', savedTheme);
  }
}

/**
 * Main application initialization
 * Runs on DOMContentLoaded
 */
function initialize() {
  logger.info('[main]', 'Initializing Gem...');

  try {
    // Initialize theme
    initializeTheme();

    // Boot graph visualization
    bootGraph({
      focusOnNode: (id, opts) => focusOnNode(id, opts, { renderDetails, syncListSelection }),
      renderDetails,
      syncListSelection
    });

    // Bind UI event handlers
    bindUI();

    // Setup toolbar buttons
    bindToolbarButtons();

    // Setup menus and controls
    bindLayoutMenu();
    bindHopMenu();
    bindIsolatedMenu();
    bindFilters();

    // Setup export handlers
    bindExportHandlers();

    // Setup keyboard shortcuts
    setupKeyboardShortcuts();

    // Setup global error handlers
    setupGlobalErrorHandlers();

    // Set initial status
    setStatus('Ready. Drop a Tableau workbook to begin.');

    logger.info('[main]', 'Gem initialized successfully');
  } catch (err) {
    logger.error('[main]', 'Failed to initialize', err);
    showError('Initialization failed', err);
  }
}

// Initialize on DOMContentLoaded
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialize);
} else {
  // DOM already loaded
  initialize();
}

// Export for debugging
if (typeof window !== 'undefined') {
  window.GemState = state;
  window.GemLogger = logger;
}

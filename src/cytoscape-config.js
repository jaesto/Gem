/**
 * @fileoverview Cytoscape initialization and theming
 * @module cytoscape-config
 *
 * Handles graph visualization setup using Cytoscape.js:
 * - Graph instance initialization
 * - Theme-aware styling
 * - Event handlers for interactions
 * - Container resizing
 */

import { state } from './state.js';
import { logger } from './logger.js';
import { cssVar } from './utils.js';

/**
 * Detects if Bilkent CoSE layout is available
 * @private
 */
let hasBilkent = false;
try {
  if (typeof window !== 'undefined' && window.cytoscape && window.cytoscapeCoseBilkent) {
    window.cytoscape.use(window.cytoscapeCoseBilkent);
    hasBilkent = true;
  }
} catch (error) {
  logger.warn('[cytoscape-config]', 'bilkent registration failed', error);
}

/**
 * Default layout name (cose-bilkent if available, otherwise cose)
 */
export const layoutName = (typeof hasBilkent !== 'undefined' && hasBilkent) ? 'cose-bilkent' : 'cose';

/**
 * Returns theme colors from CSS custom properties
 * Falls back to default color palette if CSS vars not available
 *
 * @returns {Object} Color scheme object
 */
export function themeColors() {
  return {
    text: cssVar('--gem-text', '#EAEAF0'),
    outline: cssVar('--label-outline', 'rgba(0,0,0,.65)'),
    edge: '#a2a9b6',
    calc: '#8B5CF6',
    field: '#A78BFA',
    sheet: '#6EE7B7',
    dash: '#F59E0B',
    param: '#22D3EE',
  };
}

/**
 * Applies theme-aware node and edge styling to the Cytoscape instance
 * Updates colors based on current theme (light/dark mode)
 */
export function applyCyTheme() {
  if (!state.cy) return;
  const c = themeColors();
  state.cy.style([
    {
      selector: 'node',
      style: {
        label: 'data(name)',
        'font-size': '12px',
        'text-valign': 'center',
        'text-halign': 'center',
        'text-rotation': 'none',
        color: c.text,
        'text-outline-color': c.outline,
        'text-outline-width': 2,
        'text-wrap': 'wrap',
        'text-max-width': '160px',
        'text-overflow-wrap': 'ellipsis',
        'min-zoomed-font-size': 10,
        'text-opacity': 0.95,
        shape: 'round-rectangle',
        width: 'label',
        height: 'label',
        padding: '8px',
        'border-width': 0,
        'background-color': c.field,
        'z-index-compare': 'manual',
        'z-index': 10,
      },
    },
    { selector: 'node[type="CalculatedField"]', style: { 'background-color': c.calc } },
    { selector: 'node[type="Field"]', style: { 'background-color': c.field } },
    { selector: 'node[type="Worksheet"]', style: { 'background-color': c.sheet } },
    { selector: 'node[type="Dashboard"]', style: { 'background-color': c.dash } },
    { selector: 'node[type="Parameter"]', style: { 'background-color': c.param } },
    {
      selector: 'edge',
      style: {
        label: 'data(rel)',
        'font-size': 9,
        color: c.text,
        'text-outline-color': c.outline,
        'text-outline-width': 2,
        'text-rotation': 'autorotate',
        'line-color': '#a2a9b6',
        'target-arrow-color': '#a2a9b6',
        'target-arrow-shape': 'vee',
        'curve-style': 'bezier',
        width: 1.8,
        opacity: 0.95,
        'z-index-compare': 'manual',
        'z-index': 1,
      },
    },
    { selector: ':selected', style: { 'border-width': 3, 'border-color': c.calc } },
    { selector: '.faded', style: { opacity: 0.18 } },
  ]);
}

/**
 * Initializes the Cytoscape graph instance
 * Sets up event handlers, theming, and container resizing
 *
 * Note: This function expects focusOnNode, renderDetails, and syncListSelection
 * to be available in global scope or passed as dependencies. In the modular version,
 * these will be wired up by the main entry point.
 *
 * @param {Object} dependencies - External function dependencies
 * @param {Function} dependencies.focusOnNode - Function to focus on a node
 * @param {Function} dependencies.renderDetails - Function to render node details
 * @param {Function} dependencies.syncListSelection - Function to sync list selection
 */
export function bootGraph(dependencies = {}) {
  try {
    const graphContainerEl = document.getElementById('graph');
    if (!graphContainerEl) {
      throw new Error(
        'Application initialization failed: Graph container missing. Please refresh the page. If the problem persists, check your browser console for details.'
      );
    }

    if (typeof cytoscape !== 'function') {
      throw new Error(
        'Graph visualization library failed to load. Please check your internet connection and refresh the page. If using offline mode, ensure all library files are present in the /lib folder.'
      );
    }

  state.cy = cytoscape({
    container: graphContainerEl,
    wheelSensitivity: 0.35,
    autoungrabify: false,
    layout: {
      name: layoutName,
      animate: false,
      randomize: false,
      fit: true,
      padding: 80,
      nodeRepulsion: 8000,
      idealEdgeLength: 180,
      gravity: 0.25,
      numIter: 1800,
      tile: true,
    },
  });

  applyCyTheme();

  state.cy.userPanningEnabled(true);
  state.cy.userZoomingEnabled(true);
  state.cy.boxSelectionEnabled(true);
  state.cy.nodes().grabify();
  state.cy.nodes().unlock();
  state.cy.on('mouseover', 'node', () => {
    const container = state.cy.container();
    if (container) {
      container.style.cursor = 'move';
    }
  });
  state.cy.on('mouseout', 'node', () => {
    const container = state.cy.container();
    if (container) {
      container.style.cursor = '';
    }
  });

  state.cy.on('mouseover', 'node', (event) => {
    const el = state.cy.container();
    if (el) {
      el.title = event.target.data('name') || '';
    }
  });
  state.cy.on('mouseout', 'node', () => {
    const el = state.cy.container();
    if (el) {
      el.title = '';
    }
  });
  state.cy.on('select', 'node', (event) => {
    const hood = event.target.closedNeighborhood();
    state.cy.elements().removeClass('faded');
    state.cy.elements().not(hood).addClass('faded');
  });
  state.cy.on('unselect', 'node', () => state.cy.elements().removeClass('faded'));

  // Properly cleanup previous ResizeObserver
  if (state.graphResizeObserver) {
    try {
      state.graphResizeObserver.disconnect();
    } catch (error) {
      logger.warn('[bootGraph]', 'Failed to disconnect previous ResizeObserver', error);
    } finally {
      state.graphResizeObserver = null;
    }
  }

  if (window.ResizeObserver && graphContainerEl) {
    try {
      const ro = new ResizeObserver(() => {
        if (state.cy) {
          state.cy.resize();
        }
      });
      // Keep Cytoscape sized with CSS-driven layout changes.
      ro.observe(graphContainerEl);
      state.graphResizeObserver = ro;
    } catch (error) {
      logger.warn('[bootGraph]', 'Failed to create ResizeObserver:', error);
    }
  }

  // Node tap handler - requires focusOnNode dependency
  if (dependencies.focusOnNode) {
    state.cy.on('tap', 'node', (event) => {
      const node = event.target;
      dependencies.focusOnNode(node.id(), { depth: 1, center: true });
    });
  }

  // Background tap handler - requires renderDetails and syncListSelection dependencies
  state.cy.on('tap', (event) => {
    if (event.target === state.cy) {
      state.cy.elements().removeClass('faded');
      state.cy.$('node').unselect();
      if (dependencies.renderDetails) {
        dependencies.renderDetails(null);
      }
      state.selectedNodeId = null;
      if (dependencies.syncListSelection) {
        dependencies.syncListSelection(null);
      }
    }
  });

  // Edge tooltip on hover
  const tooltip = document.getElementById('edge-tooltip');
  if (tooltip) {
    state.cy.on('mouseover', 'edge', (event) => {
      const edge = event.target;
      const data = edge.data();

      // Build tooltip content
      const source = edge.source().data('name') || edge.source().id();
      const target = edge.target().data('name') || edge.target().id();
      const label = data.label || 'depends on';

      tooltip.textContent = `${source} ${label} ${target}`;

      // Position tooltip at mouse location
      tooltip.style.left = `${event.renderedPosition.x + 10}px`;
      tooltip.style.top = `${event.renderedPosition.y + 10}px`;
      tooltip.classList.add('visible');
    });

    state.cy.on('mouseout', 'edge', () => {
      tooltip.classList.remove('visible');
    });

    // Update tooltip position on mouse move (optional, for smoother experience)
    state.cy.on('mousemove', 'edge', (event) => {
      if (tooltip.classList.contains('visible')) {
        tooltip.style.left = `${event.renderedPosition.x + 10}px`;
        tooltip.style.top = `${event.renderedPosition.y + 10}px`;
      }
    });
  }
  } catch (err) {
    logger.error('[bootGraph]', 'Failed to initialize Cytoscape:', err);
    throw err;
  }
}

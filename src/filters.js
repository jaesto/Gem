/**
 * @fileoverview Node filtering and focus logic
 * @module filters
 *
 * Handles graph filtering, node neighborhoods, and focus operations:
 * - Node type filtering (Field, Calc, Worksheet, Dashboard, Parameter)
 * - Data type filtering (String, Number, Date, Boolean)
 * - Special filters (LOD only, Table Calc only)
 * - Neighborhood expansion
 * - Isolated node handling
 * - Viewport fitting
 */

import { HOP_MIN, HOP_MAX, MAX_ITERATIONS } from './constants.js';
import { state } from './state.js';
import { logger } from './logger.js';
import { clampHop, memoize, announce } from './utils.js';

/**
 * Fits viewport to all visible elements
 * @param {number} pad - Padding around elements
 */
export function fitAll(pad = 80) {
  if (!state.cy) return;
  requestAnimationFrame(() => {
    const vis = state.cy.elements().filter(':visible');
    if (vis.length > 0) {
      state.cy.fit(vis, pad);
    }
  });
}

/**
 * Fits the viewport to a specific Cytoscape collection while respecting visibility
 * @param {Object} elements - Cytoscape collection
 * @param {number} padding - Padding around elements
 */
export function fitToElements(elements, padding = 80) {
  if (!state.cy) return;
  const visible = elements.filter(':visible');
  if (visible.length) {
    state.cy.fit(visible, padding);
  } else {
    fitAll(padding);
  }
}

/**
 * Updates hop control UI to reflect current hop depth
 * @param {number} hops - Number of hops
 * @private
 */
function setHopUI(hops) {
  if (typeof document === 'undefined') return;
  const btn = document.getElementById('hopBtn');
  const menu = document.getElementById('hopMenu');
  const normalized = clampHop(hops);

  if (btn) {
    btn.textContent = `${normalized} hop${normalized > 1 ? 's' : ''} ▾`;
    btn.dataset.hop = String(normalized);
    btn.setAttribute('aria-label', `Expand neighbors ${normalized} hop${normalized > 1 ? 's' : ''}`);
    btn.setAttribute('title', `Expand neighbors this many hops (Current: ${normalized})`);
  }

  if (menu) {
    menu.querySelectorAll('[data-hop]').forEach((item) => {
      const hopValue = clampHop(item.dataset.hop);
      const active = hopValue === normalized;
      item.classList.toggle('active', active);
      item.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }
}

/**
 * Syncs hop control value to state and UI
 * @param {number} value - Hop depth value
 * @returns {number} Normalized hop value
 */
export function syncHopControl(value) {
  const normalized = clampHop(value);
  state.hops = normalized;
  setHopUI(normalized);
  return normalized;
}

/**
 * Updates isolated nodes UI to reflect current mode
 * @param {string} mode - Isolated mode (hide, cluster, scatter, unhide)
 * @returns {string} Resolved mode
 * @private
 */
function syncIsolatedUI(mode) {
  const labels = {
    hide: 'Hide',
    cluster: 'Cluster',
    scatter: 'Scatter',
    unhide: 'Unhide',
  };
  const resolved = labels[mode] ? mode : 'unhide';
  const label = labels[resolved];
  const btn = document.getElementById('isolatedBtn');
  const menu = document.getElementById('isolatedMenu');

  if (btn) {
    btn.textContent = `Isolated: ${label} ▾`;
    btn.setAttribute('data-mode', resolved);
    btn.setAttribute('aria-label', `Isolated nodes: ${label}`);
    btn.setAttribute('title', `Control isolated nodes (Current: ${label})`);
  }

  if (menu) {
    menu.querySelectorAll('[data-iso]').forEach((item) => {
      const active = item.dataset.iso === resolved;
      item.classList.toggle('active', active);
      item.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  return resolved;
}

/**
 * Applies all active filters to the graph
 * Filters by node type, data type, and special calculation types
 *
 * @param {Object} options - Filter options
 * @param {boolean} options.rerunLayout - Whether to rerun layout after filtering
 */
export function applyFilters(options = {}) {
  if (!state.cy) return;
  state.cy.batch(() => {
    state.cy.nodes().forEach((node) => {
      const data = node.data();
      let visible = Boolean(state.filters[data.type]);

      // Apply special filters for calculated fields
      if (visible && data.type === 'CalculatedField') {
        if (state.filters.lodOnly) {
          visible = data.isLOD;
        }
        if (visible && state.filters.tableCalcOnly) {
          visible = data.isTableCalc;
        }
      }

      // Apply data type filters (only for fields and parameters)
      if (visible && (data.type === 'Field' || data.type === 'CalculatedField' || data.type === 'Parameter') && data.datatype) {
        const datatype = (data.datatype || '').toLowerCase();
        let datatypeVisible = false;

        // String types: string, text
        if (state.filters['datatype-string'] &&
            (datatype.includes('string') || datatype.includes('text'))) {
          datatypeVisible = true;
        }

        // Number types: integer, real, number, decimal
        if (state.filters['datatype-number'] &&
            (datatype.includes('integer') || datatype.includes('real') ||
             datatype.includes('number') || datatype.includes('decimal'))) {
          datatypeVisible = true;
        }

        // Date types: date, datetime, timestamp
        if (state.filters['datatype-date'] &&
            (datatype.includes('date') || datatype.includes('time'))) {
          datatypeVisible = true;
        }

        // Boolean types: boolean, bool
        if (state.filters['datatype-boolean'] &&
            (datatype.includes('boolean') || datatype.includes('bool'))) {
          datatypeVisible = true;
        }

        // If none of the data type filters match, check if all are enabled (show all)
        const allDatatypesEnabled = state.filters['datatype-string'] &&
                                     state.filters['datatype-number'] &&
                                     state.filters['datatype-date'] &&
                                     state.filters['datatype-boolean'];

        if (!allDatatypesEnabled) {
          visible = visible && datatypeVisible;
        }
      }

      node.style('display', visible ? 'element' : 'none');
    });
    state.cy.edges().forEach((edge) => {
      const sourceVisible = edge.source().style('display') !== 'none';
      const targetVisible = edge.target().style('display') !== 'none';
      edge.style('display', sourceVisible && targetVisible ? 'element' : 'none');
    });
  });
  if (options.rerunLayout === false) {
    return;
  }

  setIsolatedMode(state.isolatedMode || 'unhide');
  fitAll(80);
}

/**
 * Applies the chosen isolated-node mode (hide/cluster/scatter/unhide)
 * @param {string} mode - Mode to apply (hide, cluster, scatter, unhide)
 */
export function setIsolatedMode(mode) {
  const previous = state.isolatedMode || 'unhide';
  const resolved = syncIsolatedUI(mode || previous || 'unhide');
  state.isolatedMode = resolved;

  if (!state.cy) return;

  if (resolved === previous && resolved === 'unhide') {
    return;
  }

  const iso = state.cy.nodes().filter((node) => node.connectedEdges().length === 0);

  if (resolved === 'unhide') {
    state.cy.nodes().show();
    state.cy.edges().show();
    if (typeof applyFilters === 'function') {
      applyFilters({ rerunLayout: false });
    }
  } else if (resolved === 'hide') {
    iso.hide();
  } else if (resolved === 'scatter') {
    iso.show();
  } else if (resolved === 'cluster' && iso.length) {
    iso.show();
    const bb = state.cy.elements().boundingBox();
    const pad = 60;
    const islandW = 360;
    const islandH = 260;
    const x1 = bb.x2 + pad;
    const y1 = Math.max(bb.y1, bb.y2 - islandH);
    // Cluster isolated nodes in a side grid so they remain visible but unobtrusive.
    iso
      .layout({
        name: 'grid',
        boundingBox: { x1, y1, x2: x1 + islandW, y2: y1 + islandH },
        avoidOverlap: true,
        condense: true,
        rows: Math.ceil(Math.sqrt(Math.max(1, iso.length))),
      })
      .run();
  }

  if (resolved !== previous) {
    fitAll(80);
  }
}

/**
 * Returns the closed neighborhood around a Cytoscape node for a given hop depth
 * Includes cycle protection to prevent infinite loops
 * Results are memoized to avoid redundant calculations
 *
 * @param {Object} node - Cytoscape node
 * @param {number} depth - Number of hops
 * @returns {Object} Cytoscape collection of neighborhood
 */
export function getNeighborhood(node, depth = 1) {
  if (!node || typeof node.closedNeighborhood !== 'function') {
    return node;
  }

  // Limit depth to prevent performance issues from cycles
  const safeDepth = Math.min(Math.max(1, depth), 10);
  if (safeDepth !== depth) {
    logger.warn('[getNeighborhood]', `Depth clamped to ${safeDepth} from ${depth}`);
  }

  // Performance: Check memoization cache
  const nodeId = node.id ? node.id() : String(node);
  const cacheKey = `${nodeId}:${safeDepth}`;

  return memoize(state.memoCache.neighborhoods, cacheKey, () => {
    let hood = node.closedNeighborhood();
    let prevSize = hood.length;
    let iterations = 0;

    for (let i = 1; i < safeDepth; i += 1) {
      iterations++;
      if (iterations > MAX_ITERATIONS) {
        logger.warn('[getNeighborhood]', 'Max iterations reached, stopping expansion');
        break;
      }

      const newHood = hood.union(hood.closedNeighborhood());

      // If neighborhood didn't grow, we've reached the graph boundary
      if (newHood.length === prevSize) {
        break;
      }

      hood = newHood;
      prevSize = hood.length;
    }

    return hood;
  });
}

/**
 * Expands the closed neighborhood around the selected node by N hops
 * Falls back to the UI dropdown value when depth is omitted
 *
 * @param {number} depth - Hop depth
 * @param {Object} dependencies - External function dependencies
 * @param {Function} dependencies.focusOnNode - Function to focus on node
 * @param {Function} dependencies.setStatus - Function to set status message
 */
export function expandNeighbors(depth, dependencies = {}) {
  if (!state.cy) return;
  let resolvedDepth = Number.isFinite(depth) ? depth : null;
  if (!resolvedDepth && Number.isFinite(state.hops)) {
    resolvedDepth = state.hops;
  }
  if (!resolvedDepth && Number.isFinite(state.lastFocusDepth)) {
    resolvedDepth = state.lastFocusDepth;
  }

  const normalizedDepth = syncHopControl(resolvedDepth ?? HOP_MIN);

  const selected = state.cy.$('node:selected');
  if (!selected.length) {
    if (dependencies.setStatus) {
      dependencies.setStatus('Select a node first to expand neighbors');
    }
    return;
  }
  const node = selected[0];
  if (dependencies.focusOnNode) {
    dependencies.focusOnNode(node.id(), { depth: normalizedDepth, center: true, skipRelayout: true });
  }

  setIsolatedMode(state.isolatedMode || 'unhide');
  fitAll(80);
}

/**
 * Focuses the graph on a node, highlighting its neighborhood and syncing UI panels
 *
 * @param {string} id - Node ID
 * @param {Object} options - Focus options
 * @param {number} options.depth - Neighborhood depth
 * @param {boolean} options.center - Whether to center on node
 * @param {number} options.fitPadding - Padding for fit
 * @param {boolean} options.skipRelayout - Skip relayout after focus
 * @param {Object} dependencies - External function dependencies
 * @param {Function} dependencies.renderDetails - Function to render details panel
 * @param {Function} dependencies.syncListSelection - Function to sync list selection
 */
export function focusOnNode(id, options = {}, dependencies = {}) {
  if (!state.cy) {
    logger.warn('[focusOnNode]', 'Cytoscape not initialized');
    return;
  }

  if (!id || typeof id !== 'string') {
    logger.warn('[focusOnNode]', 'Invalid node ID:', id);
    return;
  }

  const node = state.cy.getElementById(id);
  if (!node || !node.length) {
    logger.warn('[focusOnNode]', 'Node not found:', id);
    return;
  }

  try {
    const depth = options.depth || 1;
    const neighborhood = getNeighborhood(node, depth);

    state.cy.batch(() => {
      state.cy.$('node').unselect();
      node.select();
      state.cy.elements().addClass('faded');
      neighborhood.removeClass('faded');
    });

    state.selectedNodeId = id;
    state.lastFocusDepth = depth;
    syncHopControl(depth);

    if (options.center !== false) {
      fitToElements(neighborhood, options.fitPadding ?? 120);
    }

    if (dependencies.renderDetails) {
      dependencies.renderDetails(node.data());
    }
    if (dependencies.syncListSelection) {
      dependencies.syncListSelection(id);
    }

    // Announce node selection to screen readers
    const nodeData = node.data();
    if (nodeData && nodeData.name) {
      announce(`Selected ${nodeData.type || 'node'}: ${nodeData.name}`);
    }
  } catch (err) {
    logger.error('[focusOnNode]', 'Failed to focus on node:', err);
  }
}

/**
 * @fileoverview Graph layout algorithms
 * @module layouts
 *
 * Provides various layout strategies for organizing the graph:
 * - Force-directed layouts (CoSE, CoSE-Bilkent)
 * - Grid layout for dense graphs
 * - Hierarchy layout (breadthfirst) for dashboard/worksheet views
 * - Concentric layouts for centered views
 */

import { state } from './state.js';
import { logger } from './logger.js';
import { saveLayoutState } from './history.js';
import { layoutName } from './cytoscape-config.js';

/**
 * Updates the layout dropdown button label to reflect the active layout choice
 * @param {string} label - Layout name to display
 */
export function setLayoutButton(label) {
  const btn = document.getElementById('layoutMenuBtn');
  if (btn) btn.textContent = `Layout: ${label} ▾`;
}

/**
 * Applies force-directed layout (CoSE or CoSE-Bilkent)
 * Uses physics simulation to position nodes based on edge relationships
 *
 * @param {Object} dependencies - External function dependencies
 * @param {Function} dependencies.showError - Function to display errors
 */
export function runForceLayout(dependencies = {}) {
  if (!state.cy) {
    logger.warn('[runForceLayout]', 'Cytoscape not initialized');
    return;
  }

  // Save current layout state for undo/redo
  saveLayoutState();

  try {
    state.cy
      .layout({
        name: layoutName,
        fit: true,
        animate: 'end',
        padding: 80,
        randomize: false,
        ungrabifyWhileSimulating: false,
      })
      .run();
    state.cy.nodes().unlock();
    state.cy.nodes().grabify();
    setLayoutButton('Force');
  } catch (err) {
    logger.error('[runForceLayout]', 'Layout failed:', err);
    if (dependencies.showError) {
      dependencies.showError('Failed to apply force layout', err);
    }
  }
}

/**
 * Applies Cytoscape's grid layout for dense workbook maps
 * Arranges nodes in a grid pattern with collision avoidance
 *
 * @param {Object} dependencies - External function dependencies
 * @param {Function} dependencies.showError - Function to display errors
 */
export function runGridLayout(dependencies = {}) {
  if (!state.cy) {
    logger.warn('[runGridLayout]', 'Cytoscape not initialized');
    return;
  }

  // Save current layout state for undo/redo
  saveLayoutState();

  try {
    state.cy.layout({ name: 'grid', fit: true, avoidOverlap: true, condense: true, padding: 80 }).run();
    state.cy.nodes().unlock();
    state.cy.nodes().grabify();
    setLayoutButton('Grid');
  } catch (err) {
    logger.error('[runGridLayout]', 'Layout failed:', err);
    if (dependencies.showError) {
      dependencies.showError('Failed to apply grid layout', err);
    }
  }
}

/**
 * Determines hierarchy roots and levels for breadthfirst layout
 * Uses BFS to compute node levels from dashboards/worksheets
 *
 * @param {Object} cy - Cytoscape instance
 * @returns {Object} Object with roots and rank (level map)
 * @private
 */
function getHierarchyRootsAndLevels(cy) {
  const nodes = cy.nodes();
  const dashboards = nodes.filter('[type = "Dashboard"]');
  const roots = dashboards.length ? dashboards : nodes.filter('[type = "Worksheet"]');

  const rank = new Map();
  const visited = new Set();
  const queue = [];

  roots.forEach((node) => {
    rank.set(node.id(), 0);
    visited.add(node.id());
    queue.push({ node, level: 0 });
  });

  while (queue.length) {
    const { node, level } = queue.shift();
    const preds = node.incomers('node');
    preds.forEach((pred) => {
      const pid = pred.id();
      if (visited.has(pid)) return;
      visited.add(pid);
      const nextLevel = level + 1;
      rank.set(pid, nextLevel);
      queue.push({ node: pred, level: nextLevel });
    });
  }

  return { roots, rank };
}

/**
 * Uses a breadthfirst layout to highlight dashboard/worksheet hierarchy
 * Positions nodes in horizontal lanes based on their depth from dashboards
 */
export function runHierarchyLayout() {
  if (!state.cy) return;

  // Save current layout state for undo/redo
  saveLayoutState();

  const cy = state.cy;
  const { roots, rank } = getHierarchyRootsAndLevels(cy);

  cy.layout({
    name: 'breadthfirst',
    directed: true,
    roots,
    spacingFactor: 1.15,
    nodeDimensionsIncludeLabels: true,
    avoidOverlap: true,
    padding: 20,
    fit: true,
    animate: false,
    circle: false,
  }).run();

  const laneH = 120;
  cy.nodes().positions((n) => {
    const level = rank.get(n.id());
    if (level == null) {
      return n.position();
    }
    const pos = n.position();
    return { x: pos.x, y: level * laneH + 40 };
  });

  cy.nodes().unlock();
  cy.nodes().grabify();
  cy.fit(cy.elements(), 40);
  setLayoutButton('Hierarchy');
}

/**
 * Places nodes into concentric rings ordered by node type
 * Dashboards in outer ring, worksheets in middle, fields/calcs in center
 */
export function runCenteredHierarchyLayout() {
  if (!state.cy) return;
  const rank = { Dashboard: 3, Worksheet: 2, Field: 1, CalculatedField: 1, Parameter: 1 };
  const r = (n) => rank[n.data('type')] ?? 1;
  state.cy
    .layout({
      name: 'concentric',
      fit: true,
      padding: 100,
      concentric: (n) => r(n),
      levelWidth: () => 1,
      minNodeSpacing: 22,
      startAngle: 1.5 * Math.PI,
      sweep: 2 * Math.PI,
      animate: 'end',
    })
    .run();
  state.cy.nodes().unlock();
  state.cy.nodes().grabify();
  setLayoutButton('Centered');
}

/**
 * Centers concentric rings around the current selection (or fallbacks)
 * Uses BFS to compute distances from selected node, then arranges in rings
 */
export function runCenteredFromSelectionLayout() {
  if (!state.cy) return;
  const cy = state.cy;
  let root = cy.$('node:selected[type = "Dashboard"]').first();
  if (!root.nonempty()) {
    root = cy.$('node:selected').first();
  }
  if (!root.nonempty()) {
    root = cy.$('node[type = "Dashboard"]').first();
  }
  if (!root.nonempty()) {
    root = cy.$('node[type = "Worksheet"]').first();
  }
  if (!root.nonempty()) {
    root = cy.nodes().first();
  }
  if (!root || !root.nonempty()) {
    setLayoutButton('Centered (no root)');
    return;
  }

  const dist = Object.create(null);
  cy.elements().bfs({
    roots: root,
    directed: true,
    visit: (v, e, u, i, depth) => {
      dist[v.id()] = depth;
    },
  });
  const maxD = Math.max(0, ...Object.values(dist));
  cy.nodes().forEach((n) => {
    if (dist[n.id()] == null) dist[n.id()] = maxD + 1;
  });

  const maxD2 = Math.max(...Object.values(dist));
  cy
    .layout({
      name: 'concentric',
      fit: true,
      padding: 100,
      concentric: (n) => maxD2 - dist[n.id()],
      levelWidth: () => 1,
      minNodeSpacing: 22,
      startAngle: 1.5 * Math.PI,
      sweep: 2 * Math.PI,
      animate: 'end',
    })
    .run();
  cy.nodes().unlock();
  cy.nodes().grabify();
  setLayoutButton('Centered (selection)');
}

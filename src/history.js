/**
 * @fileoverview Layout history management for undo/redo functionality
 * @module history
 */

import { state } from './state.js';
import { logger } from './logger.js';

/**
 * Saves the current node positions to history stack
 * Called before any layout change to enable undo
 */
export function saveLayoutState() {
  if (!state.cy) return;

  // Capture current positions
  const positions = {};
  state.cy.nodes().forEach((node) => {
    const pos = node.position();
    positions[node.id()] = { x: pos.x, y: pos.y };
  });

  // Remove any states after current index (if user did undo then made changes)
  state.layoutHistory = state.layoutHistory.slice(0, state.layoutHistoryIndex + 1);

  // Add new state
  state.layoutHistory.push(positions);
  state.layoutHistoryIndex++;

  // Limit history size
  if (state.layoutHistory.length > state.maxHistorySize) {
    state.layoutHistory.shift();
    state.layoutHistoryIndex--;
  }

  updateUndoRedoButtons();
  logger.debug('[layoutHistory]', `Saved state ${state.layoutHistoryIndex + 1}/${state.layoutHistory.length}`);
}

/**
 * Restores node positions from a saved state
 * @param {Object} positions - Map of node ID to {x, y} positions
 */
export function restoreLayoutState(positions) {
  if (!state.cy || !positions) return;

  state.cy.batch(() => {
    Object.keys(positions).forEach((nodeId) => {
      const node = state.cy.getElementById(nodeId);
      if (node && node.length) {
        node.position(positions[nodeId]);
      }
    });
  });

  updateUndoRedoButtons();
}

/**
 * Undo last layout change
 * Moves back in history stack
 */
export function undoLayout() {
  if (state.layoutHistoryIndex <= 0) {
    logger.info('[undoLayout]', 'No more states to undo');
    return;
  }

  state.layoutHistoryIndex--;
  const positions = state.layoutHistory[state.layoutHistoryIndex];
  restoreLayoutState(positions);
  logger.info('[undoLayout]', `Restored state ${state.layoutHistoryIndex + 1}/${state.layoutHistory.length}`);
}

/**
 * Redo previously undone layout change
 * Moves forward in history stack
 */
export function redoLayout() {
  if (state.layoutHistoryIndex >= state.layoutHistory.length - 1) {
    logger.info('[redoLayout]', 'No more states to redo');
    return;
  }

  state.layoutHistoryIndex++;
  const positions = state.layoutHistory[state.layoutHistoryIndex];
  restoreLayoutState(positions);
  logger.info('[redoLayout]', `Restored state ${state.layoutHistoryIndex + 1}/${state.layoutHistory.length}`);
}

/**
 * Updates undo/redo button states based on history
 * Enables/disables buttons and updates tooltips
 */
export function updateUndoRedoButtons() {
  const undoBtn = document.getElementById('undoBtn');
  const redoBtn = document.getElementById('redoBtn');

  if (undoBtn) {
    undoBtn.disabled = state.layoutHistoryIndex <= 0;
    undoBtn.title = state.layoutHistoryIndex > 0
      ? `Undo (${state.layoutHistoryIndex} states available)`
      : 'Undo (nothing to undo)';
  }

  if (redoBtn) {
    redoBtn.disabled = state.layoutHistoryIndex >= state.layoutHistory.length - 1;
    redoBtn.title = state.layoutHistoryIndex < state.layoutHistory.length - 1
      ? `Redo (${state.layoutHistory.length - state.layoutHistoryIndex - 1} states available)`
      : 'Redo (nothing to redo)';
  }
}

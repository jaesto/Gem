/**
 * @fileoverview UI event binding and handlers
 * @module ui-handlers
 *
 * Handles all user interface interactions:
 * - File upload (drag/drop, file input)
 * - Search
 * - Filters
 * - Layout controls
 * - Theme toggle
 * - Keyboard shortcuts
 * - Export functions
 */

import { MAX_FILE_SIZE, WARN_FILE_SIZE, HOP_MIN } from './constants.js';
import { state } from './state.js';
import { logger } from './logger.js';
import { announce, getEl, debounce, normalizeName } from './utils.js';
import { parseTwbx, parseTwb, parseTwbText } from './parsers.js';
import { buildGraph, normalizeGraph, syncGraphLookups } from './graph-builder.js';
import { applyCyTheme } from './cytoscape-config.js';
import { setLayoutButton } from './layouts.js';
import { applyFilters, fitAll, syncHopControl, focusOnNode } from './filters.js';
import { renderDetails, syncListSelection, populateLists } from './rendering.js';

/**
 * Updates the floating status badge with contextual messaging
 * Also announces to screen readers
 *
 * @param {string} text - Status message
 */
export function setStatus(text) {
  const statusEl = document.getElementById('status');
  if (!statusEl) return;
  statusEl.textContent = text;

  // Announce important status changes to screen readers
  if (text && !text.includes('Loading') && !text.includes('...')) {
    announce(text);
  }
}

/**
 * Displays an error overlay and logs the details for debugging
 * SECURITY: Uses textContent to prevent XSS attacks. Never exposes stack traces in production.
 *
 * @param {string} msg - Error message
 * @param {Error|string} err - Error object or string
 */
export function showError(msg, err) {
  const el = document.getElementById('errOverlay');
  if (!el) return;

  // Clear previous content safely
  el.style.display = 'block';
  el.textContent = '';

  // Create elements safely without innerHTML
  const title = document.createElement('strong');
  title.textContent = 'Error';

  const pre = document.createElement('pre');
  const errorMessage = msg || 'An error occurred';

  // Extract safe error details without exposing stack traces in production
  let errorDetails = '';
  if (err) {
    if (typeof err === 'string') {
      errorDetails = err;
    } else if (err.message) {
      // Only show message, not stack trace (security risk)
      errorDetails = err.message;
    } else {
      errorDetails = String(err);
    }
  }

  // Use textContent to prevent XSS
  pre.textContent = errorMessage + (errorDetails ? `\n${errorDetails}` : '');

  el.appendChild(title);
  el.appendChild(pre);

  // Log full details to console for debugging (not visible to end users)
  logger.error('[viewer]', msg, err);
}

/**
 * Clears memoization caches when loading a new graph
 * Improves performance by preventing cache staleness
 */
export function clearMemoCache() {
  if (state.memoCache) {
    state.memoCache.neighborhoods?.clear();
    state.memoCache.formulas?.clear();
  }
}

/**
 * Updates footer with workbook information
 */
export function updateFooter() {
  const footer = document.querySelector('footer');
  if (!footer) return;

  if (state.fileInfo?.name) {
    const nodes = state.graph?.nodes?.length || 0;
    const edges = state.graph?.edges?.length || 0;
    footer.textContent = `${state.fileInfo.name} · ${nodes} nodes · ${edges} edges`;
  } else {
    footer.textContent = 'Gem · Tableau Workbook Analyzer';
  }
}

/**
 * Draws graph elements to Cytoscape canvas
 *
 * @param {Object} graph - Graph with nodes and edges
 */
export function drawGraph(graph) {
  if (!state.cy) {
    throw new Error(
      'Graph visualization not ready. Please refresh the page and try again. If the problem persists, check the browser console for errors.'
    );
  }

  // Performance: Clear memoization caches when loading new graph
  clearMemoCache();

  try {
    if (!graph || typeof graph !== 'object') {
      throw new Error(
        'Cannot display graph: Invalid graph data received. The workbook may have structural issues. Check the browser console for details.'
      );
    }
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];

  const nodeEles = [];
  const edgeEles = [];
  const nodeIdSet = new Set();

  const nodeCount = nodes.length;
  const columns = Math.max(1, Math.ceil(Math.sqrt(Math.max(nodeCount, 1))));
  const rows = Math.max(1, Math.ceil(nodeCount / columns));
  const spacing = 220;
  const offsetX = ((columns - 1) * spacing) / 2;
  const offsetY = ((rows - 1) * spacing) / 2;

  nodes.forEach((node, index) => {
    if (!node || !node.id) return;
    nodeIdSet.add(node.id);
    const col = index % columns;
    const row = Math.floor(index / columns);
    const cyData = { ...(node.data || {}), ...node };
    delete cyData.data;
    cyData.id = cyData.id || node.id;
    cyData.name = cyData.name || node.name;
    cyData.type = cyData.type || node.type;
    nodeEles.push({
      data: cyData,
      position: {
        x: col * spacing - offsetX,
        y: row * spacing - offsetY,
      },
    });
  });

  edges.forEach((edge) => {
    if (!edge || !edge.id || !edge.source || !edge.target) return;
    if (!nodeIdSet.has(edge.source) || !nodeIdSet.has(edge.target)) {
      logger.warn('[drawGraph]', 'Edge references missing node', edge);
      return;
    }
    const cyData = { ...(edge.data || {}), ...edge };
    delete cyData.data;
    cyData.id = cyData.id || edge.id;
    cyData.source = cyData.source || edge.source;
    cyData.target = cyData.target || edge.target;
    cyData.rel = cyData.rel || cyData.label || edge.type || '';
    edgeEles.push({ data: { id: cyData.id, source: cyData.source, target: cyData.target, rel: cyData.rel } });
  });

  if (edgeEles.length === 0) {
    logger.warn('[drawGraph]', 'No edges parsed — check parser.');
  }

  state.cy.startBatch();
  state.cy.elements().remove();
  state.cy.add(nodeEles);
  state.cy.add(edgeEles);
  state.cy.endBatch();

  state.cy.nodes().grabify();
  state.cy.nodes().unlock();

  state.cy.nodes().show();
  state.cy.edges().show();

  applyCyTheme();

  state.cy.elements().removeClass('faded');
  state.cy.$('node').unselect();
  renderDetails(null);
  syncListSelection(null);
  state.selectedNodeId = null;
  state.lastFocusDepth = 1;
  state.hops = HOP_MIN;
  syncHopControl(state.hops);

  applyFilters({ rerunLayout: false });

  fitAll(100);
  setLayoutButton('Auto');

  logger.info('[drawGraph]', 'Graph ready:', state.cy.nodes().length, 'nodes /', state.cy.edges().length, 'edges');
  } catch (err) {
    logger.error('[drawGraph]', 'Failed:', err);
    showError('Failed to render graph', err);
    throw err;
  }
}

/**
 * Searches for and focuses on a node by name
 *
 * @param {string} query - Search query
 */
export function jumpToNode(query) {
  if (!state.cy) {
    logger.warn('[jumpToNode]', 'Cytoscape not initialized');
    return;
  }

  if (!query || typeof query !== 'string') {
    logger.warn('[jumpToNode]', 'Invalid query:', query);
    return;
  }

  const normalized = normalizeName(query);
  let matchId = state.nameToId.get(normalized);

  if (!matchId) {
    const entry = state.lookupEntries.find((item) => item && item.label && item.label.toLowerCase().includes(normalized));
    if (entry && entry.id) {
      matchId = entry.id;
    }
  }

  if (!matchId) {
    setStatus(`No node matching "${query}".`);
    return;
  }

  focusOnNode(matchId, { depth: 1, center: true }, { renderDetails, syncListSelection });
}

/**
 * Determines the parser based on filename extension
 *
 * @param {string} filename - File name
 * @param {ArrayBuffer} arrayBuffer - File content
 * @returns {Promise<Object>} Parsed metadata
 * @private
 */
async function parseWorkbookFile(filename, arrayBuffer) {
  if (!filename || typeof filename !== 'string') {
    throw new Error(
      'File upload failed: No filename provided. Please try selecting the file again.'
    );
  }

  if (!arrayBuffer || arrayBuffer.byteLength === 0) {
    throw new Error(
      'File upload failed: The file appears to be empty or could not be read. Please check that the file is not corrupted and try again.'
    );
  }

  const lower = filename.toLowerCase();

  // Create a File-like object from ArrayBuffer for parsers
  const file = {
    name: filename,
    size: arrayBuffer.byteLength,
    arrayBuffer: () => Promise.resolve(arrayBuffer)
  };

  if (lower.endsWith('.twbx')) return parseTwbx(file);
  if (lower.endsWith('.twb')) return parseTwb(file);

  // Provide helpful error message for unsupported types
  const extension = filename.split('.').pop() || 'unknown';
  throw new Error(
    `Unsupported file type: "${extension}"\n\nPlease upload a Tableau workbook file:\n• .twb (Tableau Workbook)\n• .twbx (Packaged Tableau Workbook)\n\nCurrent file: ${filename}`
  );
}

/**
 * Single entry point for handling uploads or drops
 *
 * @param {FileList|File[]} fileList - Files from input or drop
 */
export async function handleFiles(fileList) {
  if (!fileList || !fileList.length) return;

  // Prevent race condition - only process one file at a time
  if (state.isProcessingFile) {
    showError('File upload in progress', 'Please wait for the current file to finish loading.');
    return;
  }

  const file = fileList[0];
  if (!file) return;

  const displayName = file.name || 'Workbook';
  const fileSize = file.size || 0;

  // Validate file size
  if (fileSize === 0) {
    showError('Invalid file', 'The selected file is empty (0 bytes).');
    return;
  }

  if (fileSize > MAX_FILE_SIZE) {
    const sizeMB = (fileSize / (1024 * 1024)).toFixed(1);
    const maxMB = (MAX_FILE_SIZE / (1024 * 1024)).toFixed(0);
    showError(
      'File too large',
      `File size is ${sizeMB} MB, which exceeds the ${maxMB} MB limit. Large workbooks may crash your browser.`
    );
    return;
  }

  // Warn about large files
  if (fileSize > WARN_FILE_SIZE) {
    const sizeMB = (fileSize / (1024 * 1024)).toFixed(1);
    logger.warn('[handleFiles]', `Large file detected: ${sizeMB} MB. Processing may be slow.`);
    setStatus(`Loading large file (${sizeMB} MB)... This may take a moment.`);
  }

  // Set processing flag to prevent concurrent uploads
  state.isProcessingFile = true;

  try {
    setStatus(`Loading: ${displayName}`);
    const buf = await file.arrayBuffer();
    const parsed = await parseWorkbookFile(file.name, buf);
    parsed.workbook_path = file.name || 'Browser Upload';
    state.meta = parsed;
    state.fileInfo = { name: file.name, size: file.size };

    const rawGraph = buildGraph(parsed);
    const graph = normalizeGraph(rawGraph);
    state.graph = graph;
    syncGraphLookups(graph);

    populateLists(parsed, { focusOnNode: (id, opts) => focusOnNode(id, opts, { renderDetails, syncListSelection }) });
    drawGraph(graph);
    fitAll();

    setStatus(`Loaded: ${displayName}`);
    logger.debug('[handleFiles]', 'Done. Nodes:', graph.nodes.length, 'Edges:', graph.edges.length);
  } catch (err) {
    logger.error('[handleFiles]', 'Failed', file?.name, err);
    showError('Failed to open workbook', err);
    setStatus('Open failed.');
  } finally {
    // Always release the processing lock
    state.isProcessingFile = false;
    updateFooter();
  }
}

/**
 * Binds all UI event handlers
 * Wires toolbar buttons, dropdowns, and keyboard shortcuts to stateful handlers
 */
export function bindUI() {
  const openBtn = document.getElementById('openBtn') || getEl('openBtn', 'open-workbook-btn');
  const fileInput = document.getElementById('fileInput') || getEl('fileInput', 'file-input');
  const dropZone = document.getElementById('dropZone') || getEl('dropZone', 'dropzone');
  const fitBtn = getEl('fitBtn', 'fit-btn');
  const themeToggle = getEl('themeBtn', 'theme-toggle');
  const searchForm = getEl('search-form');
  const searchBox = getEl('search', 'search-box');
  const errOverlay = document.getElementById('errOverlay');

  if (openBtn && fileInput) openBtn.onclick = () => fileInput.click();

  if (fileInput) {
    fileInput.onchange = () => {
      handleFiles(fileInput.files);
      // Reset so the same file can be selected consecutively.
      fileInput.value = '';
    };
  }

  if (dropZone) {
    if (fileInput) {
      dropZone.addEventListener('click', () => fileInput.click());
      dropZone.addEventListener('keypress', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          fileInput.click();
        }
      });
    }

    ['dragenter', 'dragover'].forEach((evt) =>
      dropZone.addEventListener(evt, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.add('drag');
      })
    );
    ['dragleave', 'dragend'].forEach((evt) =>
      dropZone.addEventListener(evt, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.remove('drag');
      })
    );
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.remove('drag');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        handleFiles(e.dataTransfer.files);
      }
    });
  }

  if (fitBtn) {
    fitBtn.addEventListener('click', () => {
      if (!state.cy) return;
      fitAll(80);
    });
  }

  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      const html = document.documentElement;
      const current = html.getAttribute('data-theme');
      const next = current === 'dark' ? 'light' : 'dark';
      html.setAttribute('data-theme', next);
      applyCyTheme();
      localStorage.setItem('theme', next);
      logger.debug('[theme]', 'Switched to', next);
    });
  }

  if (searchForm && searchBox) {
    searchForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const query = searchBox.value?.trim();
      if (query) {
        jumpToNode(query);
      }
    });
  }

  // Close error overlay
  if (errOverlay) {
    errOverlay.addEventListener('click', () => {
      errOverlay.style.display = 'none';
    });
  }

  logger.info('[bindUI]', 'UI event handlers bound');
}

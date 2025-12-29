/**
 * Gem runtime flow:
 * 1. Wait for DOMContentLoaded, then boot the Cytoscape graph and wire UI controls.
 * 2. Accept workbook uploads (drag/drop or picker) and parse them entirely in the browser.
 * 3. Build a normalized node/edge graph, render it via Cytoscape, and populate sidebar lists.
 * 4. Respond to user interactions (layouts, filters, hops, isolated mode, theme, search).
 * 5. Provide export helpers that serialize metadata or the graph to local downloads.
 */

/**
 * ID INVARIANTS
 * - Node.id is ALWAYS the internal/stable ID from the workbook (Calculation_..., Field_..., Worksheet_...).
 * - Node.data('name') is the FRIENDLY/DISPLAY name.
 * - Edges use node.id for source/target. Never use display names for edge endpoints.
 * This keeps the graph consistent while still showing human-readable labels.
 */

/**
 * @typedef {'Field'|'CalculatedField'|'Worksheet'|'Dashboard'|'Parameter'} NodeType
 * @typedef {{ id:string, name:string, type:NodeType }} Node
 * @typedef {{ id:string, source:string, target:string, label:string }} Edge
 * @typedef {{ nodes:Node[], edges:Edge[] }} WorkbookGraph
 */

const state = {
  cy: null,
  meta: null,
  graph: null,
  nodeIndex: new Map(),
  lookupEntries: [],
  lookupMap: new Map(),
  nameToId: new Map(),
  idToName: new Map(),
  idToType: new Map(),
  idToDatasource: new Map(),
  isolatedMode: 'unhide',
  activeLayout: null,
  filters: {
    Field: true,
    CalculatedField: true,
    Worksheet: true,
    Dashboard: true,
    Parameter: true,
    lodOnly: false,
    tableCalcOnly: false,
  },
  fileInfo: null,
  buildTimestamp: new Date().toISOString(),
  selectedNodeId: null,
  lastFocusDepth: 1,
  hops: 1,
  graphResizeObserver: null,
  isProcessingFile: false,
  eventCleanup: [],
};

// Strip Tableau's square-bracket notation when normalizing names.
const NAME_NORMALIZER = /[\[\]]/g;

const HOP_MIN = 1;
const HOP_MAX = 5;

// File size limits (in bytes)
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB
const WARN_FILE_SIZE = 50 * 1024 * 1024; // 50 MB (warn user it might be slow)

let onHopChange = null;

function clampHop(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return HOP_MIN;
  return Math.max(HOP_MIN, Math.min(Math.round(numeric), HOP_MAX));
}

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

function syncHopControl(value) {
  const normalized = clampHop(value);
  state.hops = normalized;
  setHopUI(normalized);
  return normalized;
}

/**
 * Reads a CSS custom property from the document root.
 * Falls back to the provided value when running outside the browser (tests).
 * @param {string} name
 * @param {string} [fallback]
 * @returns {string}
 */
function cssVar(name, fallback) {
  if (typeof window === 'undefined' || !window.getComputedStyle) {
    return fallback;
  }
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * Derives Cytoscape colors from CSS variables so theme toggles stay in sync.
 * @returns {{text:string, outline:string, edge:string, calc:string, field:string, sheet:string, dash:string, param:string}}
 */
function themeColors() {
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
 * Updates the layout dropdown button label to reflect the active layout choice.
 * @param {string} label
 */
function setLayoutButton(label) {
  const btn = document.getElementById('layoutMenuBtn');
  if (btn) btn.textContent = `Layout: ${label} ▾`;
}

/**
 * Displays an error overlay and logs the details for debugging.
 * SECURITY: Uses textContent to prevent XSS attacks. Never exposes stack traces in production.
 * @param {string} msg
 * @param {Error|string} [err]
 */
function showError(msg, err) {
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
  console.error('[viewer]', msg, err);
}

// Cleanup function to remove all event listeners
function cleanupEventListeners() {
  state.eventCleanup.forEach((cleanup) => {
    try {
      cleanup();
    } catch (err) {
      console.warn('Failed to cleanup event listener:', err);
    }
  });
  state.eventCleanup = [];
}

// Helper to register cleanup functions
function registerEventListener(target, event, handler, options) {
  target.addEventListener(event, handler, options);
  state.eventCleanup.push(() => target.removeEventListener(event, handler, options));
}

// Debounce helper for performance
function debounce(fn, delay) {
  let timeoutId = null;
  return function (...args) {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn.apply(this, args), delay);
  };
}

if (typeof window !== 'undefined') {
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

  registerEventListener(window, 'error', handleError);
  registerEventListener(window, 'unhandledrejection', handleRejection);
  registerEventListener(window, 'resize', handleResize);

  // Cleanup on page unload
  registerEventListener(window, 'beforeunload', () => {
    cleanupEventListeners();
    if (state.graphResizeObserver) {
      state.graphResizeObserver.disconnect();
      state.graphResizeObserver = null;
    }
  });
}

let hasBilkent = false;
try {
  if (typeof window !== 'undefined' && window.cytoscape && window.cytoscapeCoseBilkent) {
    window.cytoscape.use(window.cytoscapeCoseBilkent);
    hasBilkent = true;
  }
} catch (error) {
  console.warn('bilkent registration failed', error);
}

const layoutName = (typeof hasBilkent !== 'undefined' && hasBilkent) ? 'cose-bilkent' : 'cose';

/**
 * Applies theme-aware node and edge styling to the Cytoscape instance.
 */
function applyCyTheme() {
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
 * Fits the Cytoscape viewport to all currently visible elements.
 * @param {number} [pad]
 */
function fitAll(pad = 80) {
  if (!state.cy) return;
  requestAnimationFrame(() => {
    const vis = state.cy.elements().filter(':visible');
    if (vis.length > 0) {
      state.cy.fit(vis, pad);
    }
  });
}

/**
 * Helper to fetch elements by a list of fallback IDs (legacy support).
 * @param {...string} ids
 * @returns {HTMLElement|null}
 */
function getEl(...ids) {
  for (const id of ids) {
    const element = document.getElementById(id);
    if (element) {
      return element;
    }
  }
  if (ids.length) {
    console.warn(`Element not found for ids: ${ids.join(', ')}`);
  }
  return null;
}

document.addEventListener('DOMContentLoaded', () => {
  bootGraph();
  bindUI();
  setStatus('Ready. Drop a Tableau workbook to begin.');
});

/**
 * Wires toolbar buttons, dropdowns, and keyboard shortcuts to stateful handlers.
 * The listeners only manipulate state and never block, so they keep the UI responsive.
 */
function bindUI() {
  const openBtn = document.getElementById('openBtn') || getEl('openBtn', 'open-workbook-btn');
  const fileInput = document.getElementById('fileInput') || getEl('fileInput', 'file-input');
  const dropZone = document.getElementById('dropZone') || getEl('dropZone', 'dropzone');
  const fitBtn = getEl('fitBtn', 'fit-btn');
  const layoutBtn = getEl('layoutBtn', 'layout-btn');
  const isoBtn = getEl('isolatedBtn');
  const isoMenu = getEl('isolatedMenu');
  const themeToggle = getEl('themeBtn', 'theme-toggle');
  const searchForm = getEl('search-form');
  const searchBox = getEl('search', 'search-box');
  const filtersDropdown = getEl('filtersDropdown', 'filters-dropdown');
  const exportDropdown = getEl('exportDropdown', 'export-dropdown');

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
      state.cy.elements().removeClass('faded');
      fitAll(80);
    });
  }

  if (layoutBtn) {
    layoutBtn.addEventListener('click', () => {
      runForceLayout();
    });
  }

  state.hops = clampHop(state.hops || state.lastFocusDepth || HOP_MIN);
  syncHopControl(state.hops);

  onHopChange = (value) => {
    const normalized = syncHopControl(value);
    if (!Number.isNaN(normalized)) {
      expandNeighbors(normalized);
    }
  };

  if (isoBtn && isoMenu) {
    const isoWrapper = isoBtn.parentElement;
    const setIsoOpen = (open) => {
      if (!isoWrapper) return;
      isoWrapper.classList.toggle('open', open);
      isoBtn.setAttribute('aria-expanded', String(open));
    };
    isoBtn.setAttribute('aria-haspopup', 'menu');
    isoBtn.setAttribute('aria-expanded', 'false');
    isoBtn.addEventListener('click', (event) => {
      event.preventDefault();
      const isOpen = Boolean(isoWrapper && isoWrapper.classList.contains('open'));
      setIsoOpen(!isOpen);
    });
    isoMenu.addEventListener('click', (event) => {
      const target = event.target.closest('[data-iso]');
      if (!target) return;
      const mode = target.dataset.iso;
      if (!mode) return;
      setIsoOpen(false);
      setIsolatedMode(mode);
    });
    document.addEventListener('click', (event) => {
      if (!isoWrapper) return;
      if (!isoWrapper.contains(event.target)) {
        setIsoOpen(false);
      }
    });
  }

  if (filtersDropdown) {
    filtersDropdown
      .querySelectorAll('input[type="checkbox"]')
      .forEach((checkbox) => {
        checkbox.addEventListener('change', () => {
          const key = checkbox.dataset.filter;
          state.filters[key] = checkbox.checked;
          applyFilters();
        });
      });
  }

  if (exportDropdown) {
    exportDropdown.querySelectorAll('[data-export]').forEach((button) => {
      button.addEventListener('click', () => {
        if (!state.meta || !state.graph) {
          setStatus('Load a workbook before exporting.');
          return;
        }
        const mode = button.dataset.export;
        // Export router: delegate to JSON, Markdown, or DOT serializers.
        switch (mode) {
          case 'workbook-json':
            downloadBlob('workbook_doc.json', JSON.stringify(state.meta, null, 2), 'application/json');
            break;
          case 'graph-json':
            downloadBlob('graph.json', JSON.stringify(state.graph, null, 2), 'application/json');
            break;
          case 'markdown':
            downloadBlob('workbook_doc.md', buildMarkdown(state.meta), 'text/markdown');
            break;
          case 'dot':
            downloadBlob('lineage.dot', buildDot(state.meta), 'text/vnd.graphviz');
            break;
          default:
            break;
        }
        exportDropdown.removeAttribute('open');
      });
    });
  }

  if (themeToggle) {
    const root = document.documentElement;
    const syncThemeToggle = () => {
      const isLight = root.classList.contains('light');
      themeToggle.textContent = isLight ? 'Light' : 'Dark';
      themeToggle.setAttribute('aria-pressed', String(!isLight));
    };
    syncThemeToggle();
    themeToggle.addEventListener('click', () => {
      root.classList.toggle('light');
      syncThemeToggle();
      applyCyTheme();
      if (state.cy) {
        state.cy.resize();
      }
      fitAll(60);
    });
  }

  if (searchForm && searchBox) {
    searchForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const query = searchBox.value.trim();
      if (query) {
        jumpToNode(query);
      }
    });
  }

  if (searchBox) {
    searchBox.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        const query = searchBox.value.trim();
        if (query) {
          jumpToNode(query);
        }
      }
    });
  }

  // Sidebar tabs are plain buttons; this keeps the markup accessible without a JS framework.
  document.querySelectorAll('.tabs button').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.tabs button').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((panel) => panel.classList.remove('active'));
      button.classList.add('active');
      const targetId = button.dataset.tab;
      const panel = document.getElementById(targetId);
      if (panel) {
        panel.classList.add('active');
      }
    });
  });

  // Global keyboard shortcuts for search focus and fit-to-view.
  document.addEventListener('keydown', (event) => {
    if (event.key === '/' && searchBox && document.activeElement !== searchBox) {
      event.preventDefault();
      searchBox.focus();
      searchBox.select();
    }
    if (event.key && event.key.toLowerCase() === 'f' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const tag = document.activeElement?.tagName?.toLowerCase();
      if (tag !== 'input' && tag !== 'textarea') {
        event.preventDefault();
        fitAll(80);
      }
    }
  });

  setIsolatedMode(state.isolatedMode || 'unhide');
  updateFooter();
}

/**
 * Creates the Cytoscape instance once and configures shared interaction handlers.
 * Subsequent workbook loads reuse this instance to avoid reinitializing extensions.
 */
function bootGraph() {
  try {
    const graphContainerEl = document.getElementById('graph');
    if (!graphContainerEl) {
      throw new Error('Graph container element #graph not found in DOM');
    }

    if (typeof cytoscape !== 'function') {
      throw new Error('Cytoscape library not loaded');
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
      console.warn('Failed to disconnect previous ResizeObserver', error);
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
      console.warn('Failed to create ResizeObserver:', error);
    }
  }

  state.cy.on('tap', 'node', (event) => {
    const node = event.target;
    focusOnNode(node.id(), { depth: 1, center: true });
  });

  state.cy.on('tap', (event) => {
    if (event.target === state.cy) {
      state.cy.elements().removeClass('faded');
      state.cy.$('node').unselect();
      renderDetails(null);
      state.selectedNodeId = null;
      syncListSelection(null);
    }
  });
  } catch (err) {
    console.error('[bootGraph] Failed to initialize Cytoscape:', err);
    showError('Failed to initialize graph visualization', err);
    throw err;
  }
}

/**
 * Updates the floating status badge with contextual messaging.
 * @param {string} text
 */
function setStatus(text) {
  const statusEl = document.getElementById('status');
  if (!statusEl) return;
  statusEl.textContent = text;
}

/**
 * Single entry point for handling uploads or drops.
 * @param {FileList|File[]} fileList
 */
async function handleFiles(fileList) {
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
    console.warn(`Large file detected: ${sizeMB} MB. Processing may be slow.`);
    setStatus?.(`Loading large file (${sizeMB} MB)... This may take a moment.`);
  }

  // Set processing flag to prevent concurrent uploads
  state.isProcessingFile = true;

  try {
    setStatus?.(`Loading: ${displayName}`);
    const buf = await file.arrayBuffer();
    const parsed = await parseWorkbookFile(file.name, buf);
    parsed.workbook_path = file.name || 'Browser Upload';
    state.meta = parsed;
    state.fileInfo = { name: file.name, size: file.size };

    const rawGraph = buildGraph(parsed);
    const graph = normalizeGraph(rawGraph);
    state.graph = graph;
    syncGraphLookups(graph);

    populateLists(parsed);
    drawGraph(graph);
    fitAll?.();

    setStatus?.(`Loaded: ${displayName}`);
    console.debug('[Open] Done. Nodes:', graph.nodes.length, 'Edges:', graph.edges.length);
  } catch (err) {
    console.error('[Open] Failed', file?.name, err);
    showError('Failed to open workbook', err);
    showErrorOverlay?.('Failed to open workbook. See console for details.');
    setStatus?.('Open failed.');
  } finally {
    // Always release the processing lock
    state.isProcessingFile = false;
    updateFooter();
  }
}

/**
 * Determines the parser based on filename extension.
 * @param {string} filename
 * @param {ArrayBuffer} arrayBuffer
 */
async function parseWorkbookFile(filename, arrayBuffer) {
  if (!filename || typeof filename !== 'string') {
    throw new Error('Invalid filename');
  }

  if (!arrayBuffer || arrayBuffer.byteLength === 0) {
    throw new Error('Invalid or empty file buffer');
  }

  const lower = filename.toLowerCase();
  if (lower.endsWith('.twbx')) return parseTwbx(arrayBuffer);
  if (lower.endsWith('.twb')) return parseTwb(arrayBuffer);

  // Provide helpful error message for unsupported types
  const extension = filename.split('.').pop() || 'unknown';
  throw new Error(
    `Unsupported file type: .${extension}. Please upload a Tableau workbook (.twb or .twbx file).`
  );
}

async function parseTwbx(buf) {
  console.debug('[Open] parseTwbx start');
  try {
    if (!buf || buf.byteLength === 0) {
      throw new Error('Empty or invalid file buffer');
    }

    const zip = await JSZip.loadAsync(buf).catch((err) => {
      throw new Error(`Failed to unzip .twbx file: ${err.message || err}`);
    });

    const entry = Object.values(zip.files).find((f) => f.name.toLowerCase().endsWith('.twb'));
    if (!entry) {
      throw new Error('No .twb file found inside .twbx archive');
    }

    const xml = await entry.async('text').catch((err) => {
      throw new Error(`Failed to extract .twb from archive: ${err.message || err}`);
    });

    if (!xml || xml.trim().length === 0) {
      throw new Error('Extracted .twb file is empty');
    }

    return parseTwbText(xml);
  } catch (err) {
    console.error('[parseTwbx] Failed:', err);
    throw err;
  }
}

async function parseTwb(buf) {
  console.debug('[Open] parseTwb start');
  try {
    if (!buf || buf.byteLength === 0) {
      throw new Error('Empty or invalid file buffer');
    }

    const xml = new TextDecoder('utf-8').decode(buf);
    if (!xml || xml.trim().length === 0) {
      throw new Error('File is empty or contains no text');
    }

    return parseTwbText(xml);
  } catch (err) {
    console.error('[parseTwb] Failed:', err);
    throw err;
  }
}

function parseTwbText(xmlText) {
  try {
    if (!xmlText || typeof xmlText !== 'string') {
      throw new Error('Invalid XML text provided');
    }

    const doc = new DOMParser().parseFromString(xmlText, 'text/xml');

    // Check for parse errors
    const errorNode = doc.querySelector('parsererror');
    if (errorNode) {
      const message = errorNode.textContent?.trim() || 'Unable to parse workbook XML.';
      throw new Error(`XML parsing failed: ${message}`);
    }

    // Validate it's actually a Tableau workbook
    if (!doc.documentElement) {
      throw new Error('XML document is missing root element');
    }

    const rootTag = doc.documentElement.tagName.toLowerCase();
    if (rootTag !== 'workbook') {
      throw new Error(`Invalid Tableau workbook: expected <workbook> root, found <${rootTag}>`);
    }

    return parseFromXmlDocument(doc);
  } catch (err) {
    console.error('[parseTwbText] Failed:', err);
    throw err;
  }
}

/**
 * Parses Tableau workbook XML into normalized metadata collections.
 * Handles datasources, parameters, worksheets, dashboards, and lineage links.
 * @param {Document} xml
 * @returns {object}
 */
function parseFromXmlDocument(xml) {
  try {
    if (!xml || !xml.documentElement) {
      throw new Error('Invalid workbook XML document.');
    }

    if (!xml.querySelectorAll) {
      throw new Error('XML document does not support querySelectorAll.');
    }

  const meta = {
    workbook_path: 'Browser Upload',
    datasources: [],
    parameters: [],
    worksheets: [],
    dashboards: [],
    lineage: {
      field_to_field: [],
      field_to_sheet: [],
    },
  };

  const datasourceNodes = Array.from(xml.querySelectorAll('datasource'));
  datasourceNodes.forEach((datasourceNode, index) => {
    const rawId = getAttr(datasourceNode, 'name') || '';
    const caption = getAttr(datasourceNode, 'caption') || '';
    const friendlyName = caption || rawId || `Datasource ${index + 1}`;
    const datasource = {
      id: rawId || friendlyName,
      rawId: rawId || friendlyName,
      caption,
      name: friendlyName,
      fields: [],
      connections: Array.from(datasourceNode.querySelectorAll('connection')).map((connNode) => ({
        id: getAttr(connNode, 'name') || '',
        caption: getAttr(connNode, 'caption') || '',
        class: getAttr(connNode, 'class') || '',
        type: getAttr(connNode, 'type') || '',
        server: getAttr(connNode, 'server') || '',
        dbname: getAttr(connNode, 'dbname') || '',
        warehouse: getAttr(connNode, 'warehouse') || '',
      })),
    };

    const columnNodes = Array.from(datasourceNode.querySelectorAll('column'));
    columnNodes.forEach((columnNode, columnIndex) => {
      const fieldId = getAttr(columnNode, 'name') || '';
      const fieldCaption = getAttr(columnNode, 'caption') || '';
      const fieldName = fieldCaption || fieldId || `Field ${columnIndex + 1}`;
      const datatype = getAttr(columnNode, 'datatype') || getAttr(columnNode, 'role') || '';
      const defaultAggregation = getAttr(columnNode, 'default-aggregation') || getAttr(columnNode, 'aggregation') || '';
      const role = getAttr(columnNode, 'role') || '';
      const calculationNode = columnNode.querySelector('calculation');
      const field = {
        id: fieldId || fieldName,
        rawId: fieldId || fieldName,
        caption: fieldCaption,
        name: fieldName,
        datatype,
        default_aggregation: defaultAggregation,
        role,
        is_calculated: Boolean(calculationNode),
        datasource_id: datasource.rawId,
      };
      if (calculationNode) {
        const formula = getAttr(calculationNode, 'formula') || calculationNode.textContent || '';
        const calcClass = getAttr(calculationNode, 'class') || '';
        const references = extractCalculationReferences(formula);
        field.calculation = {
          formula,
          class: calcClass,
        };
        field.references = references;
      }
      datasource.fields.push(field);
    });

    meta.datasources.push(datasource);
  });

  const parameterNodes = Array.from(xml.querySelectorAll('parameter'));
  parameterNodes.forEach((parameterNode, index) => {
    const rawId = getAttr(parameterNode, 'name') || '';
    const caption = getAttr(parameterNode, 'caption') || '';
    const name = caption || rawId || `Parameter ${index + 1}`;
    const datatype = getAttr(parameterNode, 'datatype') || '';
    const currentValueNode = parameterNode.querySelector('current-value');
    const currentValue = getAttr(parameterNode, 'value') || (currentValueNode ? currentValueNode.textContent : '') || '';
    meta.parameters.push({
      id: rawId || name,
      rawId: rawId || name,
      caption,
      name,
      datatype,
      current_value: currentValue,
    });
  });

  const worksheetNodes = Array.from(xml.querySelectorAll('worksheets > worksheet'));
  worksheetNodes.forEach((worksheetNode, index) => {
    const rawId = getAttr(worksheetNode, 'name') || '';
    const caption = getAttr(worksheetNode, 'caption') || '';
    const name = caption || rawId || `Worksheet ${index + 1}`;
    const fieldsUsed = new Set();
    Array.from(worksheetNode.querySelectorAll('datasource-dependencies column')).forEach((columnNode) => {
      const ref = getAttr(columnNode, 'caption') || getAttr(columnNode, 'name');
      if (ref) {
        fieldsUsed.add(ref);
      }
    });
    Array.from(worksheetNode.querySelectorAll('column')).forEach((columnNode) => {
      const ref = getAttr(columnNode, 'caption') || getAttr(columnNode, 'name');
      if (ref) {
        fieldsUsed.add(ref);
      }
    });
    const worksheet = {
      id: rawId || name,
      rawId: rawId || name,
      caption,
      name,
      fields_used: Array.from(fieldsUsed),
    };
    meta.worksheets.push(worksheet);
  });

  const dashboardNodes = Array.from(xml.querySelectorAll('dashboards > dashboard'));
  dashboardNodes.forEach((dashboardNode, index) => {
    const rawId = getAttr(dashboardNode, 'name') || '';
    const caption = getAttr(dashboardNode, 'caption') || '';
    const name = caption || rawId || `Dashboard ${index + 1}`;
    const worksheetRefs = new Set();
    Array.from(dashboardNode.querySelectorAll('worksheet')).forEach((worksheetRefNode) => {
      const ref = getAttr(worksheetRefNode, 'name') || getAttr(worksheetRefNode, 'sheet');
      if (ref) {
        worksheetRefs.add(ref);
      }
    });
    Array.from(dashboardNode.querySelectorAll('zone')).forEach((zoneNode) => {
      const ref = getAttr(zoneNode, 'worksheet') || getAttr(zoneNode, 'name');
      if (ref) {
        worksheetRefs.add(ref);
      }
    });
    meta.dashboards.push({
      id: rawId || name,
      rawId: rawId || name,
      caption,
      name,
      worksheets: Array.from(worksheetRefs),
    });
  });

  const lineageFieldToField = [];
  const lineageFieldToSheet = [];

  meta.datasources.forEach((datasource) => {
    datasource.fields.forEach((field) => {
      if (field.is_calculated && field.references) {
        field.references.fields.forEach((refName) => {
          lineageFieldToField.push([refName, field.name]);
        });
      }
    });
  });

  meta.worksheets.forEach((worksheet) => {
    worksheet.fields_used.forEach((refName) => {
      lineageFieldToSheet.push([refName, worksheet.name]);
    });
  });

  meta.lineage.field_to_field = dedupePairs(lineageFieldToField);
  meta.lineage.field_to_sheet = dedupePairs(lineageFieldToSheet);

  return meta;
  } catch (err) {
    console.error('[parseFromXmlDocument] Failed:', err);
    throw new Error(`Failed to parse workbook XML: ${err.message || err}`);
  }
}

/**
 * Safely reads an attribute from an XML node, returning empty string when missing.
 * @param {Element|null} node
 * @param {string} attr
 * @returns {string}
 */
function getAttr(node, attr) {
  if (!node) return '';
  return node.getAttribute(attr) || '';
}

/**
 * Pulls field and parameter tokens out of a Tableau calculation formula string.
 * @param {string} formula
 * @returns {{fields:string[], parameters:string[]}}
 */
function extractCalculationReferences(formula) {
  if (!formula) {
    return { fields: [], parameters: [] };
  }
  const fieldMatches = formula.match(/\[[^\]]+\]/g) || [];
  const fields = Array.from(new Set(fieldMatches.map((value) => value.trim())));
  const parameterMatches = formula.match(/\[:[^\]]+\]/g) || [];
  const parameters = Array.from(
    new Set(
      parameterMatches
        .map((value) => value.replace(/[\[\]:]/g, '').trim())
        .filter(Boolean)
    )
  );
  return { fields, parameters };
}

/**
 * Removes duplicate [from,to] tuples while preserving insertion order.
 * @param {Array<[string,string]>} pairs
 * @returns {Array<[string,string]>}
 */
function dedupePairs(pairs) {
  const seen = new Set();
  const result = [];
  pairs.forEach(([from, to]) => {
    const key = `${from}__${to}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push([from, to]);
    }
  });
  return result;
}

/**
 * Converts parsed workbook metadata into the Cytoscape-friendly graph structure.
 * Enforces ID invariants, tracks lookup maps, and creates lineage edges.
 * @param {object} meta
 * @returns {WorkbookGraph}
 */
function buildGraph(meta) {
  try {
    if (!meta || typeof meta !== 'object') {
      throw new Error('Invalid metadata object provided to buildGraph');
    }

  state.nodeIndex = new Map();
  state.lookupEntries = [];
  state.lookupMap = new Map();
  state.nameToId = new Map();
  const idToName = new Map();
  const idToType = new Map();
  const idToDatasource = new Map();
  // These lookup maps translate Tableau-internal identifiers (e.g., Calculation_123)
  // into human-readable names, type labels, and datasource captions so the UI can
  // favor friendly labels while still exposing raw IDs via tooltips for debugging.
  state.idToName = idToName;
  state.idToType = idToType;
  state.idToDatasource = idToDatasource;

  // Collections that ultimately drive Cytoscape and the search/autocomplete UI.
  const nodes = [];
  const edges = [];
  const edgeKeys = new Set();
  const lookupEntries = [];
  const usedIds = new Set();
  const datasourceLabels = new Map();

  // Tableau objects can share captions; track them by normalized name for fuzzy matching.
  const nameToIds = {
    Field: new Map(),
    CalculatedField: new Map(),
    Worksheet: new Map(),
    Dashboard: new Map(),
    Parameter: new Map(),
  };

  // Usage maps allow us to attach "where used" lists to nodes without additional passes later.
  const fieldUsage = new Map();
  const fieldFeeds = new Map();
  const paramUsage = new Map();
  const worksheetDashboards = new Map();

  function rememberEntity(rawId, type, label, datasourceLabel) {
    if (!rawId) return;
    const safeLabel = label || 'Unnamed';
    const variants = new Set([rawId]);
    const trimmed = rawId.trim();
    if (trimmed) variants.add(trimmed);
    const unbracketed = trimmed.replace(NAME_NORMALIZER, '').trim();
    if (unbracketed) {
      variants.add(unbracketed);
      variants.add(`[${unbracketed}]`);
    }
    variants.forEach((variant) => {
      if (!idToName.has(variant) || idToName.get(variant) === 'Unnamed') {
        idToName.set(variant, safeLabel);
      }
      if (type && !idToType.has(variant)) {
        idToType.set(variant, type);
      }
      if (datasourceLabel && !idToDatasource.has(variant)) {
        idToDatasource.set(variant, datasourceLabel);
      }
    });
  }

  meta.datasources.forEach((datasource) => {
    const dsId = cleanInternalId(datasource.rawId) || datasource.rawId || datasource.id || datasource.name;
    const dsLabel = friendlyDatasourceName(datasource);
    if (dsId) {
      datasourceLabels.set(dsId, dsLabel);
      rememberEntity(dsId, 'Datasource', dsLabel, dsLabel);
    }
    datasource.fields.forEach((field) => {
      const rawFieldId = field.rawId || field.id || field.name;
      const fieldLabel = displayName(field.name) || field.name || 'Unnamed';
      const fieldType = field.is_calculated ? 'CalculatedField' : 'Field';
      rememberEntity(rawFieldId, fieldType, fieldLabel, dsLabel);
    });
  });

  meta.parameters.forEach((parameter) => {
    rememberEntity(parameter.rawId || parameter.id || parameter.name, 'Parameter', parameter.name);
  });

  meta.worksheets.forEach((worksheet) => {
    rememberEntity(worksheet.rawId || worksheet.id || worksheet.name, 'Worksheet', worksheet.name);
  });

  meta.dashboards.forEach((dashboard) => {
    rememberEntity(dashboard.rawId || dashboard.id || dashboard.name, 'Dashboard', dashboard.name);
  });

  meta.worksheets.forEach((worksheet) => {
    worksheet.fields_used.forEach((item) => {
      const key = normalizeName(item);
      if (!fieldUsage.has(key)) fieldUsage.set(key, new Set());
      fieldUsage.get(key).add(worksheet.name);
    });
  });

  meta.datasources.forEach((datasource) => {
    datasource.fields.forEach((field) => {
      if (field.is_calculated && field.references) {
        field.references.fields.forEach((refName) => {
          const key = normalizeName(refName);
          if (!fieldFeeds.has(key)) fieldFeeds.set(key, new Set());
          fieldFeeds.get(key).add(field.name);
        });
        field.references.parameters.forEach((paramName) => {
          const key = normalizeName(paramName);
          if (!paramUsage.has(key)) paramUsage.set(key, new Set());
          paramUsage.get(key).add(field.name);
        });
      }
    });
  });

  meta.dashboards.forEach((dashboard) => {
    dashboard.worksheets.forEach((worksheetName) => {
      const key = normalizeName(worksheetName);
      if (!worksheetDashboards.has(key)) worksheetDashboards.set(key, new Set());
      worksheetDashboards.get(key).add(dashboard.name);
    });
  });

  function cleanInternalId(rawId) {
    if (!rawId) return '';
    return rawId.trim().replace(NAME_NORMALIZER, '').trim();
  }

  function canonicalId(rawId, prefix, baseName) {
    let candidate = cleanInternalId(rawId);
    if (candidate) {
      if (!usedIds.has(candidate)) {
        usedIds.add(candidate);
        return candidate;
      }
      console.warn('[Graph] Duplicate node id detected, generating fallback:', candidate);
    }
    const base = baseName || candidate || `${prefix}-${usedIds.size + 1}`;
    let slug = slugify(base);
    if (!slug) slug = `${prefix}-${usedIds.size + 1}`;
    let fallback = `${prefix}:${slug}`;
    let counter = 2;
    const MAX_ITERATIONS = 10000; // Prevent infinite loops

    while (usedIds.has(fallback)) {
      if (counter > MAX_ITERATIONS) {
        // Failsafe: use timestamp-based unique ID
        const uniqueId = `${prefix}:${slug}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        console.error('[Graph] Failed to generate unique ID after', MAX_ITERATIONS, 'attempts. Using fallback:', uniqueId);
        usedIds.add(uniqueId);
        return uniqueId;
      }
      fallback = `${prefix}:${slug}-${counter}`;
      counter += 1;
    }
    usedIds.add(fallback);
    return fallback;
  }

  function registerName(map, type, key, id) {
    if (!map[type].has(key)) {
      map[type].set(key, []);
    }
    map[type].get(key).push(id);
  }

  function registerNode(node) {
    nodes.push(node);
    rememberEntity(node.id, node.type, node.name, node.datasource);
    const key = normalizeName(node.rawName || node.name);
    registerName(nameToIds, node.type, key, node.id);
    lookupEntries.push({
      key,
      label: `${node.name} (${node.type})`,
      id: node.id,
    });
    // Fast lookup maps keep search responsive for large workbooks.
    if (!state.nameToId.has(key)) {
      state.nameToId.set(key, node.id);
    }
    if (!state.lookupMap.has(node.name)) {
      state.lookupMap.set(node.name, node.id);
    }
    state.nodeIndex.set(node.id, node);
  }

  function addEdge(source, target, rel) {
    if (!source || !target) return;
    const edgeKey = `${source}->${target}:${rel}`;
    if (edgeKeys.has(edgeKey)) return;
    edgeKeys.add(edgeKey);
    edges.push({
      id: edgeKey,
      source,
      target,
      rel,
      type: rel,
    });
  }

  meta.datasources.forEach((datasource, dsIndex) => {
    datasource.fields.forEach((field, index) => {
      const isCalc = Boolean(field.is_calculated);
      const type = isCalc ? 'CalculatedField' : 'Field';
      const baseName = field.name || `Field ${dsIndex + 1}.${index + 1}`;
      const datasourceId = cleanInternalId(datasource.rawId) || datasource.rawId || datasource.id || datasource.name;
      const datasourceLabel = datasourceLabels.get(datasourceId) || datasource.name;
      const internalId = canonicalId(field.rawId, isCalc ? 'calc' : 'field', baseName);
      const node = {
        id: internalId,
        type,
        name: displayName(baseName),
        rawName: baseName,
        rawId: internalId,
        originalId: field.rawId || '',
        datasource: datasourceLabel,
        datasourceId,
        datatype: field.datatype || '',
        role: field.role || '',
        defaultAggregation: field.default_aggregation || '',
        references: field.references || { fields: [], parameters: [] },
        formula: field.calculation ? field.calculation.formula || '' : '',
        calcClass: field.calculation ? field.calculation.class || '' : '',
      };
      // Regex heuristics capture LOD and table-calculation flags for filtering.
      node.isLOD = node.formula ? /\{\s*(FIXED|INCLUDE|EXCLUDE)/i.test(node.formula) : false;
      node.isTableCalc = node.formula ? /\b(WINDOW_|RUNNING_|LOOKUP|INDEX|RANK)\b/i.test(node.formula) : false;
      node.usedInWorksheets = Array.from(fieldUsage.get(normalizeName(baseName)) || []);
      const dashboards = new Set();
      node.usedInWorksheets.forEach((wsName) => {
        const matches = worksheetDashboards.get(normalizeName(wsName));
        if (matches) {
          matches.forEach((dash) => dashboards.add(dash));
        }
      });
      node.dashboards = Array.from(dashboards);
      node.referencedByCalcs = Array.from(fieldFeeds.get(normalizeName(baseName)) || []);
      registerNode(node);
    });
  });

  meta.parameters.forEach((parameter, index) => {
    const baseName = parameter.name || `Parameter ${index + 1}`;
    const internalId = canonicalId(parameter.rawId, 'param', baseName);
    const node = {
      id: internalId,
      type: 'Parameter',
      name: displayName(baseName),
      rawName: baseName,
      rawId: internalId,
      originalId: parameter.rawId || '',
      datatype: parameter.datatype || '',
      currentValue: parameter.current_value || '',
      usedInCalcs: Array.from(paramUsage.get(normalizeName(baseName)) || []),
    };
    registerNode(node);
  });

  meta.worksheets.forEach((worksheet, index) => {
    const baseName = worksheet.name || `Worksheet ${index + 1}`;
    const internalId = canonicalId(worksheet.rawId, 'ws', baseName);
    const node = {
      id: internalId,
      type: 'Worksheet',
      name: baseName,
      rawName: baseName,
      rawId: internalId,
      originalId: worksheet.rawId || '',
      fieldsUsed: worksheet.fields_used.slice(),
      dashboards: Array.from(worksheetDashboards.get(normalizeName(baseName)) || []),
    };
    registerNode(node);
  });

  meta.dashboards.forEach((dashboard, index) => {
    const baseName = dashboard.name || `Dashboard ${index + 1}`;
    const internalId = canonicalId(dashboard.rawId, 'db', baseName);
    const node = {
      id: internalId,
      type: 'Dashboard',
      name: baseName,
      rawName: baseName,
      rawId: internalId,
      originalId: dashboard.rawId || '',
      worksheets: dashboard.worksheets.slice(),
    };
    registerNode(node);
  });

  meta.datasources.forEach((datasource) => {
    datasource.fields.forEach((field) => {
      if (field.is_calculated && field.references) {
        const targetIds = nameToIds.CalculatedField.get(normalizeName(field.name)) || [];
        targetIds.forEach((targetId) => {
          field.references.fields.forEach((refName) => {
            const key = normalizeName(refName);
            const sourceIds = (nameToIds.Field.get(key) || []).concat(nameToIds.CalculatedField.get(key) || []);
            sourceIds.forEach((sourceId) => addEdge(sourceId, targetId, 'FEEDS'));
          });
          field.references.parameters.forEach((paramName) => {
            const key = normalizeName(paramName);
            const paramIds = nameToIds.Parameter.get(key) || [];
            paramIds.forEach((paramId) => addEdge(paramId, targetId, 'PARAM_OF'));
          });
        });
      }
    });
  });

  meta.worksheets.forEach((worksheet) => {
    const worksheetIds = nameToIds.Worksheet.get(normalizeName(worksheet.name)) || [];
    worksheetIds.forEach((worksheetId) => {
      worksheet.fields_used.forEach((refName) => {
        const key = normalizeName(refName);
        const calcIds = nameToIds.CalculatedField.get(key) || [];
        const fieldIds = nameToIds.Field.get(key) || [];
        const ids = calcIds.length ? calcIds : fieldIds;
        ids.forEach((id) => addEdge(id, worksheetId, 'USED_IN'));
      });
    });
  });

  meta.dashboards.forEach((dashboard) => {
    const dashboardIds = nameToIds.Dashboard.get(normalizeName(dashboard.name)) || [];
    dashboardIds.forEach((dashboardId) => {
      dashboard.worksheets.forEach((worksheetName) => {
        const worksheetIds = nameToIds.Worksheet.get(normalizeName(worksheetName)) || [];
        worksheetIds.forEach((worksheetId) => addEdge(worksheetId, dashboardId, 'ON'));
      });
    });
  });

  // Sorted entries drive datalist suggestions and fuzzy text searches.
  state.lookupEntries = lookupEntries.sort((a, b) => a.label.localeCompare(b.label));

  console.debug('[buildGraph] Created', nodes.length, 'nodes and', edges.length, 'edges');
  return { nodes, edges };
  } catch (err) {
    console.error('[buildGraph] Failed:', err);
    throw new Error(`Failed to build graph: ${err.message || err}`);
  }
}

/**
 * Repairs malformed graph payloads before Cytoscape rendering.
 * Ensures nodes/edges have required IDs and that edge endpoints exist.
 * @param {WorkbookGraph|{nodes?:any[], edges?:any[]}} graph
 * @returns {WorkbookGraph}
 */
function normalizeGraph(graph) {
  if (!graph) {
    return { nodes: [], edges: [] };
  }

  const normalizedNodes = [];
  const normalizedEdges = [];
  const nodeIds = new Set();

  const rawNodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  rawNodes.forEach((rawNode) => {
    if (!rawNode || typeof rawNode !== 'object') {
      console.warn('[normalizeGraph] skipping invalid node', rawNode);
      return;
    }

    const nodeData = (rawNode.data && typeof rawNode.data === 'object') ? { ...rawNode.data } : {};
    let id = typeof rawNode.id === 'string' ? rawNode.id : nodeData.id;
    if (typeof id === 'string') id = id.trim();

    if (!id) {
      console.warn('[normalizeGraph] skipping node with no id', rawNode);
      return;
    }

    if (nodeIds.has(id)) {
      console.warn('[normalizeGraph] duplicate node id', id);
      return;
    }

    const nameSource = (typeof rawNode.name === 'string' && rawNode.name.trim()) ? rawNode.name : nodeData.name;
    const name = (typeof nameSource === 'string' && nameSource.trim()) ? nameSource.trim() : id;
    const type = rawNode.type || nodeData.type || 'Unknown';

    const normalizedNode = {
      ...rawNode,
      id,
      name,
      type,
      data: {
        ...nodeData,
        id,
        name,
        type,
      },
    };

    normalizedNodes.push(normalizedNode);
    nodeIds.add(id);
  });

  const rawEdges = Array.isArray(graph.edges) ? graph.edges : [];
  const edgeIds = new Set();
  rawEdges.forEach((rawEdge) => {
    if (!rawEdge || typeof rawEdge !== 'object') {
      console.warn('[normalizeGraph] skipping invalid edge', rawEdge);
      return;
    }

    const edgeData = (rawEdge.data && typeof rawEdge.data === 'object') ? { ...rawEdge.data } : {};
    let source = rawEdge.source || edgeData.source;
    let target = rawEdge.target || edgeData.target;
    if (typeof source === 'string') source = source.trim();
    if (typeof target === 'string') target = target.trim();

    if (!source || !target) {
      console.warn('[normalizeGraph] skipping edge missing endpoints', rawEdge);
      return;
    }

    if (!nodeIds.has(source) || !nodeIds.has(target)) {
      console.warn('[normalizeGraph] skipping edge with unknown endpoint', rawEdge);
      return;
    }

    let id = rawEdge.id || edgeData.id;
    if (typeof id === 'string') id = id.trim();
    if (!id) {
      id = `${source}->${target}`;
    }
    if (edgeIds.has(id)) {
      let dedupeIndex = 2;
      let candidate = `${id}#${dedupeIndex}`;
      while (edgeIds.has(candidate)) {
        dedupeIndex += 1;
        candidate = `${id}#${dedupeIndex}`;
      }
      console.warn('[normalizeGraph] duplicate edge id detected, renaming', id, '->', candidate);
      id = candidate;
    }

    const rel = rawEdge.rel || rawEdge.label || edgeData.rel || edgeData.label || rawEdge.type || '';

    const normalizedEdge = {
      ...rawEdge,
      id,
      source,
      target,
      rel,
      data: {
        ...edgeData,
        id,
        source,
        target,
        rel,
        label: edgeData.label || rawEdge.label || rel,
      },
    };

    normalizedEdges.push(normalizedEdge);
    edgeIds.add(id);
  });

  console.debug('[normalizeGraph] final counts:', normalizedNodes.length, 'nodes;', normalizedEdges.length, 'edges');
  return { nodes: normalizedNodes, edges: normalizedEdges };
}

/**
 * Rebuilds lookup maps to reflect the normalized graph payload.
 * @param {WorkbookGraph} graph
 */
function syncGraphLookups(graph) {
  state.nodeIndex = new Map();
  state.lookupEntries = [];
  state.lookupMap = new Map();
  state.nameToId = new Map();

  (graph?.nodes || []).forEach((node) => {
    if (!node || !node.id) return;
    state.nodeIndex.set(node.id, node);
    const key = normalizeName(node.rawName || node.name);
    if (key && !state.nameToId.has(key)) {
      state.nameToId.set(key, node.id);
    }
    if (node.name && !state.lookupMap.has(node.name)) {
      state.lookupMap.set(node.name, node.id);
    }
    state.lookupEntries.push({
      key,
      label: `${node.name} (${node.type})`,
      id: node.id,
    });
  });

  state.lookupEntries.sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Normalizes Tableau captions for case-insensitive lookup and deduping.
 * @param {string} name
 * @returns {string}
 */
function normalizeName(name) {
  return (name || '')
    .replace(NAME_NORMALIZER, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Produces a friendly label by removing Tableau's square-bracket prefixes.
 * @param {string} name
 * @returns {string}
 */
function displayName(name) {
  return (name || '').replace(NAME_NORMALIZER, '').trim() || name;
}

/**
 * Produces a human-friendly datasource label using connection hints when present.
 * @param {{name?:string, caption?:string, connections?:Array<object>}} datasource
 * @returns {string}
 */
function friendlyDatasourceName(datasource) {
  if (!datasource) return 'Unnamed datasource';
  const base = datasource.name || datasource.caption || 'Unnamed datasource';
  const hints = new Set();
  (datasource.connections || []).forEach((conn) => {
    const candidates = [conn.caption, conn.class, conn.type, conn.warehouse, conn.dbname];
    candidates.forEach((candidate) => {
      const hint = formatDatasourceHint(candidate);
      if (hint) hints.add(hint);
    });
  });
  if (hints.size) {
    return `${base} (${Array.from(hints).join(', ')})`;
  }
  if (/federated/i.test(base)) {
    return 'Federated source';
  }
  return base;
}

function formatDatasourceHint(value) {
  const text = (value || '').trim();
  if (!text) return '';
  return text
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

/**
 * Creates a slug-safe string for use in node IDs.
 * @param {string} text
 * @returns {string}
 */
function slugify(text) {
  return (text || '')
    .toLowerCase()
    .replace(NAME_NORMALIZER, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Clears the Cytoscape canvas and draws the provided graph elements.
 * Also refreshes selection state, layout defaults, and isolation mode.
 * @param {WorkbookGraph} graph
 */
function drawGraph(graph) {
  if (!state.cy) {
    throw new Error('Cytoscape instance not initialized');
  }

  try {
    if (!graph || typeof graph !== 'object') {
      throw new Error('Invalid graph object provided to drawGraph');
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
      console.warn('Edge references missing node', edge);
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
    console.warn('No edges parsed — check parser.');
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

  if (typeof setIsolatedMode === 'function') {
    setIsolatedMode('unhide');
  }

  fitAll(100);
  setLayoutButton('Auto');

  console.log('Graph ready:', state.cy.nodes().length, 'nodes /', state.cy.edges().length, 'edges');
  } catch (err) {
    console.error('[drawGraph] Failed:', err);
    showError('Failed to render graph', err);
    throw err;
  }
}

/**
 * Shows/hides nodes based on the active filter state and recalculates isolation mode.
 * @param {{rerunLayout?:boolean}} [options]
 */
function applyFilters(options = {}) {
  if (!state.cy) return;
  state.cy.batch(() => {
    state.cy.nodes().forEach((node) => {
      const data = node.data();
      let visible = Boolean(state.filters[data.type]);
      if (visible && data.type === 'CalculatedField') {
        if (state.filters.lodOnly) {
          visible = data.isLOD;
        }
        if (visible && state.filters.tableCalcOnly) {
          visible = data.isTableCalc;
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
 * Expands the closed neighborhood around the selected node by N hops.
 * Falls back to the UI dropdown value when depth is omitted.
 * @param {number} [depth]
 */
function expandNeighbors(depth) {
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
    setStatus('Select a node first to expand neighbors');
    return;
  }
  const node = selected[0];
  focusOnNode(node.id(), { depth: normalizedDepth, center: true, skipRelayout: true });

  setIsolatedMode(state.isolatedMode || 'unhide');
  fitAll(80);
}

/**
 * Fits the viewport to a specific Cytoscape collection while respecting visibility.
 * @param {cy.Collection} elements
 * @param {number} [padding]
 */
function fitToElements(elements, padding = 80) {
  if (!state.cy) return;
  const visible = elements.filter(':visible');
  if (visible.length) {
    state.cy.fit(visible, padding);
  } else {
    fitAll(padding);
  }
}

/**
 * Applies the default force-directed layout (Bilkent when available).
 */
function runForceLayout() {
  if (!state.cy) return;
  const nm = (typeof hasBilkent !== 'undefined' && hasBilkent) ? 'cose-bilkent' : 'cose';
  state.cy
    .layout({
      name: nm,
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
}

/**
 * Applies Cytoscape's grid layout for dense workbook maps.
 */
function runGridLayout() {
  if (!state.cy) return;
  state.cy.layout({ name: 'grid', fit: true, avoidOverlap: true, condense: true, padding: 80 }).run();
  state.cy.nodes().unlock();
  state.cy.nodes().grabify();
  setLayoutButton('Grid');
}

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
 * Uses a breadth-first layout to highlight dashboard/worksheet hierarchy.
 */
function runHierarchyLayout() {
  if (!state.cy) return;
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
 * Places nodes into concentric rings ordered by node type.
 */
function runCenteredHierarchyLayout() {
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
 * Centers concentric rings around the current selection (or fallbacks).
 */
function runCenteredFromSelectionLayout() {
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
  const rootName = root?.data('name') || root?.id() || 'Selection';
  setLayoutButton(`Centered from ${rootName}`);
}

(function bindHopMenu() {
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
    const hops = parseInt(item.dataset.hop, 10) || HOP_MIN;
    if (typeof onHopChange === 'function') onHopChange(hops);
    close();
  });

  document.addEventListener('click', (event) => {
    if (event.target === btn) return;
    if (menu.contains(event.target)) return;
    close();
  });
})();

// Lightweight controller for the custom layout dropdown menu.
(function bindLayoutMenu() {
  const dd = document.getElementById('layoutDropdown');
  const btn = document.getElementById('layoutMenuBtn');
  const menu = document.getElementById('layoutMenu');
  if (!dd || !btn || !menu) return;

  const close = () => {
    dd.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    dd.classList.toggle('open');
    btn.setAttribute('aria-expanded', dd.classList.contains('open') ? 'true' : 'false');
  });

  menu.addEventListener('click', (e) => {
    const item = e.target.closest('[data-layout]');
    if (!item) return;
    const kind = item.dataset.layout;
    close();
    if (kind === 'force') runForceLayout();
    else if (kind === 'grid') runGridLayout();
    else if (kind === 'hierarchy') runHierarchyLayout();
    else if (kind === 'centered') runCenteredHierarchyLayout();
    else if (kind === 'centered-selected') runCenteredFromSelectionLayout();
  });

  document.addEventListener('click', (e) => {
    if (!dd.contains(e.target)) close();
  });
})();

/**
 * Synchronizes button labels and menu state for the isolated-node controls.
 * @param {string} mode
 * @returns {string}
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
 * Applies the chosen isolated-node mode (hide/cluster/scatter/unhide).
 * @param {string} mode
 */
function setIsolatedMode(mode) {
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
 * Returns the closed neighborhood around a Cytoscape node for a given hop depth.
 * @param {cy.NodeSingular} node
 * @param {number} [depth]
 * @returns {cy.Collection}
 */
function getNeighborhood(node, depth = 1) {
  if (!node || typeof node.closedNeighborhood !== 'function') {
    return node;
  }
  let hood = node.closedNeighborhood();
  for (let i = 1; i < depth; i += 1) {
    hood = hood.union(hood.closedNeighborhood());
  }
  return hood;
}

/**
 * Focuses the graph on a node, highlighting its neighborhood and syncing UI panels.
 * @param {string} id
 * @param {{depth?:number, center?:boolean, fitPadding?:number, skipRelayout?:boolean}} [options]
 */
function focusOnNode(id, options = {}) {
  if (!state.cy) return;
  const node = state.cy.getElementById(id);
  if (!node || !node.length) return;

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

  renderDetails(node.data());
  syncListSelection(id);

  if (!options.skipRelayout) {
    setIsolatedMode(state.isolatedMode || 'unhide');
  }
}

/**
 * Finds the best node match for a search query and focuses it in the graph.
 * @param {string} query
 */
function jumpToNode(query) {
  if (!state.cy) return;
  const normalized = normalizeName(query);
  let matchId = state.nameToId.get(normalized);
  if (!matchId) {
    const entry = state.lookupEntries.find((item) => item.label.toLowerCase().includes(normalized));
    if (entry) {
      matchId = entry.id;
    }
  }
  if (!matchId) {
    setStatus(`No node matching "${query}".`);
    return;
  }
  focusOnNode(matchId, { depth: 1, center: true });
}

/**
 * Populates sidebar lists for nodes, sheets, calculations, and parameters.
 * Also refreshes the datalist used by the search box.
 * @param {object} meta
 */
function populateLists(meta) {
  const nodesList = document.getElementById('list-nodes');
  const sheetsList = document.getElementById('list-sheets');
  const calcsList = document.getElementById('list-calcs');
  const paramsList = document.getElementById('list-params');
  const datalist = document.getElementById('node-names');

  if (!nodesList || !sheetsList || !calcsList || !paramsList || !datalist) return;

  nodesList.innerHTML = '';
  sheetsList.innerHTML = '';
  calcsList.innerHTML = '';
  paramsList.innerHTML = '';
  datalist.innerHTML = '';

  const sortedNodes = [...(state.graph?.nodes || [])].sort((a, b) => {
    if (a.type === b.type) {
      return a.name.localeCompare(b.name);
    }
    return a.type.localeCompare(b.type);
  });

  sortedNodes.forEach((node) => {
    nodesList.appendChild(createListItem(`${node.name} · ${node.type}`, node.id));
  });

  (meta.worksheets || []).forEach((worksheet) => {
    const worksheetIds = state.graph?.nodes.filter((node) => node.type === 'Worksheet' && node.rawName === worksheet.name) || [];
    const nodeId = worksheetIds.length ? worksheetIds[0].id : null;
    // Worksheets can appear multiple times (dashboards). Use the first matching node ID.
    sheetsList.appendChild(createListItem(worksheet.name, nodeId));
  });

  (state.graph?.nodes.filter((node) => node.type === 'CalculatedField') || []).forEach((node) => {
    calcsList.appendChild(createListItem(node.name, node.id));
  });

  (state.graph?.nodes.filter((node) => node.type === 'Parameter') || []).forEach((node) => {
    paramsList.appendChild(createListItem(node.name, node.id));
  });

  const seenValues = new Set();
  (state.graph?.nodes || []).forEach((node) => {
    if (!seenValues.has(node.name)) {
      seenValues.add(node.name);
      const option = document.createElement('option');
      option.value = node.name;
      datalist.appendChild(option);
    }
  });
}

/**
 * Builds a sidebar list item button that focuses the associated node on click.
 * @param {string} label
 * @param {string} [nodeId]
 * @returns {HTMLLIElement}
 */
function createListItem(label, nodeId) {
  const li = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  if (nodeId) {
    button.dataset.nodeId = nodeId;
    button.addEventListener('click', () => focusOnNode(nodeId, { depth: 1, center: true }));
  } else {
    button.disabled = true;
  }
  li.appendChild(button);
  return li;
}

/**
 * Highlights the sidebar entry for the currently selected node.
 * @param {string|null} nodeId
 */
function syncListSelection(nodeId) {
  document.querySelectorAll('.tab-panel button[data-node-id]').forEach((button) => {
    button.classList.toggle('active', button.dataset.nodeId === nodeId);
  });
}

/**
 * Updates the right-hand details pane with metadata for the selected node.
 * @param {object|null} nodeData
 */
function renderDetails(nodeData) {
  const panel = document.getElementById('details');
  if (!panel) return;
  if (!nodeData) {
    panel.innerHTML = '<h2>No selection</h2><p>Load a workbook and choose a node to see details.</p>';
    return;
  }

  const lines = [];
  const headingTitle = nodeData.rawId ? ` title="${escapeHtml(nodeData.rawId)}"` : '';
  lines.push(`<h2${headingTitle}>${escapeHtml(nodeData.name)}</h2>`);
  const infoBits = [escapeHtml(nodeData.type)];
  if (nodeData.datasource) {
    const dsTitle = nodeData.datasourceId ? ` title="${escapeHtml(nodeData.datasourceId)}"` : '';
    infoBits.push(`Datasource: <span${dsTitle}>${escapeHtml(nodeData.datasource)}</span>`);
  }
  if (nodeData.datatype) infoBits.push(`Type: ${escapeHtml(nodeData.datatype)}`);
  lines.push(`<p class="detail-type">${infoBits.join(' • ')}</p>`);

  let formulaInfo = null;
  if (nodeData.type === 'CalculatedField') {
    const rawFormulaText =
      nodeData.formula ||
      nodeData.expression ||
      nodeData.caption ||
      nodeData.rawFormula ||
      '';
    const formulaDisplayText = rawFormulaText ? String(rawFormulaText) : '—';
    const normalizedFormula = String(rawFormulaText).toUpperCase();
    formulaInfo = {
      text: formulaDisplayText,
      hasLODBadge: normalizedFormula.includes('{') && normalizedFormula.includes('}'),
      hasTableCalcBadge:
        Boolean(nodeData.isTableCalc) ||
        normalizedFormula.includes('WINDOW_') ||
        normalizedFormula.includes('RUNNING_'),
    };
    lines.push('<h3 class="formula-heading">Formula</h3>');
    lines.push('<pre class="formula"></pre>');
    const flags = [];
    if (nodeData.isLOD) flags.push('LOD');
    if (nodeData.isTableCalc) flags.push('Table Calc');
    if (nodeData.calcClass) flags.push(escapeHtml(nodeData.calcClass));
    if (flags.length) {
      lines.push(`<p><strong>Flags:</strong> ${flags.join(' • ')}</p>`);
    }
    if (nodeData.references?.fields?.length) {
      lines.push(renderEntityChipList('Referenced fields', nodeData.references.fields));
    }
    if (nodeData.references?.parameters?.length) {
      lines.push(renderEntityChipList('Referenced parameters', nodeData.references.parameters));
    }
    if (nodeData.usedInWorksheets?.length) {
      lines.push(renderList('Worksheets', nodeData.usedInWorksheets.map((name) => resolveEntity(name).name)));
    }
    if (nodeData.dashboards?.length) {
      lines.push(renderList('Dashboards', nodeData.dashboards.map((name) => resolveEntity(name).name)));
    }
  } else if (nodeData.type === 'Field') {
    if (nodeData.role) {
      lines.push(`<p><strong>Role:</strong> ${escapeHtml(nodeData.role)}</p>`);
    }
    if (nodeData.defaultAggregation) {
      lines.push(`<p><strong>Default aggregation:</strong> ${escapeHtml(nodeData.defaultAggregation)}</p>`);
    }
    if (nodeData.referencedByCalcs?.length) {
      lines.push(renderList('Used by calculations', nodeData.referencedByCalcs.map((name) => resolveEntity(name).name)));
    }
    if (nodeData.usedInWorksheets?.length) {
      lines.push(renderList('Worksheets', nodeData.usedInWorksheets.map((name) => resolveEntity(name).name)));
    }
    if (nodeData.dashboards?.length) {
      lines.push(renderList('Dashboards', nodeData.dashboards.map((name) => resolveEntity(name).name)));
    }
  } else if (nodeData.type === 'Worksheet') {
    if (nodeData.fieldsUsed?.length) {
      lines.push(renderList('Fields & calcs', nodeData.fieldsUsed.map((name) => resolveEntity(name).name)));
    }
    if (nodeData.dashboards?.length) {
      lines.push(renderList('Dashboards', nodeData.dashboards.map((name) => resolveEntity(name).name)));
    }
  } else if (nodeData.type === 'Dashboard') {
    if (nodeData.worksheets?.length) {
      lines.push(renderList('Worksheets', nodeData.worksheets.map((name) => resolveEntity(name).name)));
    }
  } else if (nodeData.type === 'Parameter') {
    if (nodeData.datatype) {
      lines.push(`<p><strong>Datatype:</strong> ${escapeHtml(nodeData.datatype)}</p>`);
    }
    if (nodeData.currentValue) {
      lines.push(`<p><strong>Current value:</strong> ${escapeHtml(nodeData.currentValue)}</p>`);
    }
    if (nodeData.usedInCalcs?.length) {
      lines.push(renderList('Used in calculations', nodeData.usedInCalcs.map((name) => resolveEntity(name).name)));
    }
  }

  panel.innerHTML = lines.join('');

  // Render formulas via textContent so user-authored markup never executes and their spacing stays intact.
  // Chip detection leans on brace/keyword heuristics (plus the node flags) to highlight LOD and Table Calc formulas.
  if (formulaInfo) {
    const formulaEl = panel.querySelector('.formula');
    if (formulaEl) {
      formulaEl.textContent = formulaInfo.text;
    }
    const headingEl = panel.querySelector('.formula-heading');
    if (headingEl) {
      if (formulaInfo.hasLODBadge) {
        const lodChip = document.createElement('span');
        lodChip.className = 'chip chip-lod';
        lodChip.textContent = 'LOD';
        headingEl.appendChild(lodChip);
      }
      if (formulaInfo.hasTableCalcBadge) {
        const tableChip = document.createElement('span');
        tableChip.className = 'chip chip-table';
        tableChip.textContent = 'Table Calc';
        headingEl.appendChild(tableChip);
      }
    }
  }
}

/**
 * Renders a titled unordered list for detail panel sections.
 * @param {string} title
 * @param {string[]} items
 * @returns {string}
 */
function renderList(title, items) {
  if (!items || !items.length) return '';
  const li = items.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
  return `<h3>${escapeHtml(title)}</h3><ul>${li}</ul>`;
}

function renderEntityChipList(title, rawIds) {
  if (!rawIds || !rawIds.length) return '';
  const li = rawIds
    .map((rawId) => {
      const entity = resolveEntity(rawId);
      const type = entity.type ? escapeHtml(entity.type) : 'Unknown';
      const label = escapeHtml(entity.name || displayName(rawId));
      const tooltip = escapeHtml(entity.original || rawId);
      return `<li title="${tooltip}"><span class="type-chip">${type}</span> ${label}</li>`;
    })
    .join('');
  return `<h3>${escapeHtml(title)}</h3><ul>${li}</ul>`;
}

function resolveEntity(rawValue) {
  const original = rawValue || '';
  const trimmed = original.trim();
  const unbracketed = trimmed.replace(NAME_NORMALIZER, '').trim();
  const candidates = [original, trimmed, unbracketed];
  let name = '';
  let type = '';
  let datasource = '';
  candidates.forEach((candidate) => {
    if (!candidate) return;
    if (!name && state.idToName.has(candidate)) {
      name = state.idToName.get(candidate) || name;
    }
    if (!type && state.idToType.has(candidate)) {
      type = state.idToType.get(candidate) || type;
    }
    if (!datasource && state.idToDatasource.has(candidate)) {
      datasource = state.idToDatasource.get(candidate) || datasource;
    }
  });
  if (!name) {
    const fallback = displayName(unbracketed || trimmed || original);
    name = fallback || 'Unnamed';
  }
  if (!type || !datasource) {
    const nodeId = state.lookupMap.get(name) || state.nameToId.get(normalizeName(name));
    if (nodeId) {
      const node = state.nodeIndex.get(nodeId);
      if (node) {
        if (!type) type = node.type;
        if (!datasource) datasource = node.datasource || datasource;
        if (!name) name = node.name;
      }
    }
  }
  if (!type) type = 'Unknown';
  return { name, type, datasource, original: trimmed || original, canonical: unbracketed };
}

/**
 * Escapes HTML special characters for safe template interpolation.
 * @param {string} value
 * @returns {string}
 */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Generates the Markdown export summarizing the workbook for human readers.
 * @param {object} meta
 * @returns {string}
 */
function buildMarkdown(meta) {
  const lines = [];
  lines.push('# Tableau Workbook Documentation');
  lines.push('');
  lines.push(`- Source: ${meta.workbook_path}`);
  if (state.fileInfo) {
    lines.push(`- File size: ${formatBytes(state.fileInfo.size)}`);
  }
  lines.push(`- Generated: ${state.buildTimestamp}`);
  lines.push('');

  meta.datasources.forEach((datasource) => {
    lines.push(`## Datasource: ${datasource.name}`);
    lines.push('');
    datasource.fields.forEach((field) => {
      const base = `- ${field.name} (${field.datatype || 'n/a'})`;
      if (field.is_calculated && field.calculation?.formula) {
        lines.push(`${base} — calculated`);
        lines.push('');
        lines.push('```tableau');
        lines.push(field.calculation.formula);
        lines.push('```');
        lines.push('');
      } else {
        lines.push(base);
      }
    });
    lines.push('');
  });

  if (meta.parameters.length) {
    lines.push('## Parameters');
    lines.push('');
    meta.parameters.forEach((param) => {
      lines.push(`- ${param.name} (${param.datatype || 'n/a'}) default: ${param.current_value || '—'}`);
    });
    lines.push('');
  }

  if (meta.worksheets.length) {
    lines.push('## Worksheets');
    lines.push('');
    meta.worksheets.forEach((worksheet) => {
      lines.push(`### ${worksheet.name}`);
      lines.push('');
      (worksheet.fields_used || []).forEach((field) => {
        lines.push(`- ${field}`);
      });
      lines.push('');
    });
  }

  if (meta.dashboards.length) {
    lines.push('## Dashboards');
    lines.push('');
    meta.dashboards.forEach((dashboard) => {
      lines.push(`### ${dashboard.name}`);
      (dashboard.worksheets || []).forEach((ws) => {
        lines.push(`- ${ws}`);
      });
      lines.push('');
    });
  }

  lines.push('## Lineage');
  lines.push('');
  lines.push('### Field → Field');
  meta.lineage.field_to_field.forEach(([from, to]) => {
    lines.push(`- ${from} → ${to}`);
  });
  lines.push('');
  lines.push('### Field → Worksheet');
  meta.lineage.field_to_sheet.forEach(([from, to]) => {
    lines.push(`- ${from} → ${to}`);
  });
  lines.push('');

  return lines.join('\n');
}

/**
 * Builds a Graphviz DOT file representing field and sheet lineage edges.
 * @param {object} meta
 * @returns {string}
 */
function buildDot(meta) {
  const lines = [];
  lines.push('digraph Tableau {');
  lines.push('  rankdir=LR;');
  lines.push('  node [shape=box, style=filled, fillcolor="white", color="#3b82f6"];');
  meta.lineage.field_to_field.forEach(([from, to]) => {
    lines.push(`  "${from.replace(/"/g, '\\"')}" -> "${to.replace(/"/g, '\\"')}";`);
  });
  meta.lineage.field_to_sheet.forEach(([from, to]) => {
    lines.push(`  "${from.replace(/"/g, '\\"')}" -> "${to.replace(/"/g, '\\"')}" [style=dashed];`);
  });
  lines.push('}');
  return lines.join('\n');
}

/**
 * Triggers a browser download for generated text/blob content.
 * @param {string} filename
 * @param {string|BlobPart} content
 * @param {string} [mime]
 */
function downloadBlob(filename, content, mime = 'text/plain') {
  let url = null;
  try {
    const blob = new Blob([content], { type: mime });
    url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  } catch (error) {
    console.error('Download failed:', error);
    showError('Failed to download file', error);
  } finally {
    // Always revoke the URL to prevent memory leaks
    if (url) {
      URL.revokeObjectURL(url);
    }
  }
}

/**
 * Converts byte counts into a human-readable string.
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = units.shift();
  while (value >= 1024 && units.length) {
    value /= 1024;
    unit = units.shift();
  }
  return `${value.toFixed(value > 9 ? 0 : 1)} ${unit}`;
}

/**
 * Refreshes the footer with file metadata and build timestamp.
 */
function updateFooter() {
  const footer = document.getElementById('footer-info');
  if (!footer) return;
  const name = state.fileInfo?.name || 'No file';
  const size = state.fileInfo ? formatBytes(state.fileInfo.size) : '—';
  footer.textContent = `File: ${name} | Size: ${size} | Build: ${state.buildTimestamp}`;
}


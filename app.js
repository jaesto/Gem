const state = {
  cy: null,
  meta: null,
  graph: null,
  nodeIndex: new Map(),
  lookupEntries: [],
  lookupMap: new Map(),
  nameToId: new Map(),
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
  graphResizeObserver: null,
};

const NAME_NORMALIZER = /[\[\]]/g;

function cssVar(name, fallback) {
  if (typeof window === 'undefined' || !window.getComputedStyle) {
    return fallback;
  }
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

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

function showError(msg, err) {
  const el = document.getElementById('errOverlay');
  if (!el) return;
  el.style.display = 'block';
  el.innerHTML =
    '<strong>Error</strong><pre>' +
    (msg || '') +
    (err ? `\n${err.stack || err.message || err}` : '') +
    '</pre>';
  console.error('[viewer]', msg, err);
}

if (typeof window !== 'undefined') {
  window.addEventListener('error', (event) => {
    const detail = event.error || event.message;
    showError('Uncaught error:', detail);
  });
  window.addEventListener('unhandledrejection', (event) => {
    showError('Unhandled promise rejection:', event.reason);
  });
  window.addEventListener('resize', () => {
    if (state.cy) {
      state.cy.resize();
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

function applyCyTheme() {
  if (!state.cy) return;
  const c = themeColors();
  state.cy.style([
    {
      selector: 'node',
      style: {
        label: 'data(name)',
        width: 'label',
        height: 'label',
        padding: '8px',
        shape: 'round-rectangle',
        'background-color': c.field,
        'font-size': '12px',
        color: c.text,
        'text-outline-color': c.outline,
        'text-outline-width': 2,
        'text-wrap': 'wrap',
        'text-max-width': '160px',
        'text-overflow-wrap': 'ellipsis',
        'min-zoomed-font-size': 10,
        'text-opacity': 0.95,
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
        'z-index-compare': 'manual',
        'z-index': 1,
        'line-color': c.edge,
        width: 1.8,
        opacity: 0.95,
        'curve-style': 'bezier',
        'target-arrow-color': c.edge,
        'target-arrow-shape': 'vee',
        label: 'data(rel)',
        'font-size': 9,
        color: c.text,
        'text-outline-color': c.outline,
        'text-outline-width': 2,
        'text-background-color': 'rgba(0,0,0,0.25)',
        'text-background-opacity': 0.35,
        'text-background-padding': 2,
        'text-rotation': 'autorotate',
      },
    },
    { selector: ':selected', style: { 'border-width': 3, 'border-color': c.calc } },
    { selector: '.faded', style: { opacity: 0.18 } },
  ]);
}

function fitAll(pad = 80) {
  if (!state.cy) return;
  requestAnimationFrame(() => {
    const vis = state.cy.elements().filter(':visible');
    if (vis.length > 0) {
      state.cy.fit(vis, pad);
    }
  });
}

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

function bindUI() {
  const openBtn = getEl('openBtn', 'open-workbook-btn');
  const fileInput = getEl('fileInput', 'file-input');
  const dropZone = getEl('dropZone', 'dropzone');
  const fitBtn = getEl('fitBtn', 'fit-btn');
  const layoutBtn = getEl('layoutBtn', 'layout-btn');
  const hopSelect = getEl('hopSelect');
  const isoBtn = getEl('isolatedBtn');
  const isoMenu = getEl('isolatedMenu');
  const themeToggle = getEl('themeBtn', 'theme-toggle');
  const searchForm = getEl('search-form');
  const searchBox = getEl('search', 'search-box');
  const filtersDropdown = getEl('filtersDropdown', 'filters-dropdown');
  const exportDropdown = getEl('exportDropdown', 'export-dropdown');

  if (openBtn && fileInput) {
    openBtn.addEventListener('click', () => fileInput.click());
  }

  if (fileInput) {
    fileInput.addEventListener('change', async (event) => {
      const input = event.target;
      const files = input?.files;
      const file = files && files[0];
      if (!file) return;
      try {
        await handleFile(file);
      } catch (error) {
        if (!error?.__handledByOverlay) {
          showError('Failed to read workbook', error);
          setStatus(`Failed to read workbook: ${error?.message || 'Unknown error.'}`);
        }
      } finally {
        if (input) {
          input.value = '';
        }
      }
    });
  }

  if (dropZone && fileInput) {
    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('keypress', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        fileInput.click();
      }
    });
  }

  if (dropZone) {
    dropZone.addEventListener('dragenter', (event) => {
      event.preventDefault();
      dropZone.classList.add('dragover');
    });
    dropZone.addEventListener('dragover', (event) => {
      event.preventDefault();
      dropZone.classList.add('dragover');
    });
    dropZone.addEventListener('dragleave', () => {
      dropZone.classList.remove('dragover');
    });
    dropZone.addEventListener('drop', async (event) => {
      event.preventDefault();
      dropZone.classList.remove('dragover');
      try {
        const dt = event.dataTransfer;
        let file = dt?.files?.[0] || null;
        if (!file && dt?.items?.length) {
          const item = Array.from(dt.items).find((entry) => entry.kind === 'file');
          if (item) {
            file = item.getAsFile();
          }
        }
        if (!file) {
          showError('No file dropped');
          setStatus('No file dropped. Please provide a .twb or .twbx file.');
          return;
        }
        await handleFile(file);
      } catch (error) {
        if (!error?.__handledByOverlay) {
          showError('Failed to read workbook', error);
          setStatus(`Failed to read workbook: ${error?.message || 'Unknown error.'}`);
        }
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
      const layout = runAutoLayout(() => fitAll(80));
      if (!layout) {
        fitAll(80);
      }
    });
  }

  if (hopSelect) {
    hopSelect.addEventListener('change', () => {
      const value = parseInt(hopSelect.value, 10);
      if (!Number.isNaN(value)) {
        expandNeighbors(value);
      }
    });
  }

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

function bootGraph() {
  const graphContainerEl = document.getElementById('graph');
  if (!graphContainerEl) {
    throw new Error('Graph container missing.');
  }

  state.cy = cytoscape({
    container: graphContainerEl,
    wheelSensitivity: 0.2,
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

  if (state.graphResizeObserver) {
    try {
      state.graphResizeObserver.disconnect();
    } catch (error) {
      console.warn('Failed to disconnect previous ResizeObserver', error);
    }
    state.graphResizeObserver = null;
  }

  if (window.ResizeObserver && graphContainerEl) {
    const ro = new ResizeObserver(() => {
      if (state.cy) {
        state.cy.resize();
      }
    });
    ro.observe(graphContainerEl);
    state.graphResizeObserver = ro;
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
}

function setStatus(text) {
  const statusEl = document.getElementById('status');
  if (!statusEl) return;
  statusEl.textContent = text;
}

async function handleFile(file) {
  if (!file) {
    const error = new Error('No file provided.');
    error.__handledByOverlay = true;
    showError('Failed to read workbook', error);
    setStatus('Failed to read workbook: No file provided.');
    updateFooter();
    return;
  }

  const fileName = file.name || 'Workbook';
  const extension = (() => {
    const name = file.name || '';
    const dotIndex = name.lastIndexOf('.');
    if (dotIndex === -1) {
      return '';
    }
    return name.slice(dotIndex + 1).toLowerCase();
  })();

  if (extension !== 'twb' && extension !== 'twbx') {
    setStatus('Unsupported file type. Please provide a .twb or .twbx file.');
    updateFooter();
    return;
  }

  setStatus(`Loading ${fileName}...`);

  try {
    let workbookText = '';

    if (extension === 'twbx') {
      const buffer = await file.arrayBuffer();
      const zip = await JSZip.loadAsync(buffer);
      const entries = Object.values(zip.files || {});
      const workbookEntry = entries.find((entry) => entry.name?.toLowerCase().endsWith('.twb'));
      if (!workbookEntry) {
        showError('No .twb found inside .twbx');
        setStatus('Failed to read workbook: No .twb found inside .twbx.');
        return;
      }
      workbookText = await workbookEntry.async('text');
    } else {
      workbookText = await file.text();
    }

    const meta = parseWorkbookXML(workbookText);
    if (!meta) {
      setStatus('Failed to read workbook: Unable to parse workbook XML.');
      return;
    }

    meta.workbook_path = file.name || 'Browser Upload';
    state.meta = meta;
    state.fileInfo = {
      name: file.name,
      size: file.size,
    };

    const graph = buildGraphJSON(meta);
    state.graph = graph;
    populateLists(meta);
    drawGraph(graph);
    setStatus(`Loaded ${fileName}`);
  } catch (error) {
    showError('Failed to read workbook', error);
    setStatus(`Failed to read workbook: ${error?.message || 'Unknown error.'}`);
    if (error && typeof error === 'object') {
      error.__handledByOverlay = true;
    }
    throw error;
  } finally {
    updateFooter();
  }
}

function parseWorkbookXML(xmlText) {
  const parser = new DOMParser();
  const xml = parser.parseFromString(xmlText, 'text/xml');
  const errorNode = xml.querySelector('parsererror');
  if (errorNode) {
    const message = errorNode.textContent?.trim() || 'Unable to parse workbook XML.';
    const error = new Error(message);
    error.__handledByOverlay = true;
    showError('XML parse error', error);
    return null;
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
    const name = getAttr(datasourceNode, 'name') || getAttr(datasourceNode, 'caption') || `Datasource ${index + 1}`;
    const datasource = {
      name,
      fields: [],
    };

    const columnNodes = Array.from(datasourceNode.querySelectorAll('column'));
    columnNodes.forEach((columnNode, columnIndex) => {
      const fieldName = getAttr(columnNode, 'caption') || getAttr(columnNode, 'name') || `Field ${columnIndex + 1}`;
      const datatype = getAttr(columnNode, 'datatype') || getAttr(columnNode, 'role') || '';
      const defaultAggregation = getAttr(columnNode, 'default-aggregation') || getAttr(columnNode, 'aggregation') || '';
      const role = getAttr(columnNode, 'role') || '';
      const calculationNode = columnNode.querySelector('calculation');
      const field = {
        name: fieldName,
        datatype,
        default_aggregation: defaultAggregation,
        role,
        is_calculated: Boolean(calculationNode),
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
    const name = getAttr(parameterNode, 'name') || getAttr(parameterNode, 'caption') || `Parameter ${index + 1}`;
    const datatype = getAttr(parameterNode, 'datatype') || '';
    const currentValueNode = parameterNode.querySelector('current-value');
    const currentValue = getAttr(parameterNode, 'value') || (currentValueNode ? currentValueNode.textContent : '') || '';
    meta.parameters.push({
      name,
      datatype,
      current_value: currentValue,
    });
  });

  const worksheetNodes = Array.from(xml.querySelectorAll('worksheets > worksheet'));
  worksheetNodes.forEach((worksheetNode, index) => {
    const name = getAttr(worksheetNode, 'name') || `Worksheet ${index + 1}`;
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
      name,
      fields_used: Array.from(fieldsUsed),
    };
    meta.worksheets.push(worksheet);
  });

  const dashboardNodes = Array.from(xml.querySelectorAll('dashboards > dashboard'));
  dashboardNodes.forEach((dashboardNode, index) => {
    const name = getAttr(dashboardNode, 'name') || `Dashboard ${index + 1}`;
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
}

function getAttr(node, attr) {
  if (!node) return '';
  return node.getAttribute(attr) || '';
}

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

function buildGraphJSON(meta) {
  state.nodeIndex = new Map();
  state.lookupEntries = [];
  state.lookupMap = new Map();
  state.nameToId = new Map();

  const nodes = [];
  const edges = [];
  const edgeKeys = new Set();
  const lookupEntries = [];
  const usedIds = new Set();

  const nameToIds = {
    Field: new Map(),
    CalculatedField: new Map(),
    Worksheet: new Map(),
    Dashboard: new Map(),
    Parameter: new Map(),
  };

  const fieldUsage = new Map();
  const fieldFeeds = new Map();
  const paramUsage = new Map();
  const worksheetDashboards = new Map();

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

  function makeNodeId(prefix, baseName) {
    let slug = slugify(baseName);
    if (!slug) slug = `${prefix}-${usedIds.size + 1}`;
    let id = `${prefix}:${slug}`;
    let counter = 2;
    while (usedIds.has(id)) {
      id = `${prefix}:${slug}-${counter}`;
      counter += 1;
    }
    usedIds.add(id);
    return id;
  }

  function registerName(map, type, key, id) {
    if (!map[type].has(key)) {
      map[type].set(key, []);
    }
    map[type].get(key).push(id);
  }

  function registerNode(node) {
    nodes.push(node);
    const key = normalizeName(node.rawName || node.name);
    registerName(nameToIds, node.type, key, node.id);
    lookupEntries.push({
      key,
      label: `${node.name} (${node.type})`,
      id: node.id,
    });
    if (!state.nameToId.has(key)) {
      state.nameToId.set(key, node.id);
    }
    if (!state.lookupMap.has(node.name)) {
      state.lookupMap.set(node.name, node.id);
    }
    state.nodeIndex.set(node.id, node);
  }

  function addEdge(from, to, rel) {
    if (!from || !to) return;
    const edgeKey = `${from}->${to}:${rel}`;
    if (edgeKeys.has(edgeKey)) return;
    edgeKeys.add(edgeKey);
    edges.push({
      id: edgeKey,
      from,
      to,
      rel,
      type: rel,
    });
  }

  meta.datasources.forEach((datasource, dsIndex) => {
    datasource.fields.forEach((field, index) => {
      const isCalc = Boolean(field.is_calculated);
      const type = isCalc ? 'CalculatedField' : 'Field';
      const baseName = field.name || `Field ${dsIndex + 1}.${index + 1}`;
      const node = {
        id: makeNodeId(isCalc ? 'calc' : 'field', baseName),
        type,
        name: displayName(baseName),
        rawName: baseName,
        datasource: datasource.name,
        datatype: field.datatype || '',
        role: field.role || '',
        defaultAggregation: field.default_aggregation || '',
        references: field.references || { fields: [], parameters: [] },
        formula: field.calculation ? field.calculation.formula || '' : '',
        calcClass: field.calculation ? field.calculation.class || '' : '',
      };
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
    const node = {
      id: makeNodeId('param', baseName),
      type: 'Parameter',
      name: displayName(baseName),
      rawName: baseName,
      datatype: parameter.datatype || '',
      currentValue: parameter.current_value || '',
      usedInCalcs: Array.from(paramUsage.get(normalizeName(baseName)) || []),
    };
    registerNode(node);
  });

  meta.worksheets.forEach((worksheet, index) => {
    const baseName = worksheet.name || `Worksheet ${index + 1}`;
    const node = {
      id: makeNodeId('ws', baseName),
      type: 'Worksheet',
      name: baseName,
      rawName: baseName,
      fieldsUsed: worksheet.fields_used.slice(),
      dashboards: Array.from(worksheetDashboards.get(normalizeName(baseName)) || []),
    };
    registerNode(node);
  });

  meta.dashboards.forEach((dashboard, index) => {
    const baseName = dashboard.name || `Dashboard ${index + 1}`;
    const node = {
      id: makeNodeId('db', baseName),
      type: 'Dashboard',
      name: baseName,
      rawName: baseName,
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

  state.lookupEntries = lookupEntries.sort((a, b) => a.label.localeCompare(b.label));

  return { nodes, edges };
}

function normalizeName(name) {
  return (name || '')
    .replace(NAME_NORMALIZER, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function displayName(name) {
  return (name || '').replace(NAME_NORMALIZER, '').trim() || name;
}

function slugify(text) {
  return (text || '')
    .toLowerCase()
    .replace(NAME_NORMALIZER, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function drawGraph(graph) {
  if (!state.cy) return;
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
    nodeEles.push({
      data: { ...node },
      position: {
        x: col * spacing - offsetX,
        y: row * spacing - offsetY,
      },
    });
  });

  edges.forEach((edge) => {
    if (!edge || !edge.id || !edge.from || !edge.to) return;
    if (!nodeIdSet.has(edge.from) || !nodeIdSet.has(edge.to)) {
      console.warn('Edge references missing node', edge);
      return;
    }
    edgeEles.push({ data: { id: edge.id, source: edge.from, target: edge.to, rel: edge.rel || edge.type } });
  });

  if (edgeEles.length === 0) {
    console.warn('No edges parsed — check parser.');
  }

  state.cy.startBatch();
  state.cy.elements().remove();
  state.cy.add(nodeEles);
  state.cy.add(edgeEles);
  state.cy.endBatch();

  state.cy.nodes().show();
  state.cy.edges().show();

  applyCyTheme();

  state.cy.elements().removeClass('faded');
  state.cy.$('node').unselect();
  renderDetails(null);
  syncListSelection(null);
  state.selectedNodeId = null;
  state.lastFocusDepth = 1;

  if (typeof setIsolatedMode === 'function') {
    setIsolatedMode('unhide');
  }

  fitAll(100);

  console.log('Graph ready:', state.cy.nodes().length, 'nodes /', state.cy.edges().length, 'edges');
}

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

function expandNeighbors(depth) {
  if (!state.cy) return;
  const hopSelect = document.getElementById('hopSelect');
  let resolvedDepth = Number.isFinite(depth) ? depth : null;

  if (!resolvedDepth && hopSelect) {
    const selectValue = parseInt(hopSelect.value, 10);
    if (!Number.isNaN(selectValue)) {
      resolvedDepth = selectValue;
    }
  }

  if (!resolvedDepth || Number.isNaN(resolvedDepth)) {
    resolvedDepth = 1;
  }

  resolvedDepth = Math.max(1, Math.min(Math.round(resolvedDepth), 5));

  const selected = state.cy.$('node:selected');
  if (!selected.length) {
    setStatus('Select a node first to expand neighbors');
    return;
  }
  const node = selected[0];
  focusOnNode(node.id(), { depth: resolvedDepth, center: true, skipRelayout: true });

  if (hopSelect && hopSelect.value !== String(resolvedDepth)) {
    const hasOption = Array.from(hopSelect.options).some((option) => option.value === String(resolvedDepth));
    if (hasOption) {
      hopSelect.value = String(resolvedDepth);
    }
  }

  setIsolatedMode(state.isolatedMode || 'unhide');
  fitAll(80);
}

function fitToElements(elements, padding = 80) {
  if (!state.cy) return;
  const visible = elements.filter(':visible');
  if (visible.length) {
    state.cy.fit(visible, padding);
  } else {
    fitAll(padding);
  }
}

function runAutoLayout(onStop) {
  if (!state.cy) return null;
  const layout = state.cy.layout({
    name: layoutName,
    fit: false,
    animate: false,
    padding: 80,
    randomize: false,
    nodeRepulsion: 5200,
    idealEdgeLength: 180,
    gravity: 0.25,
    numIter: 1600,
    tile: true,
  });

  state.activeLayout = layout;

  const clearActive = () => {
    if (state.activeLayout === layout) {
      state.activeLayout = null;
    }
    if (typeof onStop === 'function') {
      onStop();
    }
  };

  if (layout && typeof layout.one === 'function') {
    layout.one('layoutstop', clearActive);
  } else if (layout && typeof layout.on === 'function') {
    layout.on('layoutstop', clearActive);
  }

  layout.run();
  if (!(layout && (typeof layout.one === 'function' || typeof layout.on === 'function'))) {
    clearActive();
  }
  return layout;
}

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

  const hopSelect = document.getElementById('hopSelect');
  if (hopSelect) {
    const normalizedDepth = Math.max(1, Math.min(Math.round(Number.isFinite(depth) ? depth : 1), 5));
    const depthValue = String(normalizedDepth);
    const hasOption = Array.from(hopSelect.options).some((option) => option.value === depthValue);
    if (hasOption && hopSelect.value !== depthValue) {
      hopSelect.value = depthValue;
    }
  }

  if (options.center !== false) {
    fitToElements(neighborhood, options.fitPadding ?? 120);
  }

  renderDetails(node.data());
  syncListSelection(id);

  if (!options.skipRelayout) {
    setIsolatedMode(state.isolatedMode || 'unhide');
  }
}

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

function syncListSelection(nodeId) {
  document.querySelectorAll('.tab-panel button[data-node-id]').forEach((button) => {
    button.classList.toggle('active', button.dataset.nodeId === nodeId);
  });
}

function renderDetails(nodeData) {
  const panel = document.getElementById('details');
  if (!panel) return;
  if (!nodeData) {
    panel.innerHTML = '<h2>No selection</h2><p>Load a workbook and choose a node to see details.</p>';
    return;
  }

  const lines = [];
  lines.push(`<h2>${escapeHtml(nodeData.name)}</h2>`);
  const infoBits = [escapeHtml(nodeData.type)];
  if (nodeData.datasource) infoBits.push(`Datasource: ${escapeHtml(nodeData.datasource)}`);
  if (nodeData.datatype) infoBits.push(`Type: ${escapeHtml(nodeData.datatype)}`);
  lines.push(`<p class="detail-type">${infoBits.join(' • ')}</p>`);

  if (nodeData.type === 'CalculatedField') {
    if (nodeData.formula) {
      lines.push('<h3>Formula</h3>');
      lines.push(`<pre><code>${escapeHtml(nodeData.formula)}</code></pre>`);
    }
    const flags = [];
    if (nodeData.isLOD) flags.push('LOD');
    if (nodeData.isTableCalc) flags.push('Table Calc');
    if (nodeData.calcClass) flags.push(escapeHtml(nodeData.calcClass));
    if (flags.length) {
      lines.push(`<p><strong>Flags:</strong> ${flags.join(' • ')}</p>`);
    }
    if (nodeData.references?.fields?.length) {
      lines.push(renderList('Referenced fields', nodeData.references.fields.map(displayName)));
    }
    if (nodeData.references?.parameters?.length) {
      lines.push(renderList('Referenced parameters', nodeData.references.parameters));
    }
    if (nodeData.usedInWorksheets?.length) {
      lines.push(renderList('Worksheets', nodeData.usedInWorksheets));
    }
    if (nodeData.dashboards?.length) {
      lines.push(renderList('Dashboards', nodeData.dashboards));
    }
  } else if (nodeData.type === 'Field') {
    if (nodeData.role) {
      lines.push(`<p><strong>Role:</strong> ${escapeHtml(nodeData.role)}</p>`);
    }
    if (nodeData.defaultAggregation) {
      lines.push(`<p><strong>Default aggregation:</strong> ${escapeHtml(nodeData.defaultAggregation)}</p>`);
    }
    if (nodeData.referencedByCalcs?.length) {
      lines.push(renderList('Used by calculations', nodeData.referencedByCalcs.map(displayName)));
    }
    if (nodeData.usedInWorksheets?.length) {
      lines.push(renderList('Worksheets', nodeData.usedInWorksheets));
    }
    if (nodeData.dashboards?.length) {
      lines.push(renderList('Dashboards', nodeData.dashboards));
    }
  } else if (nodeData.type === 'Worksheet') {
    if (nodeData.fieldsUsed?.length) {
      lines.push(renderList('Fields & calcs', nodeData.fieldsUsed.map(displayName)));
    }
    if (nodeData.dashboards?.length) {
      lines.push(renderList('Dashboards', nodeData.dashboards));
    }
  } else if (nodeData.type === 'Dashboard') {
    if (nodeData.worksheets?.length) {
      lines.push(renderList('Worksheets', nodeData.worksheets));
    }
  } else if (nodeData.type === 'Parameter') {
    if (nodeData.datatype) {
      lines.push(`<p><strong>Datatype:</strong> ${escapeHtml(nodeData.datatype)}</p>`);
    }
    if (nodeData.currentValue) {
      lines.push(`<p><strong>Current value:</strong> ${escapeHtml(nodeData.currentValue)}</p>`);
    }
    if (nodeData.usedInCalcs?.length) {
      lines.push(renderList('Used in calculations', nodeData.usedInCalcs.map(displayName)));
    }
  }

  panel.innerHTML = lines.join('');
}

function renderList(title, items) {
  if (!items || !items.length) return '';
  const li = items.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
  return `<h3>${escapeHtml(title)}</h3><ul>${li}</ul>`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

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

function downloadBlob(filename, content, mime = 'text/plain') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

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

function updateFooter() {
  const footer = document.getElementById('footer-info');
  if (!footer) return;
  const name = state.fileInfo?.name || 'No file';
  const size = state.fileInfo ? formatBytes(state.fileInfo.size) : '—';
  footer.textContent = `File: ${name} | Size: ${size} | Build: ${state.buildTimestamp}`;
}


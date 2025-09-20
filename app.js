const state = {
  cy: null,
  meta: null,
  graph: null,
  nodeIndex: new Map(),
  lookupEntries: [],
  lookupMap: new Map(),
  nameToId: new Map(),
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
};

const NAME_NORMALIZER = /[\[\]]/g;

document.addEventListener('DOMContentLoaded', () => {
  bootGraph();
  bindUI();
  setStatus('Ready. Drop a Tableau workbook to begin.');
});

function bindUI() {
  const openBtn = document.getElementById('open-workbook-btn');
  const fileInput = document.getElementById('file-input');
  const dropzone = document.getElementById('dropzone');
  const fitBtn = document.getElementById('fit-btn');
  const expand1Btn = document.getElementById('expand-1-btn');
  const expand2Btn = document.getElementById('expand-2-btn');
  const hideIsolatedBtn = document.getElementById('hide-isolated-btn');
  const themeToggle = document.getElementById('theme-toggle');
  const searchForm = document.getElementById('search-form');
  const searchBox = document.getElementById('search-box');
  const filtersDropdown = document.getElementById('filters-dropdown');
  const exportDropdown = document.getElementById('export-dropdown');

  openBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async (event) => {
    const [file] = event.target.files;
    if (file) {
      await handleFile(file);
    }
    event.target.value = '';
  });

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keypress', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      fileInput.click();
    }
  });

  dropzone.addEventListener('dragover', (event) => {
    event.preventDefault();
    dropzone.classList.add('dragover');
  });

  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));

  dropzone.addEventListener('drop', async (event) => {
    event.preventDefault();
    dropzone.classList.remove('dragover');
    if (event.dataTransfer && event.dataTransfer.files.length) {
      await handleFile(event.dataTransfer.files[0]);
    }
  });

  fitBtn.addEventListener('click', () => {
    if (!state.cy) return;
    state.cy.elements().removeClass('cy-dim');
    fitGraph();
  });

  expand1Btn.addEventListener('click', () => expandNeighbors(1));
  expand2Btn.addEventListener('click', () => expandNeighbors(2));
  hideIsolatedBtn.addEventListener('click', hideIsolated);

  filtersDropdown
    .querySelectorAll('input[type="checkbox"]')
    .forEach((checkbox) => {
      checkbox.addEventListener('change', () => {
        const key = checkbox.dataset.filter;
        state.filters[key] = checkbox.checked;
        applyFilters();
      });
    });

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

  themeToggle.addEventListener('click', () => {
    const root = document.documentElement;
    const nextTheme = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', nextTheme);
    themeToggle.textContent = nextTheme === 'dark' ? 'Dark' : 'Light';
    themeToggle.setAttribute('aria-pressed', nextTheme === 'dark');
  });

  searchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const query = searchBox.value.trim();
    if (query) {
      jumpToNode(query);
    }
  });

  searchBox.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      const query = searchBox.value.trim();
      if (query) {
        jumpToNode(query);
      }
    }
  });

  document.querySelectorAll('.tabs button').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.tabs button').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((panel) => panel.classList.remove('active'));
      button.classList.add('active');
      const targetId = button.dataset.tab;
      document.getElementById(targetId).classList.add('active');
    });
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === '/' && document.activeElement !== searchBox) {
      event.preventDefault();
      searchBox.focus();
      searchBox.select();
    }
    if (event.key.toLowerCase() === 'f' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const tag = document.activeElement?.tagName?.toLowerCase();
      if (tag !== 'input' && tag !== 'textarea') {
        event.preventDefault();
        fitGraph();
      }
    }
  });

  updateFooter();
}

function bootGraph() {
  const container = document.getElementById('graph');
  if (!container) {
    throw new Error('Graph container missing.');
  }

  state.cy = cytoscape({
    container,
    wheelSensitivity: 0.2,
    autoungrabify: false,
    style: [
      {
        selector: 'node',
        style: {
          'background-color': '#3b82f6',
          color: '#fff',
          label: 'data(name)',
          'font-size': 11,
          'text-wrap': 'wrap',
          'text-valign': 'center',
          'text-halign': 'center',
          'text-max-width': 120,
          'border-width': 1,
          'border-color': '#1d4ed8',
          'overlay-opacity': 0,
        },
      },
      {
        selector: 'node[type = "Field"]',
        style: {
          'background-color': '#22c55e',
          'border-color': '#15803d',
        },
      },
      {
        selector: 'node[type = "CalculatedField"]',
        style: {
          'background-color': '#f97316',
          'border-color': '#ea580c',
          shape: 'round-rectangle',
        },
      },
      {
        selector: 'node[type = "Worksheet"]',
        style: {
          'background-color': '#3b82f6',
          'border-color': '#1d4ed8',
          shape: 'rectangle',
        },
      },
      {
        selector: 'node[type = "Dashboard"]',
        style: {
          'background-color': '#8b5cf6',
          'border-color': '#6d28d9',
          shape: 'hexagon',
        },
      },
      {
        selector: 'node[type = "Parameter"]',
        style: {
          'background-color': '#14b8a6',
          'border-color': '#0f766e',
          shape: 'diamond',
        },
      },
      {
        selector: 'edge',
        style: {
          width: 1.5,
          'line-color': '#94a3b8',
          'target-arrow-color': '#94a3b8',
          'target-arrow-shape': 'triangle',
          'curve-style': 'bezier',
          'arrow-scale': 1.1,
          'font-size': 9,
          color: '#475569',
          label: 'data(type)',
        },
      },
      {
        selector: '.cy-dim',
        style: {
          opacity: 0.1,
        },
      },
    ],
  });

  state.cy.on('tap', 'node', (event) => {
    const node = event.target;
    focusOnNode(node.id(), { depth: 1, center: true });
  });

  state.cy.on('tap', (event) => {
    if (event.target === state.cy) {
      state.cy.elements().removeClass('cy-dim');
      state.cy.$('node').unselect();
      renderDetails(null);
      state.selectedNodeId = null;
      syncListSelection(null);
    }
  });
}

function setStatus(text) {
  const el = document.getElementById('status-text');
  if (el) {
    el.textContent = text;
  }
}

async function handleFile(file) {
  try {
    setStatus(`Loading ${file.name}...`);
    let workbookText = '';
    const ext = file.name.split('.').pop().toLowerCase();
    if (ext === 'twbx') {
      const buffer = await file.arrayBuffer();
      const zip = await JSZip.loadAsync(buffer);
      let workbookEntry = null;
      zip.forEach((relativePath, entry) => {
        if (!workbookEntry && relativePath.toLowerCase().endsWith('.twb')) {
          workbookEntry = entry;
        }
      });
      if (!workbookEntry) {
        throw new Error('No .twb file found inside the archive.');
      }
      workbookText = await workbookEntry.async('text');
    } else if (ext === 'twb') {
      workbookText = await file.text();
    } else {
      throw new Error('Unsupported file type. Please provide a .twb or .twbx file.');
    }

    const meta = parseWorkbookXML(workbookText);
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
    setStatus(`Loaded ${file.name}`);
  } catch (error) {
    console.error(error);
    setStatus(`Error: ${error.message}`);
  }
  updateFooter();
}

function parseWorkbookXML(xmlText) {
  const parser = new DOMParser();
  const xml = parser.parseFromString(xmlText, 'text/xml');
  const errorNode = xml.querySelector('parsererror');
  if (errorNode) {
    throw new Error('Unable to parse workbook XML.');
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

  function addEdge(from, to, type) {
    if (!from || !to) return;
    const edgeKey = `${from}->${to}:${type}`;
    if (edgeKeys.has(edgeKey)) return;
    edgeKeys.add(edgeKey);
    edges.push({
      id: edgeKey,
      from,
      to,
      type,
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
  state.cy.batch(() => {
    state.cy.elements().remove();
    const elements = [];
    graph.nodes.forEach((node) => {
      elements.push({ data: { ...node } });
    });
    graph.edges.forEach((edge) => {
      elements.push({ data: { id: edge.id, source: edge.from, target: edge.to, type: edge.type } });
    });
    state.cy.add(elements);
  });
  applyFilters();
  state.cy.elements().removeClass('cy-dim');
  state.cy.$('node').unselect();
  renderDetails(null);
  syncListSelection(null);
  fitGraph();
}

function applyFilters() {
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
}

function expandNeighbors(depth) {
  if (!state.cy) return;
  const selected = state.cy.$('node:selected');
  if (!selected.length) {
    setStatus('Select a node to expand.');
    return;
  }
  const node = selected[0];
  const scope = highlightNeighborhood(node, depth);
  fitToElements(scope);
}

function highlightNeighborhood(node, depth = 1) {
  let scope = node.closedNeighborhood();
  for (let i = 1; i < depth; i += 1) {
    scope = scope.union(scope.closedNeighborhood());
  }
  state.cy.elements().addClass('cy-dim');
  scope.removeClass('cy-dim');
  return scope;
}

function hideIsolated() {
  if (!state.cy) return;
  state.cy.batch(() => {
    state.cy.nodes().forEach((node) => {
      if (node.style('display') === 'none') return;
      const visibleEdges = node
        .connectedEdges()
        .filter((edge) => edge.style('display') !== 'none');
      if (!visibleEdges.length) {
        node.style('display', 'none');
      }
    });
    state.cy.edges().forEach((edge) => {
      if (edge.source().style('display') === 'none' || edge.target().style('display') === 'none') {
        edge.style('display', 'none');
      }
    });
  });
}

function fitGraph() {
  if (!state.cy) return;
  const elements = state.cy.elements().filter((ele) => ele.style('display') !== 'none');
  if (elements.length) {
    state.cy.fit(elements, 100);
  }
}

function fitToElements(elements) {
  if (!state.cy) return;
  const visible = elements.filter((ele) => ele.style('display') !== 'none');
  if (visible.length) {
    state.cy.fit(visible, 80);
  } else {
    fitGraph();
  }
}

function focusOnNode(id, options = {}) {
  if (!state.cy) return;
  const node = state.cy.getElementById(id);
  if (!node || !node.length) return;
  state.cy.$('node').unselect();
  node.select();
  state.selectedNodeId = id;
  const depth = options.depth || 1;
  const scope = highlightNeighborhood(node, depth);
  if (options.center !== false) {
    fitToElements(scope);
  }
  renderDetails(node.data());
  syncListSelection(id);
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


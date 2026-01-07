/**
 * @fileoverview Details panel and sidebar rendering
 * @module rendering
 *
 * Handles rendering of:
 * - Node details panel (formulas, metadata, relationships)
 * - Sidebar lists (nodes, sheets, calculations, parameters)
 * - Virtual scrolling for large lists
 * - Syntax highlighted formulas
 */

import { NAME_NORMALIZER, VIRTUAL_SCROLL_THRESHOLD } from './constants.js';
import { state } from './state.js';
import { logger } from './logger.js';
import { escapeHtml, displayName, normalizeName } from './utils.js';
import { highlightFormula } from './syntax-highlighter.js';
import { createVirtualList } from './virtual-list.js';

/**
 * Cleans up datasource names to be more human-readable
 * Converts hyper file paths and federated IDs to friendly names
 * @param {string} datasourceName - Raw datasource name
 * @returns {string} Cleaned datasource name
 * @private
 */
function cleanDatasourceName(datasourceName) {
  if (!datasourceName) return 'Unknown';

  // Handle hyper extract file paths
  if (datasourceName.includes('.hyper')) {
    // Extract from paths like "Data/Extracts/federated_XXX.hyper"
    const fileName = datasourceName.split('/').pop();
    if (fileName.startsWith('federated_')) {
      return 'Local Extract (Hyper)';
    }
    // Remove .hyper extension and path
    return fileName.replace('.hyper', '') + ' (Hyper)';
  }

  // Handle federated datasources
  if (datasourceName.startsWith('federated_')) {
    return 'Federated Data';
  }

  // Handle textscan (CSV/Excel)
  if (datasourceName === 'textscan') {
    return 'Text/Excel File';
  }

  // Return as-is if already readable
  return datasourceName;
}

/**
 * Resolves an entity (field, parameter, etc.) from a raw ID or name
 * Looks up friendly names, types, and datasources from lookup maps
 *
 * @param {string} rawValue - Raw ID or name to resolve
 * @returns {Object} Entity object with name, type, datasource, original, canonical
 * @private
 */
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
 * Renders a titled unordered list for detail panel sections
 *
 * @param {string} title - Section title
 * @param {string[]} items - Array of item strings
 * @returns {string} HTML string
 */
export function renderList(title, items) {
  if (!items || !items.length) return '';
  const li = items.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
  return `<h3>${escapeHtml(title)}</h3><ul>${li}</ul>`;
}

/**
 * Renders a list of entities with type chips (for referenced fields, parameters, etc.)
 *
 * @param {string} title - Section title
 * @param {string[]} rawIds - Array of raw IDs to resolve
 * @returns {string} HTML string
 */
export function renderEntityChipList(title, rawIds) {
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

/**
 * Updates the right-hand details pane with metadata for the selected node
 *
 * @param {Object|null} nodeData - Node data object or null to clear
 */
export function renderDetails(nodeData) {
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
    const cleanedDs = cleanDatasourceName(nodeData.datasource);
    const rawDs = nodeData.datasource !== cleanedDs ? nodeData.datasource : nodeData.datasourceId;
    const dsTitle = rawDs ? ` title="${escapeHtml(rawDs)}"` : '';
    infoBits.push(`Datasource: <span${dsTitle}>${escapeHtml(cleanedDs)}</span>`);
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

    // Build formula section with syntax highlighting directly
    lines.push('<h3 class="formula-heading">Formula');
    if (formulaInfo.hasLODBadge) {
      lines.push(' <span class="chip chip-lod">LOD</span>');
    }
    if (formulaInfo.hasTableCalcBadge) {
      lines.push(' <span class="chip chip-table">Table Calc</span>');
    }
    lines.push('</h3>');
    lines.push('<pre class="formula">');
    lines.push(highlightFormula(formulaInfo.text));
    lines.push('</pre>');

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
}

/**
 * Builds a sidebar list item button that focuses the associated node on click
 *
 * @param {string} label - Display label
 * @param {string|null} nodeId - Node ID (null if disabled)
 * @param {Object} dependencies - External function dependencies
 * @param {Function} dependencies.focusOnNode - Function to focus on node
 * @returns {HTMLLIElement} List item element
 */
export function createListItem(label, nodeId, dependencies = {}) {
  const li = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  if (nodeId) {
    button.dataset.nodeId = nodeId;
    if (dependencies.focusOnNode) {
      button.addEventListener('click', () => dependencies.focusOnNode(nodeId, { depth: 1, center: true }));
    }
  } else {
    button.disabled = true;
  }
  li.appendChild(button);
  return li;
}

/**
 * Highlights the sidebar entry for the currently selected node
 *
 * @param {string|null} nodeId - Node ID to highlight or null to clear
 */
export function syncListSelection(nodeId) {
  document.querySelectorAll('.tab-panel button[data-node-id]').forEach((button) => {
    button.classList.toggle('active', button.dataset.nodeId === nodeId);
  });
}

/**
 * Populates sidebar lists for nodes, sheets, calculations, and parameters
 * Also refreshes the datalist used by the search box
 * Uses virtual scrolling for large lists to improve performance
 *
 * @param {Object} meta - Parsed metadata object
 * @param {Object} dependencies - External function dependencies
 * @param {Function} dependencies.focusOnNode - Function to focus on node
 */
export function populateLists(meta, dependencies = {}) {
  const nodesList = document.getElementById('list-nodes');
  const sheetsList = document.getElementById('list-sheets');
  const calcsList = document.getElementById('list-calcs');
  const paramsList = document.getElementById('list-params');
  const datalist = document.getElementById('node-names');

  // Validate all required elements exist
  if (!nodesList || !sheetsList || !calcsList || !paramsList || !datalist) {
    logger.warn('[populateLists]', 'Missing required DOM elements:', {
      nodesList: !!nodesList,
      sheetsList: !!sheetsList,
      calcsList: !!calcsList,
      paramsList: !!paramsList,
      datalist: !!datalist,
    });
    return;
  }

  // Validate meta and graph exist
  if (!meta || !state.graph) {
    logger.warn('[populateLists]', 'Invalid metadata or graph');
    return;
  }

  // Clean up existing virtual list scroll handlers
  state.virtualLists.forEach((cleanup) => cleanup());
  state.virtualLists.clear();

  nodesList.innerHTML = '';
  sheetsList.innerHTML = '';
  calcsList.innerHTML = '';
  paramsList.innerHTML = '';
  datalist.innerHTML = '';

  // Prepare node data
  const sortedNodes = [...(state.graph?.nodes || [])]
    .filter((node) => node && node.name && node.id && node.type)
    .sort((a, b) => {
      if (a.type === b.type) {
        return a.name.localeCompare(b.name);
      }
      return a.type.localeCompare(b.type);
    });

  const worksheetData = (meta.worksheets || [])
    .filter((worksheet) => worksheet && worksheet.name)
    .map((worksheet) => {
      const worksheetIds = state.graph?.nodes.filter(
        (node) => node && node.type === 'Worksheet' && node.rawName === worksheet.name
      ) || [];
      const nodeId = worksheetIds.length ? worksheetIds[0].id : null;
      return { name: worksheet.name, nodeId };
    });

  const calcData = (state.graph?.nodes || [])
    .filter((node) => node && node.type === 'CalculatedField' && node.name && node.id)
    .sort((a, b) => a.name.localeCompare(b.name));

  const paramData = (state.graph?.nodes || [])
    .filter((node) => node && node.type === 'Parameter' && node.name && node.id)
    .sort((a, b) => a.name.localeCompare(b.name));

  // Performance: Use virtual scrolling for large lists (>100 items)
  const nodesCleanup = createVirtualList(nodesList, sortedNodes, (node) =>
    createListItem(`${node.name} · ${node.type}`, node.id, dependencies)
  );
  state.virtualLists.set('nodes', nodesCleanup);

  const sheetsCleanup = createVirtualList(sheetsList, worksheetData, (item) =>
    createListItem(item.name, item.nodeId, dependencies)
  );
  state.virtualLists.set('sheets', sheetsCleanup);

  const calcsCleanup = createVirtualList(calcsList, calcData, (node) =>
    createListItem(node.name, node.id, dependencies)
  );
  state.virtualLists.set('calcs', calcsCleanup);

  const paramsCleanup = createVirtualList(paramsList, paramData, (node) =>
    createListItem(node.name, node.id, dependencies)
  );
  state.virtualLists.set('params', paramsCleanup);

  // Populate search datalist (not virtualized - browser handles this)
  const seenValues = new Set();
  (state.graph?.nodes || []).forEach((node) => {
    if (node && node.name && !seenValues.has(node.name)) {
      seenValues.add(node.name);
      const option = document.createElement('option');
      option.value = node.name;
      datalist.appendChild(option);
    }
  });

  // Performance: Log if virtual scrolling was used
  const totalNodes = sortedNodes.length;
  if (totalNodes > VIRTUAL_SCROLL_THRESHOLD) {
    logger.info('[populateLists]', `Virtual scrolling enabled for ${totalNodes} nodes`);
  }
}

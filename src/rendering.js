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

import { NAME_NORMALIZER } from './constants.js';
import { state } from './state.js';
import { logger } from './logger.js';
import { escapeHtml, displayName, normalizeName } from './utils.js';
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

  // Fill formula area with plain text (textContent avoids HTML-rendering issues)
  if (formulaInfo) {
    const formulaEl = panel.querySelector('.formula');
    if (formulaEl) {
      formulaEl.textContent = resolveFormulaText(formulaInfo.text);
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
 * Resolves internal field IDs in a formula to human-readable names.
 * Outputs plain text suitable for textContent assignment (no HTML).
 *
 * @param {string} formula - Raw formula text
 * @returns {string} Formula with internal IDs replaced by display names
 * @private
 */
function resolveFormulaText(formula) {
  if (!formula) return '';
  return formula.replace(/\[([^\[\]]+)\]/g, (match, inner) => {
    const fromMap =
      state.idToName?.get(inner) ||
      state.idToName?.get(`[${inner}]`);
    if (fromMap) {
      return `[${fromMap.replace(/^\[|\]$/g, '')}]`;
    }
    if (inner.startsWith('Calculation_') || inner.startsWith('Parameter_')) {
      if (state.nodeIndex) {
        for (const node of state.nodeIndex.values()) {
          if (node.rawId === inner || node.originalId === inner) {
            return `[${node.name}]`;
          }
        }
      }
    }
    return match;
  });
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
  document.querySelectorAll('.sidebar-section button[data-node-id]').forEach((button) => {
    button.classList.toggle('active', button.dataset.nodeId === nodeId);
  });
}

/**
 * Populates sidebar lists for dashboards and sheets
 * Also refreshes the datalist used by the search box
 *
 * @param {Object} meta - Parsed metadata object
 * @param {Object} dependencies - External function dependencies
 * @param {Function} dependencies.focusOnNode - Function to focus on node
 */
export function populateLists(meta, dependencies = {}) {
  const dashboardsList = document.getElementById('list-dashboards');
  const sheetsList = document.getElementById('list-sheets');
  const clearBtn = document.getElementById('clearDashboardFilter');
  const datalist = document.getElementById('node-names');

  if (!dashboardsList || !sheetsList || !datalist) {
    logger.warn('[populateLists]', 'Missing required DOM elements');
    return;
  }

  if (!meta || !state.graph) {
    logger.warn('[populateLists]', 'Invalid metadata or graph');
    return;
  }

  // Clean up existing virtual list scroll handlers
  state.virtualLists.forEach((cleanup) => cleanup());
  state.virtualLists.clear();

  dashboardsList.innerHTML = '';
  sheetsList.innerHTML = '';
  datalist.innerHTML = '';

  // Build dashboard list - clicking filters graph to that dashboard
  const dashboardData = (meta.dashboards || [])
    .filter((db) => db && db.name)
    .map((db) => {
      const nodes = (state.graph?.nodes || []).filter(
        (n) => n && n.type === 'Dashboard' && n.name === db.name
      );
      return { name: db.name, nodeId: nodes.length ? nodes[0].id : null };
    });

  dashboardData.forEach((db) => {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = db.name;
    button.className = 'dashboard-filter-btn';
    if (db.nodeId) {
      button.dataset.nodeId = db.nodeId;
      button.dataset.dashboardName = db.name;
      button.addEventListener('click', () => {
        // Toggle selection
        const isActive = button.classList.contains('active');
        dashboardsList.querySelectorAll('.dashboard-filter-btn').forEach((b) =>
          b.classList.remove('active')
        );
        if (isActive) {
          // Deselect - clear filter
          state.selectedDashboard = null;
          if (clearBtn) clearBtn.style.display = 'none';
          if (dependencies.clearDashboardFilter) dependencies.clearDashboardFilter();
        } else {
          button.classList.add('active');
          state.selectedDashboard = db.name;
          if (clearBtn) clearBtn.style.display = '';
          if (dependencies.filterByDashboard) dependencies.filterByDashboard(db.nodeId);
        }
      });
    } else {
      button.disabled = true;
    }
    li.appendChild(button);
    dashboardsList.appendChild(li);
  });

  // Wire up "Show all" button
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      state.selectedDashboard = null;
      dashboardsList.querySelectorAll('.dashboard-filter-btn').forEach((b) =>
        b.classList.remove('active')
      );
      clearBtn.style.display = 'none';
      if (dependencies.clearDashboardFilter) dependencies.clearDashboardFilter();
    });
  }

  // Build sheets list
  const worksheetData = (meta.worksheets || [])
    .filter((ws) => ws && ws.name)
    .map((ws) => {
      const nodes = (state.graph?.nodes || []).filter(
        (n) => n && n.type === 'Worksheet' && n.rawName === ws.name
      );
      return { name: ws.name, nodeId: nodes.length ? nodes[0].id : null };
    });

  const sheetsCleanup = createVirtualList(sheetsList, worksheetData, (item) =>
    createListItem(item.name, item.nodeId, dependencies)
  );
  state.virtualLists.set('sheets', sheetsCleanup);

  // Populate search datalist
  const seenValues = new Set();
  (state.graph?.nodes || []).forEach((node) => {
    if (node && node.name && !seenValues.has(node.name)) {
      seenValues.add(node.name);
      const option = document.createElement('option');
      option.value = node.name;
      datalist.appendChild(option);
    }
  });

  logger.info('[populateLists]', `Listed ${dashboardData.length} dashboards, ${worksheetData.length} sheets`);
}

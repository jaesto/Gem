/**
 * @fileoverview Export functionality for workbook documentation
 * @module exports
 *
 * Handles export of workbook metadata to various formats:
 * - JSON (workbook metadata and graph)
 * - Markdown documentation
 * - Graphviz DOT format
 */

import { state } from './state.js';
import { logger } from './logger.js';
import { showError, setStatus } from './ui-handlers.js';
import { displayName } from './utils.js';

/**
 * Formats bytes to human-readable string
 * @param {number} bytes - Number of bytes
 * @returns {string} Formatted string
 * @private
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Builds Markdown documentation from workbook metadata.
 * Format: Dashboard → Sheet → Calculations table.
 * If state.selectedDashboard is set, only that dashboard is exported.
 *
 * @param {Object} meta - Workbook metadata
 * @returns {string} Markdown text
 */
export function buildMarkdown(meta) {
  const lines = [];
  const selectedDashboard = state.selectedDashboard || null;

  // Build a field-name lookup from datasources for resolving formulas
  const fieldByName = buildFieldLookup(meta);

  // Determine which dashboards to export
  const dashboardsToExport = selectedDashboard
    ? (meta.dashboards || []).filter((db) => db.name === selectedDashboard)
    : (meta.dashboards || []);

  // Build a worksheet lookup by name
  const worksheetByName = {};
  (meta.worksheets || []).forEach((ws) => {
    worksheetByName[ws.name] = ws;
  });

  // ===== HEADER =====
  const workbookName = (meta.workbook_path || 'Workbook').split('/').pop().split('\\').pop();
  lines.push(`# ${workbookName}`);
  lines.push('');
  if (selectedDashboard) {
    lines.push(`> Scoped to dashboard: **${selectedDashboard}**`);
    lines.push('');
  }
  if (state.fileInfo) {
    lines.push(`**File:** ${meta.workbook_path}  `);
    lines.push(`**Size:** ${formatBytes(state.fileInfo.size)}  `);
  }
  lines.push(`**Generated:** ${new Date().toLocaleString()}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // ===== DASHBOARDS =====
  if (dashboardsToExport.length === 0) {
    lines.push('*No dashboards found in this workbook.*');
    lines.push('');
  }

  dashboardsToExport.forEach((dashboard) => {
    const dbName = dashboard.name || 'Unnamed Dashboard';
    lines.push(`# Dashboard: ${dbName}`);
    lines.push('');

    const dbWorksheets = (dashboard.worksheets || []);
    if (dbWorksheets.length === 0) {
      lines.push('*No sheets in this dashboard.*');
      lines.push('');
    }

    dbWorksheets.forEach((wsName) => {
      const ws = worksheetByName[wsName];
      lines.push(`## Sheet: ${wsName}`);
      lines.push('');

      if (!ws || !ws.fields_used || ws.fields_used.length === 0) {
        lines.push('*No fields recorded for this sheet.*');
        lines.push('');
        return;
      }

      // Build rows for each field used in this sheet
      const rows = ws.fields_used.map((rawFieldName) => {
        const cleanName = rawFieldName.replace(/^\[|\]$/g, '');
        const resolvedName = resolveFieldName(cleanName) || cleanName;
        const field = fieldByName[resolvedName] || fieldByName[cleanName];

        if (field && field.is_calculated) {
          const formula = (field.calculation?.formula || '').trim();
          const resolvedFormula = resolveFormulaNamesInText(formula);
          const flags = calcFlags(formula);
          return {
            name: resolvedName,
            type: 'Calculated Field',
            flags,
            formula: resolvedFormula,
          };
        }

        return {
          name: resolvedName,
          type: 'Field',
          flags: '',
          formula: '',
        };
      });

      // Table: Field | Type | Flags | Formula
      lines.push('| Field | Type | Notes | Formula |');
      lines.push('|-------|------|-------|---------|');
      rows.forEach(({ name, type, flags, formula }) => {
        const escapedName = name.replace(/\|/g, '\\|');
        const escapedFormula = formula ? formula.replace(/\n/g, ' ').replace(/\|/g, '\\|') : '';
        lines.push(`| ${escapedName} | ${type} | ${flags} | ${escapedFormula} |`);
      });
      lines.push('');
    });

    lines.push('---');
    lines.push('');
  });

  // ===== SHEETS NOT IN ANY DASHBOARD (when exporting all) =====
  if (!selectedDashboard) {
    const sheetsInDashboards = new Set(
      (meta.dashboards || []).flatMap((db) => db.worksheets || [])
    );
    const orphanSheets = (meta.worksheets || []).filter(
      (ws) => ws && ws.name && !sheetsInDashboards.has(ws.name)
    );

    if (orphanSheets.length > 0) {
      lines.push('# Sheets (not in any dashboard)');
      lines.push('');

      orphanSheets.forEach((ws) => {
        lines.push(`## Sheet: ${ws.name}`);
        lines.push('');

        if (!ws.fields_used || ws.fields_used.length === 0) {
          lines.push('*No fields recorded for this sheet.*');
          lines.push('');
          return;
        }

        lines.push('| Field | Type | Notes | Formula |');
        lines.push('|-------|------|-------|---------|');
        ws.fields_used.forEach((rawFieldName) => {
          const cleanName = rawFieldName.replace(/^\[|\]$/g, '');
          const resolvedName = resolveFieldName(cleanName) || cleanName;
          const field = fieldByName[resolvedName] || fieldByName[cleanName];

          if (field && field.is_calculated) {
            const formula = (field.calculation?.formula || '').trim();
            const resolvedFormula = resolveFormulaNamesInText(formula);
            const flags = calcFlags(formula);
            const escapedName = resolvedName.replace(/\|/g, '\\|');
            const escapedFormula = resolvedFormula.replace(/\n/g, ' ').replace(/\|/g, '\\|');
            lines.push(`| ${escapedName} | Calculated Field | ${flags} | ${escapedFormula} |`);
          } else {
            const escapedName = resolvedName.replace(/\|/g, '\\|');
            lines.push(`| ${escapedName} | Field | | |`);
          }
        });
        lines.push('');
      });

      lines.push('---');
      lines.push('');
    }
  }

  // Footer
  lines.push('*Documentation generated by [Gem](https://github.com/jaesto/Gem) - Tableau Workbook Analyzer*');
  lines.push('');

  return lines.join('\n');
}

/**
 * Builds a flat name→field lookup from all datasources
 * @param {Object} meta - Workbook metadata
 * @returns {Object} Map of field name → field object
 * @private
 */
function buildFieldLookup(meta) {
  const lookup = {};
  (meta.datasources || []).forEach((ds) => {
    (ds.fields || []).forEach((field) => {
      if (field.name) {
        const clean = field.name.replace(/^\[|\]$/g, '');
        lookup[clean] = field;
        lookup[field.name] = field;
      }
    });
  });
  return lookup;
}

/**
 * Resolves internal field IDs inside a formula string to human-readable names
 * @param {string} formula - Raw formula text
 * @returns {string} Formula with IDs replaced by display names
 * @private
 */
function resolveFormulaNamesInText(formula) {
  if (!formula) return '';
  return formula.replace(/\[([^\[\]]+)\]/g, (match, inner) => {
    const resolved = resolveFieldName(inner);
    return resolved !== inner ? `[${resolved}]` : match;
  });
}

/**
 * Returns a short flag string for a formula (LOD, Table Calc)
 * @param {string} formula - Formula text
 * @returns {string} Flag string
 * @private
 */
function calcFlags(formula) {
  const upper = (formula || '').toUpperCase();
  const flags = [];
  if (upper.match(/\{\s*(FIXED|INCLUDE|EXCLUDE)/)) flags.push('LOD');
  if (upper.match(/\b(WINDOW_|RUNNING_|LOOKUP|INDEX|RANK)\b/)) flags.push('Table Calc');
  return flags.join(', ');
}

/**
 * Resolves internal field ID to human-readable name
 * Uses state.idToName map to translate Tableau internal IDs
 * @param {string} rawId - Internal field ID (e.g., "Calculation_0906289039171594")
 * @returns {string} Human-readable field name
 * @private
 */
function resolveFieldName(rawId) {
  if (!rawId) return 'Unknown';

  // Remove brackets if present
  const cleanId = rawId.replace(/^\[|\]$/g, '');

  // Try to resolve using idToName map
  if (state.idToName && state.idToName.has(cleanId)) {
    return state.idToName.get(cleanId);
  }

  // Try with brackets
  const bracketedId = `[${cleanId}]`;
  if (state.idToName && state.idToName.has(bracketedId)) {
    return state.idToName.get(bracketedId);
  }

  // If it's a Calculation_#### ID, try to find the actual field
  if (cleanId.startsWith('Calculation_')) {
    // Search through all nodes to find a match
    if (state.nodeIndex) {
      for (const [id, node] of state.nodeIndex) {
        if (node.originalId === cleanId || node.rawId === cleanId || node.id === cleanId) {
          return node.name || cleanId;
        }
      }
    }
  }

  // Return the original if we can't resolve it
  return cleanId;
}

/**
 * Gets a meaningful datasource display name
 * Extracts useful information from datasource and connections
 * @param {Object} datasource - Datasource object
 * @returns {string} Meaningful datasource description
 * @private
 */
function getDatasourceDisplayInfo(datasource) {
  const parts = [];

  // Use caption if available
  if (datasource.caption && datasource.caption !== datasource.rawId) {
    return datasource.caption;
  }

  // Try to extract meaningful info from connections
  if (datasource.connections && datasource.connections.length > 0) {
    const conn = datasource.connections[0];

    // For database connections, show database name
    if (conn.dbname) {
      parts.push(conn.dbname);
    }

    // For server connections, show server
    if (conn.server && conn.server !== 'localhost' && conn.server !== '127.0.0.1') {
      parts.push(conn.server);
    }

    // Add connection type if meaningful
    if (conn.class && conn.class !== 'federated' && conn.class !== 'hyper') {
      parts.push(`(${conn.class})`);
    }
  }

  // If we found meaningful parts, return them
  if (parts.length > 0) {
    return parts.join(' - ');
  }

  // Fall back to the name
  return datasource.name || datasource.rawId || 'Unknown Datasource';
}

/**
 * Builds a Graphviz DOT file representing field and sheet lineage edges
 * @param {Object} meta - Workbook metadata
 * @returns {string} DOT format text
 */
export function buildDot(meta) {
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
 * Triggers a browser download for generated text/blob content
 * @param {string} filename - Download filename
 * @param {string|BlobPart} content - File content
 * @param {string} [mime='text/plain'] - MIME type
 */
export function downloadBlob(filename, content, mime = 'text/plain') {
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
    logger.info('[exports]', `Downloaded: ${filename}`);
  } catch (error) {
    logger.error('[exports]', 'Download failed:', error);
    showError('Failed to download file', error);
  } finally {
    if (url) {
      // Clean up the object URL after a short delay
      setTimeout(() => URL.revokeObjectURL(url), 100);
    }
  }
}

/**
 * Binds export dropdown event handlers
 * Call this from bindUI() after DOM is ready
 */
export function bindExportHandlers() {
  const exportDropdown = document.getElementById('export-dropdown');
  if (!exportDropdown) {
    logger.warn('[exports]', 'Export dropdown not found');
    return;
  }

  exportDropdown.querySelectorAll('[data-export]').forEach((button) => {
    button.addEventListener('click', () => {
      if (!state.meta || !state.graph) {
        setStatus('Load a workbook before exporting.');
        return;
      }
      const mode = button.dataset.export;
      // Export router: delegate to JSON, Markdown, or DOT serializers
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
          logger.warn('[exports]', 'Unknown export mode:', mode);
          break;
      }
      exportDropdown.removeAttribute('open');
    });
  });

  logger.info('[exports]', 'Export handlers bound');
}

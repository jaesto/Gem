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
 * Builds Markdown documentation from workbook metadata
 * @param {Object} meta - Workbook metadata
 * @returns {string} Markdown text
 */
export function buildMarkdown(meta) {
  const lines = [];

  // Calculate summary statistics
  const stats = calculateStats(meta);

  // ===== HEADER =====
  lines.push('# Tableau Workbook Documentation');
  lines.push('');
  lines.push(`**Source:** ${meta.workbook_path}`);
  if (state.fileInfo) {
    lines.push(`**File size:** ${formatBytes(state.fileInfo.size)}`);
  }
  if (state.buildTimestamp) {
    lines.push(`**Generated:** ${state.buildTimestamp}`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // ===== TABLE OF CONTENTS =====
  lines.push('## 📑 Table of Contents');
  lines.push('');
  lines.push('- [Summary](#summary)');
  if (meta.datasources.length) {
    lines.push('- [Datasources](#datasources)');
    meta.datasources.forEach((ds, idx) => {
      const anchor = slugify(ds.name);
      lines.push(`  - [${ds.name}](#datasource-${idx + 1}-${anchor})`);
    });
  }
  if (meta.parameters.length) {
    lines.push('- [Parameters](#parameters)');
  }
  if (meta.worksheets.length) {
    lines.push('- [Worksheets](#worksheets)');
  }
  if (meta.dashboards.length) {
    lines.push('- [Dashboards](#dashboards)');
  }
  if (meta.lineage.field_to_field.length || meta.lineage.field_to_sheet.length) {
    lines.push('- [Lineage & Dependencies](#lineage--dependencies)');
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // ===== SUMMARY SECTION =====
  lines.push('## Summary');
  lines.push('');
  lines.push('| Category | Count |');
  lines.push('|----------|-------|');
  lines.push(`| **Datasources** | ${stats.datasources} |`);
  lines.push(`| **Total Fields** | ${stats.totalFields} |`);
  lines.push(`| ↳ Regular Fields | ${stats.regularFields} |`);
  lines.push(`| ↳ Calculated Fields | ${stats.calculatedFields} |`);
  lines.push(`| ↳ LOD Calculations | ${stats.lodCalcs} |`);
  lines.push(`| ↳ Table Calculations | ${stats.tableCalcs} |`);
  lines.push(`| **Parameters** | ${stats.parameters} |`);
  lines.push(`| **Worksheets** | ${stats.worksheets} |`);
  lines.push(`| **Dashboards** | ${stats.dashboards} |`);
  lines.push(`| **Dependencies** | ${stats.dependencies} |`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // ===== DATASOURCES =====
  if (meta.datasources.length) {
    lines.push('## Datasources');
    lines.push('');

    meta.datasources.forEach((datasource, dsIndex) => {
      const anchor = slugify(datasource.name);
      lines.push(`### Datasource ${dsIndex + 1}: ${datasource.name}`);
      lines.push('');

      // Connection details
      if (datasource.connections && datasource.connections.length > 0) {
        lines.push('#### 🔌 Connection Details');
        lines.push('');
        datasource.connections.forEach((conn, connIdx) => {
          if (connIdx > 0) lines.push('');
          if (conn.class) lines.push(`**Type:** ${conn.class}`);
          if (conn.server) lines.push(`**Server:** ${conn.server}`);
          if (conn.dbname) lines.push(`**Database:** ${conn.dbname}`);
          if (conn.warehouse) lines.push(`**Warehouse:** ${conn.warehouse}`);
        });
        lines.push('');
      }

      // Separate regular fields and calculated fields
      const regularFields = datasource.fields.filter(f => !f.is_calculated);
      const calculatedFields = datasource.fields.filter(f => f.is_calculated);

      // Regular Fields
      if (regularFields.length > 0) {
        lines.push(`#### 📊 Fields (${regularFields.length})`);
        lines.push('');
        lines.push('| Field Name | Datatype | Role | Aggregation |');
        lines.push('|------------|----------|------|-------------|');

        regularFields.forEach((field) => {
          const name = field.name || 'Unnamed';
          const datatype = field.datatype || 'n/a';
          const role = field.role || 'n/a';
          const agg = field.default_aggregation || 'n/a';
          lines.push(`| ${name} | ${datatype} | ${role} | ${agg} |`);
        });
        lines.push('');
      }

      // Calculated Fields
      if (calculatedFields.length > 0) {
        lines.push(`#### 🧮 Calculated Fields (${calculatedFields.length})`);
        lines.push('');

        calculatedFields.forEach((field) => {
          const name = field.name || 'Unnamed';
          const datatype = field.datatype || 'n/a';
          const formula = field.calculation?.formula || '';
          const calcClass = field.calculation?.class || '';

          // Detect badges
          const badges = [];
          const normalizedFormula = formula.toUpperCase();
          if (normalizedFormula.match(/\{\s*(FIXED|INCLUDE|EXCLUDE)/)) {
            badges.push('`LOD`');
          }
          if (normalizedFormula.match(/\b(WINDOW_|RUNNING_|LOOKUP|INDEX|RANK)\b/)) {
            badges.push('`TABLE CALC`');
          }
          if (calcClass) {
            badges.push(`\`${calcClass}\``);
          }

          const badgeStr = badges.length > 0 ? ' ' + badges.join(' ') : '';

          lines.push(`##### ${name}${badgeStr}`);
          lines.push('');
          lines.push(`**Datatype:** ${datatype} | **Role:** ${field.role || 'n/a'}`);
          lines.push('');

          // Show dependencies
          if (field.references) {
            if (field.references.fields && field.references.fields.length > 0) {
              lines.push(`**Referenced Fields:** ${field.references.fields.join(', ')}`);
              lines.push('');
            }
            if (field.references.parameters && field.references.parameters.length > 0) {
              lines.push(`**Referenced Parameters:** ${field.references.parameters.join(', ')}`);
              lines.push('');
            }
          }

          if (formula) {
            lines.push('**Formula:**');
            lines.push('```tableau');
            lines.push(formula);
            lines.push('```');
            lines.push('');
          }
        });
      }

      lines.push('---');
      lines.push('');
    });
  }

  // ===== PARAMETERS =====
  if (meta.parameters.length) {
    lines.push('## Parameters');
    lines.push('');
    lines.push('| Parameter Name | Datatype | Current Value |');
    lines.push('|----------------|----------|---------------|');

    meta.parameters.forEach((param) => {
      const name = param.name || 'Unnamed';
      const datatype = param.datatype || 'n/a';
      const value = param.current_value || '—';
      lines.push(`| ${name} | ${datatype} | ${value} |`);
    });
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  // ===== WORKSHEETS =====
  if (meta.worksheets.length) {
    lines.push('## Worksheets');
    lines.push('');

    meta.worksheets.forEach((worksheet) => {
      const name = worksheet.name || 'Unnamed';
      const fieldCount = (worksheet.fields_used || []).length;

      lines.push(`### 📈 ${name}`);
      lines.push('');
      lines.push(`**Fields Used:** ${fieldCount}`);
      lines.push('');

      if (fieldCount > 0) {
        lines.push('<details>');
        lines.push('<summary>Show fields</summary>');
        lines.push('');
        (worksheet.fields_used || []).forEach((field) => {
          lines.push(`- ${field}`);
        });
        lines.push('');
        lines.push('</details>');
        lines.push('');
      }
    });

    lines.push('---');
    lines.push('');
  }

  // ===== DASHBOARDS =====
  if (meta.dashboards.length) {
    lines.push('## Dashboards');
    lines.push('');

    meta.dashboards.forEach((dashboard) => {
      const name = dashboard.name || 'Unnamed';
      const worksheetCount = (dashboard.worksheets || []).length;

      lines.push(`### 📊 ${name}`);
      lines.push('');
      lines.push(`**Worksheets:** ${worksheetCount}`);
      lines.push('');

      if (worksheetCount > 0) {
        (dashboard.worksheets || []).forEach((ws) => {
          lines.push(`- ${ws}`);
        });
        lines.push('');
      }
    });

    lines.push('---');
    lines.push('');
  }

  // ===== LINEAGE & DEPENDENCIES =====
  if (meta.lineage.field_to_field.length || meta.lineage.field_to_sheet.length) {
    lines.push('## Lineage & Dependencies');
    lines.push('');

    if (meta.lineage.field_to_field.length) {
      lines.push('### Field → Field Dependencies');
      lines.push('');
      lines.push('```mermaid');
      lines.push('graph LR');
      meta.lineage.field_to_field.forEach(([from, to]) => {
        const fromId = from.replace(/[^a-zA-Z0-9]/g, '_');
        const toId = to.replace(/[^a-zA-Z0-9]/g, '_');
        lines.push(`  ${fromId}["${from}"] --> ${toId}["${to}"]`);
      });
      lines.push('```');
      lines.push('');

      lines.push('<details>');
      lines.push('<summary>Show as list</summary>');
      lines.push('');
      meta.lineage.field_to_field.forEach(([from, to]) => {
        lines.push(`- ${from} → ${to}`);
      });
      lines.push('');
      lines.push('</details>');
      lines.push('');
    }

    if (meta.lineage.field_to_sheet.length) {
      lines.push('### Field → Worksheet Dependencies');
      lines.push('');
      lines.push('<details>');
      lines.push('<summary>Show dependencies</summary>');
      lines.push('');
      meta.lineage.field_to_sheet.forEach(([from, to]) => {
        lines.push(`- ${from} → ${to}`);
      });
      lines.push('');
      lines.push('</details>');
      lines.push('');
    }

    lines.push('---');
    lines.push('');
  }

  // Footer
  lines.push('');
  lines.push('---');
  lines.push(`*Documentation generated by Gem - Tableau Workbook Analyzer*`);
  lines.push('');

  return lines.join('\n');
}

/**
 * Calculates summary statistics from metadata
 * @param {Object} meta - Workbook metadata
 * @returns {Object} Statistics object
 * @private
 */
function calculateStats(meta) {
  let totalFields = 0;
  let regularFields = 0;
  let calculatedFields = 0;
  let lodCalcs = 0;
  let tableCalcs = 0;

  meta.datasources.forEach((ds) => {
    ds.fields.forEach((field) => {
      totalFields++;
      if (field.is_calculated) {
        calculatedFields++;
        const formula = (field.calculation?.formula || '').toUpperCase();
        if (formula.match(/\{\s*(FIXED|INCLUDE|EXCLUDE)/)) {
          lodCalcs++;
        }
        if (formula.match(/\b(WINDOW_|RUNNING_|LOOKUP|INDEX|RANK)\b/)) {
          tableCalcs++;
        }
      } else {
        regularFields++;
      }
    });
  });

  return {
    datasources: meta.datasources.length,
    totalFields,
    regularFields,
    calculatedFields,
    lodCalcs,
    tableCalcs,
    parameters: meta.parameters.length,
    worksheets: meta.worksheets.length,
    dashboards: meta.dashboards.length,
    dependencies: meta.lineage.field_to_field.length + meta.lineage.field_to_sheet.length,
  };
}

/**
 * Converts text to URL-safe slug for anchor links
 * @param {string} text - Text to slugify
 * @returns {string} URL-safe slug
 * @private
 */
function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
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

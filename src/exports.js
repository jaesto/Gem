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
  lines.push('# Tableau Workbook Documentation');
  lines.push('');
  lines.push(`- Source: ${meta.workbook_path}`);
  if (state.fileInfo) {
    lines.push(`- File size: ${formatBytes(state.fileInfo.size)}`);
  }
  if (state.buildTimestamp) {
    lines.push(`- Generated: ${state.buildTimestamp}`);
  }
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

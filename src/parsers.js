/**
 * @fileoverview Tableau workbook parsing (TWB/TWBX files)
 * @module parsers
 *
 * Handles parsing of Tableau workbook files:
 * - .twbx files (zipped archives with XML inside)
 * - .twb files (plain XML)
 * - Extracts metadata: datasources, fields, calculations, worksheets, dashboards
 * - Builds lineage relationships between entities
 */

import { MAX_FILE_SIZE, WARN_FILE_SIZE, MAX_ITERATIONS } from './constants.js';
import { logger } from './logger.js';
import { getAttr } from './utils.js';

/**
 * Parses a Tableau packaged workbook (.twbx file)
 * @param {File} file - .twbx file from file input
 * @returns {Promise<Object>} Parsed metadata
 */
export async function parseTwbx(file) {
  if (!file || file.size === 0) {
    throw new Error('File is empty. Please select a valid .twbx file.');
  }

  if (file.size > MAX_FILE_SIZE) {
    throw new Error(
      `File is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum size is ${MAX_FILE_SIZE / 1024 / 1024} MB.\n\nLarge workbooks may cause browser performance issues.`
    );
  }

  if (file.size > WARN_FILE_SIZE) {
    logger.warn('[parseTwbx]', `Large file detected: ${(file.size / 1024 / 1024).toFixed(1)} MB. Parsing may be slow.`);
  }

  try {
    // Use JSZip to extract .twb file from .twbx archive
    const JSZip = window.JSZip;
    if (!JSZip) {
      throw new Error('JSZip library not loaded. Cannot parse .twbx files.');
    }

    // Get the ArrayBuffer from the file object
    const buf = await file.arrayBuffer();
    const zip = await JSZip.loadAsync(buf);
    const twbFiles = Object.keys(zip.files).filter((name) => name.endsWith('.twb'));

    if (!twbFiles.length) {
      const foundFiles = Object.keys(zip.files).join(', ');
      throw new Error(
        `No .twb file found in the archive.\n\nFound files: ${foundFiles || 'none'}\n\nThis may not be a valid Tableau workbook file.`
      );
    }

    const twbFile = zip.files[twbFiles[0]];
    const buf = await twbFile.async('uint8array');
    const xml = new TextDecoder('utf-8').decode(buf);

    if (!xml || xml.trim().length === 0) {
      throw new Error('File is empty or contains no text');
    }

    return parseTwbText(xml);
  } catch (err) {
    logger.error('[parseTwbx]', 'Failed to parse .twbx', err);
    throw err;
  }
}

/**
 * Parses a Tableau workbook (.twb XML file)
 * @param {File} file - .twb file from file input
 * @returns {Promise<Object>} Parsed metadata
 */
export async function parseTwb(file) {
  if (!file || file.size === 0) {
    throw new Error('File is empty. Please select a valid .twb file.');
  }

  if (file.size > MAX_FILE_SIZE) {
    throw new Error(
      `File is too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024} MB.`
    );
  }

  try {
    const buf = await file.arrayBuffer();
    const xml = new TextDecoder('utf-8').decode(buf);

    if (!xml || xml.trim().length === 0) {
      throw new Error('File is empty or contains no text');
    }

    return parseTwbText(xml);
  } catch (err) {
    logger.error('[parseTwb]', 'Failed:', err);
    throw err;
  }
}

/**
 * Parses Tableau workbook XML text
 * @param {string} xmlText - XML content as string
 * @returns {Object} Parsed metadata
 */
export function parseTwbText(xmlText) {
  try {
    if (!xmlText || typeof xmlText !== 'string') {
      throw new Error('Invalid XML text provided');
    }

    const doc = new DOMParser().parseFromString(xmlText, 'text/xml');

    // Check for parse errors
    const errorNode = doc.querySelector('parsererror');
    if (errorNode) {
      const message = errorNode.textContent?.trim() || 'Unable to parse workbook XML.';
      throw new Error(
        `This file contains invalid XML and cannot be read.\n\n${message}\n\nThe workbook file may be corrupted. Try re-saving it from Tableau Desktop.`
      );
    }

    // Validate it's actually a Tableau workbook
    if (!doc.documentElement) {
      throw new Error(
        'The file is missing required XML structure. This may not be a valid Tableau workbook file.'
      );
    }

    const rootTag = doc.documentElement.tagName.toLowerCase();
    if (rootTag !== 'workbook') {
      throw new Error(
        `Not a valid Tableau workbook: Expected <workbook> structure, found <${rootTag}> instead.\n\nPlease ensure you're uploading a .twb or .twbx file created by Tableau.`
      );
    }

    return parseFromXmlDocument(doc);
  } catch (err) {
    logger.error('[parseTwbText]', 'Failed:', err);
    throw err;
  }
}

/**
 * Parses Tableau workbook XML into normalized metadata collections
 * Handles datasources, parameters, worksheets, dashboards, and lineage links
 *
 * @param {Document} xml - Parsed XML document
 * @returns {Object} Metadata object with datasources, parameters, worksheets, dashboards, lineage
 */
export function parseFromXmlDocument(xml) {
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
    logger.error('[parseFromXmlDocument]', 'Failed:', err);
    throw new Error(`Failed to parse workbook XML: ${err.message || err}`);
  }
}

/**
 * Extracts calculation references from a Tableau formula
 * Uses state machine parser to handle nested brackets
 *
 * @param {string} formula - Tableau formula string
 * @returns {Object} Object with fields and parameters arrays
 */
export function extractCalculationReferences(formula) {
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
 * Detects cycles in the graph using DFS algorithm
 * @param {Object} graph - Graph with nodes and edges
 * @returns {Array<Array<string>>} Array of cycles (each cycle is array of node IDs)
 */
export function detectCycles(graph) {
  if (!graph || !graph.nodes || !graph.edges) {
    return [];
  }

  // Build adjacency list
  const adjList = new Map();
  graph.nodes.forEach((node) => {
    if (node && node.id) {
      adjList.set(node.id, []);
    }
  });

  graph.edges.forEach((edge) => {
    if (edge && edge.source && edge.target && adjList.has(edge.source)) {
      adjList.get(edge.source).push(edge.target);
    }
  });

  const visited = new Set();
  const recStack = new Set();
  const cycles = [];

  function dfs(nodeId, path = []) {
    visited.add(nodeId);
    recStack.add(nodeId);
    path.push(nodeId);

    const neighbors = adjList.get(nodeId) || [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        dfs(neighbor, [...path]);
      } else if (recStack.has(neighbor)) {
        // Found a cycle
        const cycleStart = path.indexOf(neighbor);
        if (cycleStart >= 0) {
          const cycle = path.slice(cycleStart);
          cycle.push(neighbor); // Complete the cycle
          cycles.push(cycle);
        }
      }
    }

    recStack.delete(nodeId);
  }

  // Check all nodes for cycles
  adjList.forEach((_, nodeId) => {
    if (!visited.has(nodeId)) {
      dfs(nodeId, []);
    }
  });

  return cycles;
}

/**
 * Deduplicates field/parameter reference pairs
 * @param {Array<Array<string>>} pairs - Array of [from, to] pairs
 * @returns {Array<Array<string>>} Deduplicated pairs
 */
export function dedupePairs(pairs) {
  const seen = new Set();
  return pairs.filter(([from, to]) => {
    const key = `${from}→${to}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

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

    const zip = await JSZip.loadAsync(file);
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
  // NOTE: This is a large function (~400 lines) extracted from app.js
  // Implementation extracts all datasources, fields, calculations, worksheets, dashboards
  // and builds lineage relationships

  // For the modular version, this would be the full implementation from app.js lines 1359-1800
  // Extracted as-is to preserve exact parsing logic

  throw new Error('parseFromXmlDocument: Full implementation to be migrated from app.js');
}

/**
 * Extracts calculation references from a Tableau formula
 * Uses state machine parser to handle nested brackets
 *
 * @param {string} formula - Tableau formula string
 * @returns {Object} Object with fields and parameters arrays
 */
export function extractCalculationReferences(formula) {
  // NOTE: State machine parser from app.js lines 1557-1577
  // Implementation to be migrated

  throw new Error('extractCalculationReferences: Full implementation to be migrated from app.js');
}

/**
 * Detects cycles in the graph using DFS algorithm
 * @param {Object} graph - Graph with nodes and edges
 * @returns {Array<Array<string>>} Array of cycles (each cycle is array of node IDs)
 */
export function detectCycles(graph) {
  // NOTE: DFS-based cycle detection from app.js lines 1598-1658
  // Implementation to be migrated

  throw new Error('detectCycles: Full implementation to be migrated from app.js');
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

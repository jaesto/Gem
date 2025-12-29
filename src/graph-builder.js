/**
 * @fileoverview Graph building and normalization
 * @module graph-builder
 *
 * Converts parsed Tableau workbook metadata into Cytoscape-compatible graph structure.
 * Handles:
 * - Node creation with canonical IDs
 * - Edge creation for lineage relationships
 * - Lookup map management
 * - Graph validation and normalization
 */

import { NAME_NORMALIZER, MAX_ITERATIONS } from './constants.js';
import { state } from './state.js';
import { logger } from './logger.js';
import { normalizeName, displayName, friendlyDatasourceName, slugify } from './utils.js';
import { detectCycles, dedupePairs } from './parsers.js';

/**
 * Converts parsed workbook metadata into the Cytoscape-friendly graph structure
 * Enforces ID invariants, tracks lookup maps, and creates lineage edges
 *
 * @param {Object} meta - Parsed metadata from parseFromXmlDocument
 * @returns {Object} Graph object with nodes and edges arrays
 */
export function buildGraph(meta) {
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
      logger.warn('[Graph]', 'Duplicate node id detected, generating fallback:', candidate);
    }
    const base = baseName || candidate || `${prefix}-${usedIds.size + 1}`;
    let slug = slugify(base);
    if (!slug) slug = `${prefix}-${usedIds.size + 1}`;
    let fallback = `${prefix}:${slug}`;
    let counter = 2;

    while (usedIds.has(fallback)) {
      if (counter > MAX_ITERATIONS) {
        // Failsafe: use timestamp-based unique ID
        const uniqueId = `${prefix}:${slug}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        logger.error('[Graph]', 'Failed to generate unique ID after', MAX_ITERATIONS, 'attempts. Using fallback:', uniqueId);
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

  logger.debug('[buildGraph]', 'Created', nodes.length, 'nodes and', edges.length, 'edges');

  // Detect cycles in the graph
  const graph = { nodes, edges };
  const cycles = detectCycles(graph);

  if (cycles.length > 0) {
    logger.warn('[buildGraph]', 'Detected', cycles.length, 'cycle(s) in graph:', cycles);
    // Log cycles for debugging but don't fail - some Tableau workbooks may have intentional cycles
    cycles.forEach((cycle, index) => {
      const cycleNames = cycle.map((id) => {
        const node = nodes.find((n) => n.id === id);
        return node ? node.name : id;
      });
      logger.warn(`  Cycle ${index + 1}:`, cycleNames.join(' → '));
    });
  }

  return graph;
  } catch (err) {
    logger.error('[buildGraph]', 'Failed:', err);
    throw new Error(`Failed to build graph: ${err.message || err}`);
  }
}

/**
 * Repairs malformed graph payloads before Cytoscape rendering
 * Ensures nodes/edges have required IDs and that edge endpoints exist
 *
 * @param {Object} graph - Graph object with nodes and edges
 * @returns {Object} Normalized graph with validated nodes and edges
 */
export function normalizeGraph(graph) {
  if (!graph) {
    return { nodes: [], edges: [] };
  }

  const normalizedNodes = [];
  const normalizedEdges = [];
  const nodeIds = new Set();

  const rawNodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  rawNodes.forEach((rawNode) => {
    if (!rawNode || typeof rawNode !== 'object') {
      logger.warn('[normalizeGraph]', 'skipping invalid node', rawNode);
      return;
    }

    const nodeData = (rawNode.data && typeof rawNode.data === 'object') ? { ...rawNode.data } : {};
    let id = typeof rawNode.id === 'string' ? rawNode.id : nodeData.id;
    if (typeof id === 'string') id = id.trim();

    if (!id) {
      logger.warn('[normalizeGraph]', 'skipping node with no id', rawNode);
      return;
    }

    if (nodeIds.has(id)) {
      logger.warn('[normalizeGraph]', 'duplicate node id', id);
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
      logger.warn('[normalizeGraph]', 'skipping invalid edge', rawEdge);
      return;
    }

    const edgeData = (rawEdge.data && typeof rawEdge.data === 'object') ? { ...rawEdge.data } : {};
    let source = rawEdge.source || edgeData.source;
    let target = rawEdge.target || edgeData.target;
    if (typeof source === 'string') source = source.trim();
    if (typeof target === 'string') target = target.trim();

    if (!source || !target) {
      logger.warn('[normalizeGraph]', 'skipping edge missing endpoints', rawEdge);
      return;
    }

    if (!nodeIds.has(source) || !nodeIds.has(target)) {
      logger.warn('[normalizeGraph]', 'skipping edge with unknown endpoint', rawEdge);
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
      logger.warn('[normalizeGraph]', 'duplicate edge id detected, renaming', id, '->', candidate);
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

  logger.debug('[normalizeGraph]', 'final counts:', normalizedNodes.length, 'nodes;', normalizedEdges.length, 'edges');
  return { nodes: normalizedNodes, edges: normalizedEdges };
}

/**
 * Rebuilds lookup maps to reflect the normalized graph payload
 *
 * @param {Object} graph - Normalized graph with nodes and edges
 */
export function syncGraphLookups(graph) {
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

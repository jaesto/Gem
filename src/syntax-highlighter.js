/**
 * @fileoverview Formula syntax highlighting for Tableau calculations
 * @module syntax-highlighter
 *
 * Provides syntax highlighting for Tableau formulas with support for:
 * - Keywords (IF, THEN, ELSE, CASE, etc.)
 * - Functions (SUM, AVG, FIXED, WINDOW_*, etc.)
 * - Operators, strings, numbers
 * - Field and parameter references
 * - Comments
 */

import { escapeHtml } from './utils.js';

/**
 * Applies syntax highlighting to a Tableau formula
 *
 * @param {string} formula - Raw formula text
 * @returns {string} HTML string with syntax highlighting
 *
 * @example
 * const html = highlightFormula('IF [Sales] > 1000 THEN SUM([Profit]) ELSE 0 END');
 * // Returns HTML with colored spans for each token type
 */
export function highlightFormula(formula) {
  if (!formula || typeof formula !== 'string') return '';

  // Tableau keywords (IF, THEN, ELSE, CASE, WHEN, END, etc.)
  const keywords = /\b(IF|THEN|ELSE|ELSEIF|END|CASE|WHEN|AND|OR|NOT|IN|IS|NULL|TRUE|FALSE)\b/gi;

  // Tableau functions (SUM, AVG, COUNT, FIXED, INCLUDE, EXCLUDE, etc.)
  const functions = /\b(SUM|AVG|MIN|MAX|COUNT|COUNTD|MEDIAN|STDEV|VAR|ATTR|FIXED|INCLUDE|EXCLUDE|WINDOW_SUM|WINDOW_AVG|WINDOW_MIN|WINDOW_MAX|WINDOW_COUNT|RUNNING_SUM|RUNNING_AVG|RUNNING_MIN|RUNNING_MAX|RUNNING_COUNT|RANK|RANK_UNIQUE|DENSE_RANK|INDEX|FIRST|LAST|SIZE|TOTAL|LOOKUP|PREVIOUS_VALUE|ZN|ISNULL|IFNULL|IIF|CONTAINS|STARTSWITH|ENDSWITH|FIND|LEFT|RIGHT|MID|REPLACE|SPLIT|TRIM|UPPER|LOWER|LEN|DATE|DATEADD|DATEDIFF|DATEPART|DATETRUNC|NOW|TODAY|YEAR|QUARTER|MONTH|DAY|ABS|CEILING|FLOOR|ROUND|SQRT|POWER|EXP|LN|LOG)\s*\(/gi;

  // Strings (single or double quotes)
  const strings = /(["'])(?:(?=(\\?))\2.)*?\1/g;

  // Numbers (integers and decimals)
  const numbers = /\b\d+\.?\d*\b/g;

  // Field references [Field Name]
  const fieldRefs = /\[([^\[\]:]+)\]/g;

  // Parameter references [:Parameter Name]
  const paramRefs = /\[:([\w\s]+)\]/g;

  // Comments (Tableau uses // for comments)
  const comments = /\/\/.*/g;

  // Operators
  const operators = /([+\-*/%=<>!&|])/g;

  // Escape HTML first
  let highlighted = escapeHtml(formula);

  // Apply highlighting in specific order to avoid conflicts
  // 1. Comments (must be first to not highlight within comments)
  highlighted = highlighted.replace(comments, (match) => `<span class="comment">${match}</span>`);

  // 2. Strings (must be before other patterns)
  highlighted = highlighted.replace(strings, (match) => `<span class="string">${match}</span>`);

  // 3. Parameter references [:Param]
  highlighted = highlighted.replace(paramRefs, (match) => `<span class="param-ref">${match}</span>`);

  // 4. Field references [Field]
  highlighted = highlighted.replace(fieldRefs, (match) => `<span class="field-ref">${match}</span>`);

  // 5. Functions (before keywords to avoid conflicts)
  highlighted = highlighted.replace(functions, (match) => `<span class="function">${match}</span>`);

  // 6. Keywords
  highlighted = highlighted.replace(keywords, (match) => `<span class="keyword">${match}</span>`);

  // 7. Numbers
  highlighted = highlighted.replace(numbers, (match) => `<span class="number">${match}</span>`);

  // 8. Operators
  highlighted = highlighted.replace(operators, (match) => `<span class="operator">${match}</span>`);

  return highlighted;
}

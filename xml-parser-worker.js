/**
 * Web Worker for parsing Tableau workbook XML off the main thread.
 * This improves UI responsiveness for large workbooks by offloading
 * CPU-intensive XML parsing to a background thread.
 */

self.addEventListener('message', function(event) {
  const { type, data } = event.data;

  try {
    if (type === 'parse-xml') {
      const { xmlText } = data;

      if (!xmlText || typeof xmlText !== 'string') {
        throw new Error('Invalid XML text provided');
      }

      // Parse XML using DOMParser
      const parser = new DOMParser();
      const doc = parser.parseFromString(xmlText, 'text/xml');

      // Check for parse errors
      const errorNode = doc.querySelector('parsererror');
      if (errorNode) {
        const message = errorNode.textContent?.trim() || 'Unable to parse workbook XML.';
        throw new Error(
          `This file contains invalid XML and cannot be read.\n\n${message}\n\nThe workbook file may be corrupted. Try re-saving it from Tableau Desktop.`
        );
      }

      // Validate it's a Tableau workbook
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

      // Serialize the DOM document to a transferable format
      // We can't transfer the Document object itself, so we serialize to string
      const serializer = new XMLSerializer();
      const serializedXml = serializer.serializeToString(doc);

      // Send success response back to main thread
      self.postMessage({
        type: 'parse-success',
        data: {
          xmlText: serializedXml,
          rootTag: rootTag,
          isValid: true
        }
      });

    } else {
      throw new Error(`Unknown message type: ${type}`);
    }

  } catch (error) {
    // Send error back to main thread
    self.postMessage({
      type: 'parse-error',
      error: {
        message: error.message,
        name: error.name,
        stack: error.stack
      }
    });
  }
});

// Signal that worker is ready
self.postMessage({ type: 'worker-ready' });

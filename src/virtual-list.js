/**
 * @fileoverview Virtual scrolling implementation for large lists
 * @module virtual-list
 *
 * Implements virtual scrolling to handle lists with 1000+ items efficiently.
 * Only renders visible items + buffer, dramatically reducing DOM nodes.
 */

import { VIRTUAL_SCROLL_THRESHOLD, VIRTUAL_SCROLL_BUFFER, VIRTUAL_ITEM_HEIGHT } from './constants.js';

/**
 * Creates a virtual scrolling list for large datasets
 * Only renders visible items + buffer to improve performance
 *
 * @param {HTMLElement} container - Container element (ul/ol)
 * @param {Array} items - Full array of items to render
 * @param {Function} renderItem - Function that creates DOM element for each item
 * @returns {Function} Cleanup function to remove event listeners
 *
 * @example
 * const cleanup = createVirtualList(listElement, items, (item) => {
 *   const li = document.createElement('li');
 *   li.textContent = item.name;
 *   return li;
 * });
 * // Later: cleanup(); to remove listeners
 */
export function createVirtualList(container, items, renderItem) {
  if (!container || items.length < VIRTUAL_SCROLL_THRESHOLD) {
    // For small lists, render all items normally
    items.forEach(item => {
      const element = renderItem(item);
      if (element) container.appendChild(element);
    });
    return () => {}; // No cleanup needed
  }

  // Virtual scrolling for large lists
  const totalHeight = items.length * VIRTUAL_ITEM_HEIGHT;
  const viewportHeight = container.parentElement?.clientHeight || 600;

  // Create spacer to maintain scroll height
  const spacer = document.createElement('div');
  spacer.style.height = `${totalHeight}px`;
  spacer.style.position = 'relative';
  container.appendChild(spacer);

  let currentStart = 0;
  let currentEnd = 0;
  const renderedElements = new Map();

  /**
   * Updates which items are visible based on scroll position
   */
  function updateVisibleItems() {
    const scrollTop = container.parentElement?.scrollTop || 0;
    const start = Math.floor(scrollTop / VIRTUAL_ITEM_HEIGHT);
    const visibleCount = Math.ceil(viewportHeight / VIRTUAL_ITEM_HEIGHT);

    // Add buffer above and below viewport
    const bufferStart = Math.max(0, start - VIRTUAL_SCROLL_BUFFER);
    const bufferEnd = Math.min(items.length, start + visibleCount + VIRTUAL_SCROLL_BUFFER);

    if (bufferStart === currentStart && bufferEnd === currentEnd) {
      return; // No change needed
    }

    // Remove items outside visible range
    for (let i = currentStart; i < bufferStart; i++) {
      const elem = renderedElements.get(i);
      if (elem && elem.parentNode) elem.parentNode.removeChild(elem);
      renderedElements.delete(i);
    }
    for (let i = bufferEnd; i < currentEnd; i++) {
      const elem = renderedElements.get(i);
      if (elem && elem.parentNode) elem.parentNode.removeChild(elem);
      renderedElements.delete(i);
    }

    // Add new items in visible range
    for (let i = bufferStart; i < bufferEnd; i++) {
      if (!renderedElements.has(i)) {
        const item = items[i];
        const elem = renderItem(item);
        if (elem) {
          elem.style.position = 'absolute';
          elem.style.top = `${i * VIRTUAL_ITEM_HEIGHT}px`;
          elem.style.width = '100%';
          spacer.appendChild(elem);
          renderedElements.set(i, elem);
        }
      }
    }

    currentStart = bufferStart;
    currentEnd = bufferEnd;
  }

  // Initial render
  updateVisibleItems();

  // Update on scroll
  const scrollHandler = () => {
    requestAnimationFrame(updateVisibleItems);
  };

  const scrollContainer = container.parentElement;
  if (scrollContainer) {
    scrollContainer.addEventListener('scroll', scrollHandler, { passive: true });
  }

  // Return cleanup function
  return () => {
    if (scrollContainer) {
      scrollContainer.removeEventListener('scroll', scrollHandler);
    }
    renderedElements.clear();
  };
}

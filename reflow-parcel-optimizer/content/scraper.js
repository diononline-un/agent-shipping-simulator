/**
 * ReFlow Parcel Optimizer — Warehouse Item Scraper
 *
 * Two-pass strategy:
 * 1. Try the agent's configured CSS selectors (fast, specific)
 * 2. Fall back to content-based detection: scan the page for elements
 *    matching the dimension pattern "N * N * N" and walk up the DOM
 *    to find each item's container. Works regardless of CSS class names.
 */

/* global module */

const DIMENSION_PATTERN = /(\d+)\s*\*\s*(\d+)\s*\*\s*(\d+)/;
const WEIGHT_PATTERN    = /^\s*\d{2,5}\s*$/; // 10–99999 grams, digits only

// ── Helpers ───────────────────────────────────────────────────────────────────

function cellText(parent, selector) {
  const el = parent.querySelector(selector);
  return el ? el.textContent.trim() : "";
}

function allText(el) {
  return (el.textContent || "").trim();
}

/**
 * Walk up the DOM from `el` until we find a node that:
 * - Contains both a dimension string AND a weight-like string
 * - Has a checkbox input inside it
 * - Is not the document body
 * Returns null if no suitable ancestor found within `maxLevels` steps.
 */
function findItemContainer(el, maxLevels = 8) {
  let node = el.parentElement;
  for (let i = 0; i < maxLevels; i++) {
    if (!node || node === document.body) break;
    const text = allText(node);
    const hasWeight = WEIGHT_PATTERN.test(
      // Look for a short numeric token anywhere in the node
      (text.match(/\b(\d{2,5})\b/) || [])[0] || ""
    );
    const hasDimension = DIMENSION_PATTERN.test(text);
    const hasCheckbox  = !!node.querySelector("input[type='checkbox']");
    if (hasDimension && hasWeight && hasCheckbox) return node;
    node = node.parentElement;
  }
  return null;
}

/**
 * Walk up from `container` to find the GTBuy order card header that contains
 * "Order No: IGT..." and extract the order ID.
 * Returns "" if not found.
 *
 * @param {Element} container
 * @param {number}  maxLevels
 * @returns {string}
 */
function findOrderIdNear(container, maxLevels = 8) {
  let node = container.parentElement;
  for (let i = 0; i < maxLevels; i++) {
    if (!node || node === document.body) break;
    const text = allText(node);
    const m    = text.match(/Order\s+No\s*[：:]\s*([A-Za-z0-9]{6,})/i);
    if (m) return m[1];
    node = node.parentElement;
  }
  return "";
}

// ── Pass 1: CSS-selector based ────────────────────────────────────────────────

function scrapeWithSelectors(agentConfig) {
  const { selectors, parsers } = agentConfig;
  const containers = document.querySelectorAll(selectors.itemContainer);
  if (!containers || containers.length === 0) return null;

  const items = [];
  let index = 0;

  containers.forEach((container) => {
    const checkbox = container.querySelector(selectors.itemCheckbox);
    if (!checkbox) return;

    const weightText    = cellText(container, selectors.weightCell);
    const dimensionText = cellText(container, selectors.dimensionCell);
    const categoryText  = cellText(container, selectors.categoryCell);
    const nameText      = cellText(container, selectors.nameCell);

    const weight     = parsers.weight(weightText);
    const dimensions = parsers.dimensions(dimensionText);
    if (weight <= 0) return;

    items.push({
      id:          `item-${index}`,
      name:        nameText || `Item ${index + 1}`,
      weight,
      dimensions,
      quantity:    1,
      category:    categoryText || "Unknown",
      orderId:     findOrderIdNear(container),
      checkboxRef: checkbox,
    });
    index++;
  });

  return items.length > 0 ? items : null;
}

// ── Pass 2: Content-based detection ──────────────────────────────────────────

function scrapeByContent(agentConfig) {
  const { parsers } = agentConfig;

  // Find all text nodes that match the dimension pattern
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        return DIMENSION_PATTERN.test(node.nodeValue)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP;
      },
    }
  );

  const seen     = new Set();
  const items    = [];
  let   index    = 0;
  let   textNode = walker.nextNode();

  while (textNode) {
    const container = findItemContainer(textNode.parentElement);
    if (container && !seen.has(container)) {
      seen.add(container);

      const fullText     = allText(container);
      const dimMatch     = fullText.match(DIMENSION_PATTERN);
      const weightTokens = fullText.match(/\b(\d{3,5})\b/g) || [];

      const dimensionText = dimMatch ? dimMatch[0] : "";
      const dimensions    = parsers.dimensions(dimensionText);

      // Pick the weight token that is NOT part of a dimension (heuristic:
      // use the first standalone 3-5 digit number that is NOT one of l/w/h)
      const dimNums = dimMatch
        ? [dimMatch[1], dimMatch[2], dimMatch[3]].map(Number)
        : [];
      const weightText = weightTokens.find((t) => !dimNums.includes(Number(t))) || "";
      const weight     = parsers.weight(weightText);

      if (weight <= 0 || !dimMatch) {
        textNode = walker.nextNode();
        continue;
      }

      // Try to extract a product name: first <a> or <p> text longer than 5 chars
      const nameEl = container.querySelector("a, p, .name, .title, .product-name");
      const name   = nameEl
        ? nameEl.textContent.trim().slice(0, 60)
        : `Item ${index + 1}`;

      const checkbox = container.querySelector("input[type='checkbox']");
      if (!checkbox) {
        textNode = walker.nextNode();
        continue;
      }

      items.push({
        id:          `item-${index}`,
        name:        name || `Item ${index + 1}`,
        weight,
        dimensions,
        quantity:    1,
        category:    "Unknown",
        orderId:     findOrderIdNear(container),
        checkboxRef: checkbox,
      });
      index++;
    }
    textNode = walker.nextNode();
  }

  return items.length > 0 ? items : null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Scrapes all warehouse items from the current page.
 * Tries CSS-selector approach first, falls back to content-based detection.
 *
 * @param {Object} agentConfig
 * @returns {{ items: WarehouseItem[], error: string|null }}
 */
function scrapeItems(agentConfig) {
  // Pass 1: configured selectors
  const bySelector = scrapeWithSelectors(agentConfig);
  if (bySelector) {
    console.log(`[ReFlow] Scraper (selectors): found ${bySelector.length} items`);
    return { items: bySelector, error: null };
  }

  // Pass 2: content-based fallback
  const byContent = scrapeByContent(agentConfig);
  if (byContent) {
    console.log(`[ReFlow] Scraper (content-based): found ${byContent.length} items`);
    return { items: byContent, error: null };
  }

  const msg = "[ReFlow] No items found. Check DevTools console for details.";
  console.warn(msg);
  console.debug("[ReFlow] Tried selector:", agentConfig.selectors.itemContainer);
  console.debug("[ReFlow] Page URL:", window.location.href);
  return { items: [], error: msg };
}

if (typeof module !== "undefined") module.exports = { scrapeItems };

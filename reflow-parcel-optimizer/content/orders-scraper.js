/**
 * ReFlow Parcel Optimizer — Orders Page Scraper
 *
 * Scrapes gtbuy.com/user/order for purchase data per order line item.
 * Designed around GTBuy's card layout where each order card has a header
 * containing "Order No: IGT..." and one or more item rows below it.
 *
 * Extracted fields per line item:
 *   orderId     — GTBuy order number (e.g. "IGT2603280618018560")
 *   name        — Product title (truncated to 100 chars)
 *   description — Color/Size/Style attributes (e.g. "Color: Creamy-white")
 *   unitPrice   — Per-unit purchase price (USD, numeric)
 *   totalPrice  — Total for this line (unitPrice × quantity)
 *   quantity    — Number of units (from "x 5" badge)
 *   currency    — "USD" (GTBuy shows prices in USD)
 *
 * Results are MERGED into chrome.storage.local["reflow_orders"] keyed by orderId
 * so that paginating through multiple order pages accumulates all orders.
 *
 * Call scrapeOrders() once per page; storeOrders() handles the merge.
 */

/* global module */

// ── Pattern constants ─────────────────────────────────────────────────────────

/** "Order No: IGT2603280618018560" */
const ORDER_ID_RE     = /Order\s+No\s*[：:]\s*([A-Za-z0-9]{6,})/i;
/** "$4.19" or "$ 22.57" */
const USD_PRICE_RE    = /^\$\s*([\d,]+\.?\d*)$/;
/** "x 5" or "x5" — standalone quantity badge */
const QTY_BADGE_RE   = /^[xX×]\s*(\d+)$/;
/** Attribute lines: "Color: Creamy-white", "Size: 42" etc. */
const ATTR_LINE_RE   = /^(?:Color|Size|Style|Material|Type|Spec)\s*[：:]/i;
/** Patterns that disqualify a text node as a product name */
const SKIP_NAME_RE   = /^(?:\$|¥|x\s*\d|Warehoused|Shipped|Pending|Custom|Quality|Order|Creation|Warehouse|Original|\d{4}-\d{2}|Track|Apply|Consult)/i;

// ── Core scraper ──────────────────────────────────────────────────────────────

/**
 * Main entry point. Scrapes the current orders page.
 * @param {Object} agentConfig  (not currently needed; kept for API consistency)
 * @returns {{ orders: object[], count: number, error: string|null }}
 */
function scrapeOrders(_agentConfig) {
  const cards = findOrderCards();

  if (cards.length === 0) {
    const msg = "[ReFlow] No order cards found. Are you on gtbuy.com/user/order?";
    console.warn(msg);
    return { orders: [], count: 0, error: msg };
  }

  const orders = [];
  for (const { orderId, cardEl } of cards) {
    const items = extractItemsFromCard(cardEl, orderId);
    orders.push(...items);
  }

  console.log(`[ReFlow] Orders scraper: ${cards.length} cards → ${orders.length} items`);
  return { orders, count: orders.length, error: null };
}

// ── Step 1: Locate order card boundaries ─────────────────────────────────────

/**
 * Find all order card containers on the page by walking every leaf text node
 * and matching "Order No: IGT..." patterns.
 *
 * For each match, we walk UP the DOM until we find a container that:
 *  - Is the direct parent of both the order header AND item rows (i.e. it
 *    contains price-like content further down)
 *  - Has meaningful child count
 *
 * @returns {{ orderId: string, cardEl: Element }[]}
 */
function findOrderCards() {
  const results = [];
  const seenIds = new Set();

  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        return ORDER_ID_RE.test(node.nodeValue)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP;
      },
    }
  );

  let textNode = walker.nextNode();
  while (textNode) {
    const m = (textNode.nodeValue || "").match(ORDER_ID_RE);
    if (m) {
      const orderId = m[1];
      if (!seenIds.has(orderId)) {
        seenIds.add(orderId);
        const cardEl = findCardContainer(textNode.parentElement);
        if (cardEl) results.push({ orderId, cardEl });
      }
    }
    textNode = walker.nextNode();
  }

  return results;
}

/**
 * Walk UP from the "Order No:" element to find the order card container.
 * The card must:
 *  - Not be body/html
 *  - Have ≥ 2 direct children (header row + item rows)
 *  - Contain at least one "$" price further inside it (confirm it has items)
 */
function findCardContainer(el) {
  let node = el;
  for (let depth = 0; depth < 12 && node && node !== document.body; depth++) {
    if (
      node.children.length >= 2 &&
      /\$\s*[\d.]+/.test(node.textContent || "")
    ) {
      return node;
    }
    node = node.parentElement;
  }
  // Fallback: just return a reasonable ancestor
  node = el;
  for (let depth = 0; depth < 6 && node && node !== document.body; depth++) {
    node = node.parentElement;
    if (node && node.children.length >= 2) return node;
  }
  return null;
}

// ── Step 2: Extract items from a card ────────────────────────────────────────

/**
 * Given an order card element + its orderId, extract all line items.
 *
 * Strategy:
 *  1. Collect all leaf text nodes in the card
 *  2. Find USD price nodes ("$X.XX") — these anchor each item row
 *  3. Group prices: if there are 2 prices (unit + total), pair them
 *  4. Find quantity ("x 5"), name, and description near each price cluster
 *
 * @param {Element} cardEl
 * @param {string}  orderId
 * @returns {object[]}
 */
function extractItemsFromCard(cardEl, orderId) {
  // Collect all leaf elements
  const leaves = leafElements(cardEl);

  // ── Prices ────────────────────────────────────────────────────────────────
  const priceLeaves = leaves.filter((el) => USD_PRICE_RE.test(el.textContent.trim()));
  if (priceLeaves.length === 0) return [];

  // Parse price values
  const prices = priceLeaves.map((el) => {
    const m = el.textContent.trim().match(USD_PRICE_RE);
    return { el, value: parseFloat((m ? m[1] : "0").replace(/,/g, "")) };
  });

  // If we have exactly 2 prices, assume [unitPrice, totalPrice]
  // If we have 1, it's the total (unit unknown)
  // If we have > 2, pick smallest as unit, largest as total
  prices.sort((a, b) => a.value - b.value);
  const unitPrice  = prices.length >= 2 ? prices[0].value  : 0;
  const totalPrice = prices[prices.length - 1].value;

  // ── Quantity ──────────────────────────────────────────────────────────────
  const qtyLeaf = leaves.find((el) => QTY_BADGE_RE.test(el.textContent.trim()));
  const qty = qtyLeaf
    ? parseInt(qtyLeaf.textContent.trim().replace(/\D/g, ""), 10) || 1
    : (unitPrice > 0 && totalPrice > unitPrice
        ? Math.round(totalPrice / unitPrice)  // derive from prices
        : 1);

  // ── Product name ──────────────────────────────────────────────────────────
  // Best candidate: a text node with 15–100 chars that doesn't match skip patterns
  const nameLeaf = leaves.find((el) => {
    const t = el.textContent.trim();
    return t.length >= 10 && t.length <= 120 && !SKIP_NAME_RE.test(t) &&
           !USD_PRICE_RE.test(t) && !QTY_BADGE_RE.test(t) && !ATTR_LINE_RE.test(t);
  });
  const name = nameLeaf ? nameLeaf.textContent.trim().replace(/…$|\.{3}$/, "").slice(0, 100) : "";

  // ── Description (Color / Size / etc.) ─────────────────────────────────────
  const descParts = leaves
    .filter((el) => ATTR_LINE_RE.test(el.textContent.trim()))
    .map((el) => el.textContent.trim());
  const description = descParts.join("; ");

  // Only emit if we found something useful
  if (!name && !unitPrice && !totalPrice) return [];

  return [{
    orderId,
    name,
    description,
    unitPrice,
    totalPrice,
    quantity: qty,
    currency: "USD",
  }];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Return all leaf elements (elements with no child elements) within `root`.
 * Skips script/style/img/svg nodes.
 * @param {Element} root
 * @returns {Element[]}
 */
function leafElements(root) {
  const results = [];
  const skip    = new Set(["SCRIPT", "STYLE", "IMG", "SVG", "INPUT", "BUTTON"]);

  function walk(el) {
    if (skip.has(el.tagName)) return;
    if (el.childElementCount === 0) {
      if ((el.textContent || "").trim()) results.push(el);
      return;
    }
    for (const child of el.children) walk(child);
  }
  walk(root);
  return results;
}

// ── Storage ───────────────────────────────────────────────────────────────────

/**
 * Merge newly-scraped orders into chrome.storage.local.
 * Keyed by orderId — paginating through the orders list accumulates entries
 * rather than overwriting them.
 *
 * @param {object[]} freshOrders
 * @param {string}   [sourceUrl]
 * @returns {Promise<void>}
 */
function storeOrders(freshOrders, sourceUrl) {
  return new Promise((resolve) => {
    chrome.storage.local.get(["reflow_orders"], (stored) => {
      const existing = stored.reflow_orders || [];

      // Build a map keyed by orderId for deduplication
      const byId = Object.create(null);
      for (const o of existing)    byId[o.orderId || o.name || Math.random()] = o;
      for (const o of freshOrders) byId[o.orderId || o.name || Math.random()] = o;

      const merged = Object.values(byId);

      chrome.storage.local.set(
        {
          reflow_orders:     merged,
          reflow_orders_ts:  Date.now(),
          reflow_orders_url: sourceUrl || window.location.href,
        },
        resolve
      );
    });
  });
}

if (typeof module !== "undefined") module.exports = { scrapeOrders, storeOrders };

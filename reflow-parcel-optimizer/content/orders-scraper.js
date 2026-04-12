/**
 * ReFlow Parcel Optimizer — Orders Page Scraper
 *
 * Scrapes gtbuy.com/user/order (or any orders page) for product purchase data.
 * Stores results in chrome.storage.local under "reflow_orders" for CSV export.
 *
 * Fields extracted per order line item:
 *   name        — Product title
 *   url         — Source marketplace link (Taobao / 1688 / Tmall / etc.)
 *   price       — Purchase price (numeric, typically CNY)
 *   currency    — Currency code (default "CNY")
 *   orderId     — GTBuy order ID string
 *   quantity    — Number of units in this order line
 */

/* global module */

/** Matches hrefs pointing to Chinese source marketplaces */
const SOURCE_URL_RE = /taobao\.com|1688\.com|tmall\.com|weidian\.com|jd\.com|pinduoduo\.com|yangkeduo\.com/i;

// ── Pass 1: CSS-selector approach ─────────────────────────────────────────────

function scrapeOrdersBySelectors(agentConfig) {
  const { selectors, parsers } = agentConfig;
  if (!selectors.ordersItemContainer) return null;

  const containers = document.querySelectorAll(selectors.ordersItemContainer);
  if (!containers || containers.length === 0) return null;

  const items = [];

  containers.forEach((container) => {
    // Product link → name + source URL
    const linkSel = selectors.ordersProductLink || "a[href]";
    const linkEl  = Array.from(container.querySelectorAll(linkSel))
      .find((a) => SOURCE_URL_RE.test(a.href)) ||
      container.querySelector(linkSel);

    if (!linkEl) return;

    const name = (linkEl.textContent || linkEl.title || linkEl.getAttribute("aria-label") || "")
      .trim().replace(/\s+/g, " ").slice(0, 100);
    const url  = SOURCE_URL_RE.test(linkEl.href) ? linkEl.href : "";

    if (!name) return;

    // Price
    const priceSel  = selectors.ordersPrice || ".price";
    const priceEl   = container.querySelector(priceSel);
    const priceText = priceEl ? priceEl.textContent.trim() : "";
    const price     = parsers.price(priceText);

    // Quantity
    const qtySel = selectors.ordersQuantity || ".qty";
    const qtyEl  = container.querySelector(qtySel);
    const qty    = qtyEl ? (parseInt(qtyEl.textContent.replace(/\D/g, ""), 10) || 1) : 1;

    // Order ID: walk up to find order-level container
    let orderId = "";
    let node    = container.parentElement;
    for (let i = 0; i < 6 && node && node !== document.body; i++) {
      const idEl = node.querySelector(selectors.ordersId || ".order-no, .order-number, .orderNo");
      if (idEl) {
        orderId = idEl.textContent.trim().replace(/[^A-Za-z0-9]/g, "");
        break;
      }
      node = node.parentElement;
    }

    items.push({ name, url, price, currency: "CNY", orderId, quantity: qty });
  });

  return items.length > 0 ? items : null;
}

// ── Pass 2: Content-based (follow source-marketplace links) ──────────────────

function scrapeOrdersByContent() {
  const items = [];
  const seen  = new Set();

  // Collect all links to Chinese source marketplaces on the page
  Array.from(document.querySelectorAll("a[href]"))
    .filter((a) => SOURCE_URL_RE.test(a.href))
    .forEach((link) => {
      const url = link.href;
      if (seen.has(url)) return;
      seen.add(url);

      const rawName = (
        link.textContent ||
        link.title ||
        link.getAttribute("aria-label") ||
        ""
      ).trim().replace(/\s+/g, " ");

      const name = rawName.slice(0, 100);
      if (!name) return;

      let price   = 0;
      let orderId = "";
      let qty     = 1;

      // Walk up the DOM to harvest price + order ID from surrounding context
      let node = link.parentElement;
      for (let depth = 0; depth < 14 && node && node !== document.body; depth++) {
        const text = node.textContent || "";

        // Price: ¥499.00 or ¥ 499 or CNY 499
        if (!price) {
          const m = text.match(/[¥￥]\s*([\d,]+\.?\d*)/);
          if (m) price = parseFloat(m[1].replace(/,/g, "")) || 0;
        }

        // Order ID near "Order No" / "订单号"
        if (!orderId) {
          const m = text.match(
            /(?:Order\s*(?:No\.?|Number|ID|#)|订单号?)\s*[：:\s]*([A-Za-z0-9]{8,})/i
          );
          if (m) orderId = m[1];
        }

        // Quantity: ×3, x 3, qty: 3, 数量:3
        if (qty === 1) {
          const m = text.match(/[×xX]\s*(\d+)|(?:数量|Qty|Quantity)[：:\s]+(\d+)/i);
          if (m) qty = parseInt(m[1] || m[2], 10) || 1;
        }

        if (price && orderId) break;
        node = node.parentElement;
      }

      items.push({ name, url, price, currency: "CNY", orderId, quantity: qty });
    });

  return items;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Scrape the current orders page.
 * Tries CSS-selectors first, falls back to link-based content detection.
 *
 * @param {Object} agentConfig
 * @returns {{ orders: object[], count: number, error: string|null }}
 */
function scrapeOrders(agentConfig) {
  const bySelector = scrapeOrdersBySelectors(agentConfig);
  if (bySelector) {
    console.log(`[ReFlow] Orders scraper (selectors): ${bySelector.length} items`);
    return { orders: bySelector, count: bySelector.length, error: null };
  }

  const byContent = scrapeOrdersByContent();
  if (byContent.length > 0) {
    console.log(`[ReFlow] Orders scraper (content): ${byContent.length} items`);
    return { orders: byContent, count: byContent.length, error: null };
  }

  const msg = "[ReFlow] No order items found. Visit gtbuy.com/user/order to capture price data.";
  console.warn(msg);
  return { orders: [], count: 0, error: msg };
}

/**
 * Persist scraped order items to chrome.storage.local.
 * Key: "reflow_orders" (array), "reflow_orders_ts" (timestamp ms), "reflow_orders_url".
 *
 * @param {object[]} orders
 * @param {string}   [sourceUrl]
 */
function storeOrders(orders, sourceUrl) {
  chrome.storage.local.set({
    reflow_orders:     orders,
    reflow_orders_ts:  Date.now(),
    reflow_orders_url: sourceUrl || window.location.href,
  });
}

if (typeof module !== "undefined") module.exports = { scrapeOrders, storeOrders };

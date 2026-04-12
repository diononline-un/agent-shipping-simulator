/**
 * ReFlow Parcel Optimizer — GTBuy Agent Config
 *
 * CSS selectors and parsers for gtbuy.com.
 * NOTE: nth-child column indices must be verified against the live GTBuy DOM.
 *       Open DevTools on the warehouse page and inspect the table structure.
 */

/* global module */

const gtbuyConfig = {
  id: "gtbuy",
  name: "GTBuy",
  urlPattern:         /gtbuy\.com/,
  warehouseUrlPattern: /gtbuy\.com.*warehouse/i,
  ordersUrlPattern:    /gtbuy\.com.*\border\b/i,

  selectors: {
    // ── Warehouse page ────────────────────────────────────────────────────────
    // Verified from live screenshot: GTBuy uses a card layout per order.
    // Each order card wraps a header row + product data row.
    // The content-based scraper in scraper.js handles this automatically;
    // these selectors are the CSS fast-path (may need per-deploy tuning).
    itemContainer: "div.table-content > div",

    // Checkbox inside each item container row (left of product image)
    itemCheckbox: "input[type='checkbox']",

    // "Select All" footer checkbox (bottom-left of warehouse page)
    selectAllCheckbox: "div.all-select-footer input, .select-all input, footer input[type='checkbox']",

    // Columns visible in live screenshot (content-based scraper used as fallback):
    // Product Details | Warehousing Time | Quantity | Weight(g) | Dimension(cm) | Order Status | Commodity Type | Operate
    nameCell:      "td:nth-child(1)",
    weightCell:    "td:nth-child(4)",
    dimensionCell: "td:nth-child(5)",
    categoryCell:  "td:nth-child(7)",

    // "Create Parcel" orange button at bottom-right.
    // Verified text from screenshot: "Create Parcel"
    // div.bor-e2 is the Blueprint selector; text fallback is in simulator.js
    submitButton: "div.bor-e2, .create-parcel-btn, button.submit-parcel",

    // ── Shipping line page (after submitButton click) ─────────────────────────
    shippingLineRows: "table tbody tr, .shipping-line-list > div, .mailing-route tr",

    shippingLineName:  "td:nth-child(1)",
    shippingLinePrice: "td:nth-child(3)",
    shippingLineDays:  "td:nth-child(4)",

    shippingPageMarker: "Mailing Route",

    // ── Safety blacklist ──────────────────────────────────────────────────────
    FORBIDDEN_BUTTON_TEXTS: ["Submit Parcel", "Confirm Order", "Place Order", "Pay Now"],

    // ── Orders page (gtbuy.com/user/order) ───────────────────────────────────
    // Each order card contains one or more goods items.
    // These selectors are heuristic; the content-based fallback handles unknowns.
    ordersItemContainer: ".goods-item, .order-goods-item, .goods-info, .product-item",
    ordersProductLink:   "a.goods-name, a.product-name, .item-title a, .goods-title a",
    ordersPrice:         ".goods-price .price, .price-tag, .amount, .goods-amount",
    ordersQuantity:      ".goods-num, .quantity, .num, .qty",
    ordersId:            ".order-no, .order-number, .orderNo, .order-sn",
  },

  parsers: {
    /**
     * Parse weight text to grams.
     * GTBuy shows e.g. "1930" or "1,930 g"
     * @param {string} text
     * @returns {number}
     */
    weight(text) {
      const cleaned = text.replace(/[^\d]/g, "");
      return cleaned ? parseInt(cleaned, 10) : 0;
    },

    /**
     * Parse dimension string to {length, width, height} in cm.
     * GTBuy format: "40 * 33 * 12"
     * @param {string} text
     * @returns {{length: number, width: number, height: number}}
     */
    dimensions(text) {
      const parts = text.split("*").map((s) => parseFloat(s.trim()));
      return {
        length: parts[0] || 0,
        width:  parts[1] || 0,
        height: parts[2] || 0,
      };
    },

    /**
     * Parse price string to USD float.
     * GTBuy format: "$58.46"
     * @param {string} text
     * @returns {number}
     */
    price(text) {
      const cleaned = text.replace(/[^0-9.]/g, "");
      return cleaned ? parseFloat(cleaned) : 0;
    },
  },

  /**
   * Detects whether the current page is the GTBuy warehouse listing.
   * @param {string} url
   * @returns {boolean}
   */
  isWarehousePage(url) {
    return this.warehouseUrlPattern.test(url);
  },

  /**
   * Detects whether the current page is the GTBuy orders listing.
   * @param {string} url
   * @returns {boolean}
   */
  isOrdersPage(url) {
    return this.ordersUrlPattern.test(url);
  },
};

// Support both browser extension (no module system) and Node.js tests
if (typeof module !== "undefined") module.exports = gtbuyConfig;

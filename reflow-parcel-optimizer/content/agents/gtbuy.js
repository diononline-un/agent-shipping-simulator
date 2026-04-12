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
  urlPattern: /gtbuy\.com/,
  warehouseUrlPattern: /gtbuy\.com.*warehouse/i,

  selectors: {
    // ── Warehouse page ────────────────────────────────────────────────────────
    // Each top-level div inside div.table-content represents one warehouse item.
    itemContainer: "div.table-content > div",

    // Checkbox inside each item container row
    itemCheckbox: "input[type='checkbox']",

    // "Select All" footer checkbox
    selectAllCheckbox: "div.all-select-footer input",

    // Table cell selectors — column order per Blueprint Section 4.1:
    // Col 1: thumbnail/name, Col 2: name text, Col 3: qty,
    // Col 4: Weight(g), Col 5: Dimension(cm), Col 6: price,
    // Col 7: Commodity Type
    nameCell:      "td:nth-child(2)",
    weightCell:    "td:nth-child(4)",
    dimensionCell: "td:nth-child(5)",
    categoryCell:  "td:nth-child(7)",

    // Button that navigates to the parcel-creation / shipping-line page
    submitButton: "div.bor-e2",

    // ── Shipping line page (after submitButton click) ─────────────────────────
    // Container selector for the "Mailing Route" table rows
    shippingLineRows: "table tbody tr",

    // Within each shipping line row:
    shippingLineName:  "td:nth-child(1)",  // Brand / Line name
    shippingLinePrice: "td:nth-child(3)",  // Transportation Costs
    shippingLineDays:  "td:nth-child(4)",  // Shipping Cycle (Business Day)

    // Anchor text that marks the shipping-lines section has loaded
    shippingPageMarker: "Mailing Route",

    // ── Safety blacklist ──────────────────────────────────────────────────────
    // Button text fragments that must NEVER be clicked by the extension.
    FORBIDDEN_BUTTON_TEXTS: ["Submit Parcel", "Confirm Order", "Place Order", "Pay Now"],
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
};

// Support both browser extension (no module system) and Node.js tests
if (typeof module !== "undefined") module.exports = gtbuyConfig;

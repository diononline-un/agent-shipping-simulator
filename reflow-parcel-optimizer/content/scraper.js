/**
 * ReFlow Parcel Optimizer — Warehouse Item Scraper
 *
 * Reads all items from the current agent's warehouse DOM and returns
 * a structured WarehouseItem array.
 */

/* global module */

/**
 * Extracts text content from a child element matching `selector` inside `parent`.
 * Returns "" when not found.
 * @param {Element} parent
 * @param {string}  selector
 * @returns {string}
 */
function cellText(parent, selector) {
  const el = parent.querySelector(selector);
  return el ? el.textContent.trim() : "";
}

/**
 * Scrapes all warehouse items from the current page.
 *
 * @param {Object} agentConfig - The active agent's config (e.g. gtbuyConfig)
 * @returns {{ items: import('./types').WarehouseItem[], error: string|null }}
 */
function scrapeItems(agentConfig) {
  const { selectors, parsers } = agentConfig;

  const containers = document.querySelectorAll(selectors.itemContainer);
  if (!containers || containers.length === 0) {
    return {
      items: [],
      error: `[ReFlow] No item containers found with selector: "${selectors.itemContainer}"`,
    };
  }

  const items = [];
  let index = 0;

  containers.forEach((container) => {
    // Skip header/footer rows that don't contain a checkbox
    const checkbox = container.querySelector(selectors.itemCheckbox);
    if (!checkbox) return;

    const weightText    = cellText(container, selectors.weightCell);
    const dimensionText = cellText(container, selectors.dimensionCell);
    const categoryText  = cellText(container, selectors.categoryCell);
    const nameText      = cellText(container, selectors.nameCell);

    const weight     = parsers.weight(weightText);
    const dimensions = parsers.dimensions(dimensionText);

    // Skip items with no usable weight data
    if (weight <= 0) return;

    items.push({
      id:          `item-${index}`,
      name:        nameText || `Item ${index + 1}`,
      weight,
      dimensions,
      quantity:    1,
      category:    categoryText || "Unknown",
      checkboxRef: checkbox,
    });

    index++;
  });

  if (items.length === 0) {
    return {
      items: [],
      error: "[ReFlow] Items found in DOM but none had valid weight data.",
    };
  }

  return { items, error: null };
}

if (typeof module !== "undefined") module.exports = { scrapeItems };

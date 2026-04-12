/**
 * ReFlow Parcel Optimizer — DOM Simulation Engine
 *
 * Simulates the parcel creation flow on the agent website to read shipping
 * line prices WITHOUT placing any real orders.
 *
 * Safety guarantee: buttons listed in agentConfig.selectors.FORBIDDEN_BUTTON_TEXTS
 * are NEVER clicked.
 */

/* global module */

const SIMULATION_PAUSE_MS = 2000;
const SHIPPING_PAGE_TIMEOUT_MS = 15000;
const WAREHOUSE_RELOAD_TIMEOUT_MS = 10000;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Fires a synthetic click event that bubbles — required for Vue/React frameworks.
 * @param {Element} el
 */
function safeClick(el) {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

/**
 * Throws if the element's text matches a forbidden button.
 * @param {Element} el
 * @param {string[]} forbiddenTexts
 */
function assertNotForbidden(el, forbiddenTexts) {
  const text = (el.textContent || "").trim();
  for (const forbidden of forbiddenTexts) {
    if (text.toLowerCase().includes(forbidden.toLowerCase())) {
      throw new Error(`[ReFlow] Safety: will not click forbidden button "${text}"`);
    }
  }
}

/**
 * Waits for a condition function to return truthy, polling every 200ms.
 * Rejects after `timeoutMs`.
 * @param {() => boolean} conditionFn
 * @param {number} timeoutMs
 * @param {string} label - for error messages
 * @returns {Promise<void>}
 */
function waitFor(conditionFn, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const interval = setInterval(() => {
      if (conditionFn()) {
        clearInterval(interval);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        reject(new Error(`[ReFlow] Timeout waiting for: ${label}`));
      }
    }, 200);
  });
}

/**
 * Waits until shipping line rows are present in the DOM.
 * @param {Object} agentConfig
 * @returns {Promise<void>}
 */
function waitForShippingLines(agentConfig) {
  return waitFor(
    () => document.querySelectorAll(agentConfig.selectors.shippingLineRows).length > 0,
    SHIPPING_PAGE_TIMEOUT_MS,
    "shipping line table"
  );
}

/**
 * Waits until the warehouse item containers are back in the DOM.
 * @param {Object} agentConfig
 * @returns {Promise<void>}
 */
function waitForWarehouse(agentConfig) {
  return waitFor(
    () => document.querySelectorAll(agentConfig.selectors.itemContainer).length > 0,
    WAREHOUSE_RELOAD_TIMEOUT_MS,
    "warehouse item list"
  );
}

/**
 * Pauses execution.
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Core simulation steps ─────────────────────────────────────────────────────

/**
 * Deselects all item checkboxes on the warehouse page.
 * @param {Object} agentConfig
 */
function deselectAll(agentConfig) {
  const selectAll = document.querySelector(agentConfig.selectors.selectAllCheckbox);
  if (selectAll && selectAll.checked) {
    safeClick(selectAll);
  }
  // Also explicitly uncheck each item checkbox to be safe
  document.querySelectorAll(agentConfig.selectors.itemCheckbox).forEach((cb) => {
    if (cb.checked) safeClick(cb);
  });
}

/**
 * Selects only the checkboxes for the given items.
 * @param {import('./types').WarehouseItem[]} items
 */
function selectItems(items) {
  for (const item of items) {
    if (item.checkboxRef && !item.checkboxRef.checked) {
      safeClick(item.checkboxRef);
    }
  }
}

/**
 * Reads all shipping lines from the current (shipping selection) page.
 * @param {Object} agentConfig
 * @returns {import('./types').ShippingLine[]}
 */
function readShippingLines(agentConfig) {
  const { selectors, parsers } = agentConfig;
  const rows = document.querySelectorAll(selectors.shippingLineRows);
  const lines = [];

  rows.forEach((row) => {
    const nameEl  = row.querySelector(selectors.shippingLineName);
    const priceEl = row.querySelector(selectors.shippingLinePrice);
    const daysEl  = row.querySelector(selectors.shippingLineDays);

    if (!nameEl || !priceEl) return;

    const name  = nameEl.textContent.trim();
    const price = parsers.price(priceEl.textContent.trim());
    const days  = daysEl ? daysEl.textContent.trim() : "N/A";

    if (!name || price <= 0) return;

    lines.push({
      name,
      price,
      currency: "USD",
      estimatedDays: days,
      features: [],
    });
  });

  return lines;
}

/**
 * Navigates back to the warehouse page.
 * Tries history.back() first; falls back to a Cancel / Back button.
 * @param {Object} agentConfig
 * @returns {Promise<void>}
 */
async function navigateBack(agentConfig) {
  // Try to find a cancel/back button before using history.back
  const allButtons = Array.from(document.querySelectorAll("button, a, div[role='button']"));
  const backBtn = allButtons.find((el) => {
    const t = (el.textContent || "").trim().toLowerCase();
    return t === "cancel" || t === "back" || t === "返回";
  });

  if (backBtn) {
    assertNotForbidden(backBtn, agentConfig.selectors.FORBIDDEN_BUTTON_TEXTS);
    safeClick(backBtn);
  } else {
    window.history.back();
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Simulates one parcel candidate: for each item group, selects items,
 * submits, reads shipping lines, and navigates back.
 *
 * @param {import('./types').ParcelCandidate} candidate
 * @param {Object} agentConfig
 * @param {{ cancelled: boolean }} cancelToken
 * @returns {Promise<import('./types').SimulationResult>}
 */
async function simulateCandidate(candidate, agentConfig, cancelToken) {
  const groupResults = [];

  for (const items of candidate.itemGroups) {
    if (cancelToken.cancelled) {
      return { candidate, groups: groupResults, totalPrice: 0, skipped: true };
    }

    try {
      // 1. Deselect everything
      deselectAll(agentConfig);

      // 2. Select only this group's items
      selectItems(items);

      // 3. Click the submit / create-parcel button
      const submitBtn = document.querySelector(agentConfig.selectors.submitButton);
      if (!submitBtn) throw new Error("[ReFlow] Submit button not found");
      assertNotForbidden(submitBtn, agentConfig.selectors.FORBIDDEN_BUTTON_TEXTS);
      safeClick(submitBtn);

      // 4. Wait for shipping lines to load
      await waitForShippingLines(agentConfig);

      // 5. Read all shipping lines
      const allLines = readShippingLines(agentConfig);
      if (allLines.length === 0) throw new Error("[ReFlow] No shipping lines found after submit");

      const cheapestLine = allLines.reduce((best, l) => (l.price < best.price ? l : best));
      groupResults.push({ items, cheapestLine, allLines });

      // 6. Navigate back to warehouse
      await navigateBack(agentConfig);
      await waitForWarehouse(agentConfig);

    } catch (err) {
      console.warn("[ReFlow] Simulation error for group:", err.message);
      // Try to get back to warehouse even on error
      try {
        window.history.back();
        await waitForWarehouse(agentConfig);
      } catch (_) {
        // Best effort
      }
      return { candidate, groups: groupResults, totalPrice: 0, skipped: true };
    }

    // Rate limiting: pause between groups
    await sleep(SIMULATION_PAUSE_MS);
  }

  const totalPrice = groupResults.reduce((sum, g) => sum + (g.cheapestLine?.price || 0), 0);

  return { candidate, groups: groupResults, totalPrice, skipped: false };
}

if (typeof module !== "undefined") module.exports = { simulateCandidate };

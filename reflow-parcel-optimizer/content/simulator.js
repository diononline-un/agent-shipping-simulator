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

const SIMULATION_PAUSE_MS        = 2000;
const SHIPPING_PAGE_TIMEOUT_MS   = 15000;
const WAREHOUSE_RELOAD_TIMEOUT_MS = 10000;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Finds the element that should actually be clicked to toggle a Vue checkbox.
 *
 * Vue UI frameworks (Element Plus, Ant Design Vue, Vant, etc.) typically render
 * the <input type="checkbox"> as a hidden/opacity:0 element. The user-visible
 * element (a <span> or <label>) carries the click handler.
 * Clicking the hidden input directly sets .checked but Vue's virtual-DOM
 * reconciler immediately resets it to match the reactive state.
 *
 * Strategy (first match wins):
 *  1. Element Plus/UI: .el-checkbox__inner (the visual square)
 *  2. Closest <label> ancestor
 *  3. Parent element that is not a table cell / body
 *  4. The input itself (fallback)
 *
 * @param {HTMLInputElement} inputEl
 * @returns {Element}
 */
function findClickTarget(inputEl) {
  // Element Plus / Element UI
  const elInner = inputEl.closest(".el-checkbox__input, .el-checkbox")
    ?.querySelector(".el-checkbox__inner");
  if (elInner) return elInner;

  // Any wrapping <label>
  const label = inputEl.closest("label");
  if (label) return label;

  // Immediate parent span/div (most custom checkbox patterns)
  const parent = inputEl.parentElement;
  const skipTags = new Set(["BODY", "FORM", "TABLE", "TBODY", "TR", "TD", "TH"]);
  if (parent && !skipTags.has(parent.tagName)) return parent;

  return inputEl; // last resort
}

/**
 * Toggles a Vue-managed checkbox by clicking the correct visual element.
 * Does NOT rely on .checked property afterwards — Vue reconciles asynchronously.
 * @param {HTMLInputElement} inputEl
 * @param {boolean} targetChecked
 */
function setCheckbox(inputEl, targetChecked) {
  // Only click if current DOM state differs from desired state
  if (inputEl.checked === targetChecked) return;

  const target = findClickTarget(inputEl);
  // Primary: click the visual element Vue's handler is attached to
  target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

  // Belt-and-suspenders: also set property + fire framework events on the input
  inputEl.checked = targetChecked;
  inputEl.dispatchEvent(new Event("change", { bubbles: true }));
  inputEl.dispatchEvent(new Event("input",  { bubbles: true }));
}

/**
 * Fires a synthetic click on a non-checkbox element.
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
 * Waits for a condition function to return truthy, polling every 250ms.
 * @param {() => boolean} conditionFn
 * @param {number} timeoutMs
 * @param {string} label
 * @returns {Promise<void>}
 */
function waitFor(conditionFn, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    if (conditionFn()) { resolve(); return; }
    const start    = Date.now();
    const interval = setInterval(() => {
      if (conditionFn()) {
        clearInterval(interval);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        reject(new Error(`[ReFlow] Timeout waiting for: ${label}`));
      }
    }, 250);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Dialog / error handling ───────────────────────────────────────────────────

/**
 * Detects common modal dialogs / error toasts and dismisses them.
 * Handles GTBuy's "Select items for pickup" error and Element-UI dialogs.
 * @returns {boolean} true if something was dismissed
 */
function dismissAnyDialog() {
  // Element-UI dialog close button
  const elClose = document.querySelector(".el-dialog__headerbtn, .el-message-box__headerbtn");
  if (elClose) { safeClick(elClose); return true; }

  // Generic close buttons / overlays
  const closeTexts = ["×", "✕", "✗", "Close", "Cancel", "OK", "确定"];
  const allBtns = Array.from(
    document.querySelectorAll("button, span[class*='close'], div[class*='close'], i[class*='close']")
  );
  for (const btn of allBtns) {
    if (closeTexts.includes(btn.textContent.trim())) {
      safeClick(btn);
      return true;
    }
  }

  // GTBuy "Select items for pickup" modal — look for ✕ in modal header
  const modalX = document.querySelector(
    ".modal .close, .dialog .close, [class*='modal'] button, [class*='dialog'] button"
  );
  if (modalX) { safeClick(modalX); return true; }

  return false;
}

/**
 * Returns true if a "please select items" error is currently visible.
 */
function isSelectItemsErrorVisible() {
  const body = document.body.textContent || "";
  return (
    body.includes("Select items for pickup") ||
    body.includes("请选择") ||
    body.includes("Please select")
  );
}

// ── Submit button finder ──────────────────────────────────────────────────────

/**
 * Finds the "Create Parcel" / "Submit for Delivery" button robustly.
 * Tries configured selector first, then falls back to text matching.
 * @param {Object} agentConfig
 * @returns {Element|null}
 */
function findSubmitButton(agentConfig) {
  // Try configured CSS selector
  const bySel = document.querySelector(agentConfig.selectors.submitButton);
  if (bySel) return bySel;

  // Fallback: search by button text
  const texts = ["Create Parcel", "Create Package", "Submit for Delivery", "Submit Parcel Request"];
  const candidates = Array.from(
    document.querySelectorAll("button, a, div[class*='btn'], div[class*='bor'], span[class*='btn']")
  );
  for (const text of texts) {
    const found = candidates.find(
      (el) => el.textContent.trim().toLowerCase() === text.toLowerCase()
    );
    if (found) return found;
  }
  return null;
}

// ── Shipping lines reader ─────────────────────────────────────────────────────

/**
 * Returns true when the shipping lines table is present AND has rows.
 */
function shippingLinesPresent(agentConfig) {
  return document.querySelectorAll(agentConfig.selectors.shippingLineRows).length > 0;
}

/**
 * Reads all shipping lines from the current page.
 * @param {Object} agentConfig
 * @returns {import('./types').ShippingLine[]}
 */
function readShippingLines(agentConfig) {
  const { selectors, parsers } = agentConfig;
  const rows  = document.querySelectorAll(selectors.shippingLineRows);
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

    lines.push({ name, price, currency: "USD", estimatedDays: days, features: [] });
  });

  return lines;
}

// ── Warehouse wait ────────────────────────────────────────────────────────────

function warehousePresent(agentConfig) {
  return document.querySelectorAll(agentConfig.selectors.itemContainer).length > 0;
}

async function navigateBack(agentConfig) {
  // Look for explicit Back/Cancel link first
  const allLinks = Array.from(document.querySelectorAll("button, a, span"));
  const backEl   = allLinks.find((el) => {
    const t = (el.textContent || "").trim().toLowerCase();
    return t === "back" || t === "cancel" || t === "返回" || t === "取消";
  });
  if (backEl) {
    assertNotForbidden(backEl, agentConfig.selectors.FORBIDDEN_BUTTON_TEXTS);
    safeClick(backEl);
  } else {
    window.history.back();
  }
}

// ── Checkbox selection ────────────────────────────────────────────────────────

/**
 * Deselects all checkboxes on the warehouse page using Vue-compatible events.
 * @param {Object} agentConfig
 */
async function deselectAll(agentConfig) {
  // Uncheck "Select All" if checked
  const selectAll = document.querySelector(agentConfig.selectors.selectAllCheckbox);
  if (selectAll && selectAll.checked) {
    setCheckbox(selectAll, false);
    await sleep(300);
  }

  // Uncheck each item checkbox
  document.querySelectorAll(agentConfig.selectors.itemCheckbox).forEach((cb) => {
    if (cb.checked) setCheckbox(cb, false);
  });

  await sleep(300);
}

/**
 * Selects only the given items' checkboxes.
 * @param {import('./types').WarehouseItem[]} items
 */
async function selectItems(items) {
  for (const item of items) {
    if (item.checkboxRef && !item.checkboxRef.checked) {
      setCheckbox(item.checkboxRef, true);
      await sleep(80); // small gap between selections
    }
  }
  await sleep(400); // let Vue re-render
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Simulates one parcel candidate.
 *
 * @param {import('./types').ParcelCandidate} candidate
 * @param {Object}   agentConfig
 * @param {{ cancelled: boolean }} cancelToken
 * @param {Function} [onLog] - (level: 'info'|'warn'|'error', message: string) => void
 * @returns {Promise<import('./types').SimulationResult>}
 */
async function simulateCandidate(candidate, agentConfig, cancelToken, onLog) {
  const log  = onLog || (() => {});
  const groupResults = [];

  for (const items of candidate.itemGroups) {
    if (cancelToken.cancelled) {
      return { candidate, groups: groupResults, totalPrice: 0, skipped: true };
    }

    try {
      // 0. Re-scrape to refresh stale checkboxRefs after any prior navigation.
      //    Vue recreates DOM elements on re-render; stored refs become detached.
      if (typeof scrapeItems === "function") {
        try {
          const { items: fresh } = scrapeItems(agentConfig);
          if (fresh.length > 0) {
            const idToRef = new Map(fresh.map((i) => [i.id, i.checkboxRef]));
            let refreshed = 0;
            items.forEach((item) => {
              const ref = idToRef.get(item.id);
              if (ref) { item.checkboxRef = ref; refreshed++; }
            });
            log("info", `   DOM-Refs aufgefrischt: ${refreshed}/${items.length}`);
          }
        } catch (_) { /* scraper errors are non-fatal here */ }
      }

      // 1. Deselect everything
      log("info", `   Deselektiere alle Checkboxen...`);
      await deselectAll(agentConfig);

      // 2. Select this group's items
      log("info", `   Selektiere ${items.length} Item(s): ${items.map(i => i.name.slice(0,20)).join(", ")}`);
      await selectItems(items);

      // Verify at least one checkbox is now checked before proceeding
      const checkedCount = items.filter(i => i.checkboxRef && i.checkboxRef.checked).length;
      log(checkedCount > 0 ? "info" : "error",
        `   Checkbox-Check: ${checkedCount}/${items.length} als checked erkannt`);

      if (checkedCount === 0) {
        log("warn", `   0/${items.length} DOM-checked nach Klick (Vue-managed state — versuche Submit trotzdem)`);
      }

      // 3. Find and click the submit button
      const submitBtn = findSubmitButton(agentConfig);
      log(submitBtn ? "info" : "error",
        `   Submit-Button: ${submitBtn ? `gefunden (text: "${submitBtn.textContent.trim().slice(0,30)}")` : "NICHT gefunden"}`);
      if (!submitBtn) throw new Error("Submit-Button nicht gefunden");
      assertNotForbidden(submitBtn, agentConfig.selectors.FORBIDDEN_BUTTON_TEXTS);
      safeClick(submitBtn);
      log("info", `   Submit-Button geklickt, warte auf Seite...`);

      // 4. Short wait, then check for "select items" error dialog
      await sleep(800);
      if (isSelectItemsErrorVisible()) {
        log("error", `   GTBuy-Dialog: "Select items for pickup" erschienen — Checkbox-Selektion nicht erkannt`);
        dismissAnyDialog();
        await sleep(500);
        throw new Error(`GTBuy zeigt "Select items for pickup"`);
      }

      // 5. Wait for shipping lines
      log("info", `   Warte auf Shipping-Lines (Selector: "${agentConfig.selectors.shippingLineRows}")...`);
      await waitFor(
        () => shippingLinesPresent(agentConfig),
        SHIPPING_PAGE_TIMEOUT_MS,
        "shipping line table"
      );
      const rowCount = document.querySelectorAll(agentConfig.selectors.shippingLineRows).length;
      log("info", `   Shipping-Lines geladen: ${rowCount} Zeile(n) gefunden`);

      // 6. Read shipping lines
      const allLines = readShippingLines(agentConfig);
      log(allLines.length > 0 ? "info" : "error",
        `   Shipping Lines geparst: ${allLines.length} (${allLines.map(l => `${l.name} $${l.price}`).slice(0,3).join(", ")})`);
      if (allLines.length === 0) {
        // Snapshot what's actually on the page for debugging
        const pageSnippet = document.body.textContent.slice(0, 300).replace(/\s+/g, " ");
        log("warn", `   Seiten-Inhalt (erste 300 Zeichen): ${pageSnippet}`);
        throw new Error("Keine Shipping Lines gefunden");
      }

      const cheapestLine = allLines.reduce((best, l) => (l.price < best.price ? l : best));
      log("info", `   Günstigste Line: ${cheapestLine.name} — $${cheapestLine.price}`);
      groupResults.push({ items, cheapestLine, allLines });

      // 7. Navigate back
      log("info", `   Navigiere zurück zum Warehouse...`);
      await navigateBack(agentConfig);
      await waitFor(() => warehousePresent(agentConfig), WAREHOUSE_RELOAD_TIMEOUT_MS, "warehouse");
      log("info", `   Warehouse wieder sichtbar ✓`);

    } catch (err) {
      log("error", `   Fehler: ${err.message}`);
      console.warn("[ReFlow] Simulation error:", err.message);
      dismissAnyDialog();
      try {
        window.history.back();
        await waitFor(() => warehousePresent(agentConfig), WAREHOUSE_RELOAD_TIMEOUT_MS, "warehouse recovery");
        log("info", `   Warehouse nach Fehler wiederhergestellt`);
      } catch (_) {
        log("error", `   Warehouse-Recovery fehlgeschlagen`);
      }

      return { candidate, groups: groupResults, totalPrice: 0, skipped: true };
    }

    await sleep(SIMULATION_PAUSE_MS);
  }

  const totalPrice = groupResults.reduce((sum, g) => sum + (g.cheapestLine?.price || 0), 0);
  return { candidate, groups: groupResults, totalPrice, skipped: false };
}

if (typeof module !== "undefined") module.exports = { simulateCandidate };

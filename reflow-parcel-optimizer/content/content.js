/**
 * ReFlow Parcel Optimizer — Content Script
 *
 * Entry point injected into agent websites.
 * - Detects agent and warehouse page
 * - Scrapes items and reports badge count
 * - Handles messages from the Popup / Background
 * - Runs optimization and manages the result overlay
 */

// ── Load modules (all files are injected in order; in-extension they share scope)
// In the extension context these are loaded via manifest content_scripts.
// Order in manifest: agents/gtbuy.js → types.js → scraper.js → simulator.js → optimizer.js → content.js

/* globals gtbuyConfig, scrapeItems, simulateCandidate, runOptimization */

// ── Agent detection ───────────────────────────────────────────────────────────

const SUPPORTED_AGENTS = [
  typeof gtbuyConfig !== "undefined" ? gtbuyConfig : null,
].filter(Boolean);

function detectAgent() {
  const url = window.location.href;
  return SUPPORTED_AGENTS.find((cfg) => cfg.urlPattern.test(url)) || null;
}

// ── State ─────────────────────────────────────────────────────────────────────

let activeAgent    = null;
let cachedItems    = [];
let cancelToken    = { cancelled: false };

// ── Initialization ────────────────────────────────────────────────────────────

function init() {
  activeAgent = detectAgent();
  if (!activeAgent) return;

  if (activeAgent.isWarehousePage(window.location.href)) {
    refreshItems();
  }

  // Re-scrape when the URL changes (SPA navigation)
  let lastUrl = window.location.href;
  const observer = new MutationObserver(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      if (activeAgent.isWarehousePage(lastUrl)) {
        setTimeout(refreshItems, 800); // brief delay for SPA render
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Apply a pending split if one was stored (from "Open in Tab" flow)
  chrome.storage.session.get("reflow_split").then((data) => {
    if (data.reflow_split && activeAgent.isWarehousePage(window.location.href)) {
      setTimeout(() => applySplit(data.reflow_split), 1200);
      chrome.storage.session.remove("reflow_split");
    }
  });
}

function refreshItems() {
  const { items, error } = scrapeItems(activeAgent);
  cachedItems = items;
  if (error) console.warn(error);
  chrome.runtime.sendMessage({ type: "ITEMS_DETECTED", count: items.length });
}

// ── Message handlers ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case "GET_ITEMS": {
      refreshItems();
      sendResponse({ items: serializeItems(cachedItems) });
      break;
    }

    case "START_OPTIMIZATION": {
      const selectedIds = new Set(message.selectedItemIds || cachedItems.map((i) => i.id));
      const selectedItems = cachedItems.filter((i) => selectedIds.has(i.id));

      if (selectedItems.length === 0) {
        sendResponse({ error: "No items selected" });
        break;
      }

      cancelToken = { cancelled: false };

      runOptimization(
        selectedItems,
        activeAgent,
        simulateCandidate,
        (done, total, currentBest) => {
          chrome.runtime.sendMessage({
            type: "OPTIMIZATION_PROGRESS",
            done,
            total,
            currentBest,
          });
        },
        cancelToken,
        (level, message) => {
          chrome.runtime.sendMessage({
            type: "SIMULATION_LOG",
            level,   // "info" | "warn" | "error"
            message,
            ts: new Date().toLocaleTimeString("de-DE", { hour12: false }),
          });
        }
      ).then((result) => {
        showOverlay(result);
        sendResponse({ result: serializeOptimizationResult(result) });
      }).catch((err) => {
        sendResponse({ error: err.message });
      });

      return true; // Keep message channel open for async response
    }

    case "CANCEL_OPTIMIZATION": {
      cancelToken.cancelled = true;
      removeOverlay();
      sendResponse({ ok: true });
      break;
    }

    case "APPLY_SPLIT": {
      applySplit(message.itemGroups);
      sendResponse({ ok: true });
      break;
    }

    default:
      break;
  }
});

// ── Split application ─────────────────────────────────────────────────────────

/**
 * Sets checkboxes in the DOM for the first group in itemGroups.
 * (User then manually submits the first parcel.)
 * @param {string[][]} itemGroups - Arrays of item IDs
 */
function applySplit(itemGroups) {
  if (!itemGroups || itemGroups.length === 0) return;

  // Deselect all first
  const selectAll = document.querySelector(activeAgent.selectors.selectAllCheckbox);
  if (selectAll && selectAll.checked) {
    selectAll.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }
  document.querySelectorAll(activeAgent.selectors.itemCheckbox).forEach((cb) => {
    if (cb.checked) cb.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });

  // Select first group's items
  const firstGroupIds = new Set(itemGroups[0]);
  cachedItems.forEach((item) => {
    if (firstGroupIds.has(item.id) && item.checkboxRef && !item.checkboxRef.checked) {
      item.checkboxRef.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
  });
}

// ── Overlay ───────────────────────────────────────────────────────────────────

function removeOverlay() {
  const existing = document.getElementById("reflow-overlay");
  if (existing) existing.remove();
}

/**
 * Injects the result overlay into the page.
 * @param {import('./types').OptimizationResult} result
 */
function showOverlay(result) {
  removeOverlay();
  if (!result || result.topThree.length === 0) return;

  const best = result.topThree[0];
  const savingsText = result.savings > 0
    ? `<span class="reflow-savings">Spare $${result.savings.toFixed(2)} vs. 1 Paket</span>`
    : "";

  const groupsHtml = best.groups.map((g, idx) => `
    <div class="reflow-parcel-group">
      <div class="reflow-parcel-title">Paket ${idx + 1} — ${g.cheapestLine.name}</div>
      <div class="reflow-parcel-price">$${g.cheapestLine.price.toFixed(2)} · ${g.cheapestLine.estimatedDays} Tage</div>
      <div class="reflow-parcel-items">${g.items.map((i) => i.name).join(", ")}</div>
    </div>
  `).join("");

  const altOptionsHtml = result.topThree.slice(1).map((r, idx) => `
    <div class="reflow-alt-option">
      <span class="reflow-alt-label">Option ${idx + 2}: ${r.candidate.label}</span>
      <span class="reflow-alt-price">$${r.totalPrice.toFixed(2)}</span>
    </div>
  `).join("");

  const overlay = document.createElement("div");
  overlay.id = "reflow-overlay";
  overlay.innerHTML = `
    <div class="reflow-overlay-inner">
      <button class="reflow-close" id="reflow-close-btn" title="Schließen">✕</button>
      <div class="reflow-header">
        <span class="reflow-logo">⚡ ReFlow</span>
        <span class="reflow-title">Beste Paket-Aufteilung</span>
      </div>
      <div class="reflow-best-option">
        <div class="reflow-total-price">Gesamt: $${best.totalPrice.toFixed(2)} ${savingsText}</div>
        ${groupsHtml}
      </div>
      ${altOptionsHtml ? `<div class="reflow-alternatives"><strong>Weitere Optionen:</strong>${altOptionsHtml}</div>` : ""}
      <div class="reflow-actions">
        <button class="reflow-btn-primary" id="reflow-apply-btn">✓ Split übernehmen (Paket 1 vorwählen)</button>
        <button class="reflow-btn-secondary" id="reflow-tab-btn">In neuem Tab öffnen →</button>
      </div>
      <div class="reflow-footer">
        Powered by <a href="https://reflow.com" target="_blank" rel="noopener">ReFlow</a>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  document.getElementById("reflow-close-btn").addEventListener("click", removeOverlay);

  document.getElementById("reflow-apply-btn").addEventListener("click", () => {
    applySplit(best.groups.map((g) => g.items.map((i) => i.id)));
    removeOverlay();
  });

  document.getElementById("reflow-tab-btn").addEventListener("click", () => {
    chrome.runtime.sendMessage({
      type: "OPEN_IN_TAB",
      itemGroups: best.groups.map((g) => g.items.map((i) => i.id)),
    });
  });
}

// ── Serialization (DOM elements can't cross message boundary) ─────────────────

function serializeItems(items) {
  return items.map(({ id, name, weight, dimensions, quantity, category }) => ({
    id, name, weight, dimensions, quantity, category,
  }));
}

function serializeOptimizationResult(result) {
  const serializeGroup = (g) => ({
    items: serializeItems(g.items),
    cheapestLine: g.cheapestLine,
    allLines: g.allLines,
  });

  const serializeResult = (r) => ({
    candidate: { label: r.candidate.label },
    groups: r.groups.map(serializeGroup),
    totalPrice: r.totalPrice,
    skipped: r.skipped || false,
  });

  return {
    baseline: result.baseline ? serializeResult(result.baseline) : null,
    topThree: result.topThree.map(serializeResult),
    savings: result.savings,
  };
}

// ── Boot ──────────────────────────────────────────────────────────────────────

init();

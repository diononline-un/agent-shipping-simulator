/**
 * ReFlow Parcel Optimizer — Content Script
 *
 * Two operating modes:
 *
 * A) Normal mode (warehouse tab the user has open):
 *    - Detects agent and warehouse page
 *    - Scrapes items and updates badge
 *    - Handles GET_ITEMS / START_OPTIMIZATION / CANCEL_OPTIMIZATION messages
 *    - START_OPTIMIZATION generates candidates and delegates to background
 *      which opens task tabs (tab-based parallel simulation)
 *
 * B) Task tab mode (background-opened tabs):
 *    - On load, asks background for its assigned candidate via GET_TAB_TASK
 *    - Scrapes items, builds DOM-ref candidate, calls simulateCandidate
 *    - Reports CANDIDATE_DONE / CANDIDATE_SKIP back to background
 *    - Background closes the tab when done
 */

/* globals gtbuyConfig, scrapeItems, simulateCandidate, generateCandidates,
           waitFor, warehousePresent, WAREHOUSE_RELOAD_TIMEOUT_MS */

// ── Agent detection ───────────────────────────────────────────────────────────

const SUPPORTED_AGENTS = [
  typeof gtbuyConfig !== "undefined" ? gtbuyConfig : null,
].filter(Boolean);

function detectAgent() {
  const url = window.location.href;
  return SUPPORTED_AGENTS.find((cfg) => cfg.urlPattern.test(url)) || null;
}

// ── State ─────────────────────────────────────────────────────────────────────

let activeAgent  = null;
let cachedItems  = [];
let cancelToken  = { cancelled: false };
let isTaskTab    = false; // true when running as a background task tab

// ── Helpers ───────────────────────────────────────────────────────────────────

function sendLog(level, message, candidateIndex) {
  const prefix = candidateIndex != null ? `[K${candidateIndex + 1}] ` : "";
  chrome.runtime.sendMessage({
    type:    "SIMULATION_LOG",
    level,
    message: prefix + message,
    ts:      new Date().toLocaleTimeString("de-DE", { hour12: false }),
  }).catch(() => {});
}

// ── Initialization ────────────────────────────────────────────────────────────

function init() {
  activeAgent = detectAgent();
  if (!activeAgent) return;

  // Check whether this tab was opened by the optimizer (task tab mode)
  checkForTabTask();

  if (activeAgent.isWarehousePage(window.location.href)) {
    refreshItems();
    // Check if this tab was opened by "In Tab öffnen" and has a group to pre-select
    checkForSplitTask();
  }

  // Re-scrape when SPA navigates back to warehouse
  let lastUrl = window.location.href;
  const observer = new MutationObserver(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      if (!isTaskTab && activeAgent.isWarehousePage(lastUrl)) {
        setTimeout(refreshItems, 800);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

function refreshItems() {
  const { items, error } = scrapeItems(activeAgent);
  cachedItems = items;
  if (error) console.warn(error);
  chrome.runtime.sendMessage({ type: "ITEMS_DETECTED", count: items.length });
}

// ── Split task mode (tabs opened via "In Tab öffnen") ────────────────────────

/**
 * Asks the background if this tab has an assigned item group to pre-select.
 * Called once per warehouse page load.  If the tab was opened by "In Tab öffnen"
 * the background returns the relevant item IDs; otherwise returns null immediately.
 */
async function checkForSplitTask() {
  const response = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_SPLIT_TASK" }, (r) => resolve(r || {}));
  });

  if (!response.itemIds || response.itemIds.length === 0) return;

  // Wait for Vue warehouse to be fully ready before clicking checkboxes
  try {
    await waitFor(() => warehousePresent(activeAgent), WAREHOUSE_RELOAD_TIMEOUT_MS, "warehouse for split");
    await new Promise((r) => setTimeout(r, 1500));
  } catch (_) { /* proceed anyway — applySplit will attempt with whatever is in the DOM */ }

  applySplit([response.itemIds]);
}

// ── Tab task mode ─────────────────────────────────────────────────────────────

/**
 * Asks the background service worker if this tab has an assigned candidate.
 * If so, runs the simulation and reports back.
 * Retries briefly to handle the race between tab creation and task registration.
 */
async function checkForTabTask() {
  // Retry up to 5 times (2.5 s total) in case the tab loads before the
  // background has registered the task for this tab ID.
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "GET_TAB_TASK" }, (r) =>
        resolve(r || {})
      );
    });

    if (response.task) {
      isTaskTab = true;
      await runTabTask(response.task);
      return;
    }

    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * Runs the candidate simulation assigned to this tab.
 * Leverages simulateCandidate from simulator.js which handles all steps:
 *   deselect → select → submit → wait for prices → navigate back.
 *
 * @param {{ candidateIndex:number, label:string, itemGroupIds:string[][] }} task
 */
async function runTabTask(task) {
  const cfg = activeAgent;
  const log = (level, msg) => sendLog(level, msg, task.candidateIndex);

  try {
    // Wait for warehouse to be fully ready (Vue initialized)
    await waitFor(() => warehousePresent(cfg), WAREHOUSE_RELOAD_TIMEOUT_MS, "warehouse init");
    await new Promise((r) => setTimeout(r, 1500)); // extra settle time for Vue

    // Scrape for fresh DOM refs
    const { items: freshItems } = scrapeItems(cfg);
    const idToItem = new Map(freshItems.map((i) => [i.id, i]));

    // Build a proper candidate object with live checkboxRefs
    const candidate = {
      label:      task.label,
      itemGroups: task.itemGroupIds.map((ids) =>
        ids.map((id) => idToItem.get(id)).filter(Boolean)
      ),
    };

    const totalExpected = task.itemGroupIds.reduce((s, g) => s + g.length, 0);
    const totalFound    = candidate.itemGroups.reduce((s, g) => s + g.length, 0);
    if (totalFound < totalExpected) {
      log("warn", `${totalExpected - totalFound} Items nicht im Scrape gefunden (${totalFound}/${totalExpected})`);
    }

    const taskCancelToken = { cancelled: false };

    // simulateCandidate handles all groups sequentially (deselect/select/submit/read/back)
    const result = await simulateCandidate(candidate, cfg, taskCancelToken, log);

    if (result.skipped) {
      chrome.runtime.sendMessage({
        type:           "CANDIDATE_SKIP",
        candidateIndex: task.candidateIndex,
        label:          task.label,
      }).catch(() => {});
    } else {
      chrome.runtime.sendMessage({
        type:           "CANDIDATE_DONE",
        candidateIndex: task.candidateIndex,
        label:          task.label,
        totalPrice:     result.totalPrice,
        // Strip DOM refs — only IDs + shipping data cross the message boundary
        groups: result.groups.map((g) => ({
          itemIds:      (g.items || []).map((i) => i.id),
          cheapestLine: g.cheapestLine,
          allLines:     g.allLines,
        })),
      }).catch(() => {});
    }

  } catch (err) {
    log("error", `Unerwarteter Fehler im Task-Tab: ${err.message}`);
    chrome.runtime.sendMessage({
      type:           "CANDIDATE_SKIP",
      candidateIndex: task.candidateIndex,
      label:          task.label,
    }).catch(() => {});
  }
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
      const selectedIds   = new Set(message.selectedItemIds || cachedItems.map((i) => i.id));
      const selectedItems = cachedItems.filter((i) => selectedIds.has(i.id));

      if (selectedItems.length === 0) {
        sendResponse({ error: "No items selected" });
        break;
      }

      cancelToken = { cancelled: false };

      // Generate candidates (uses only id/weight — no DOM refs needed here)
      const candidates = generateCandidates(selectedItems, { maxPackages: message.maxPackages || 2 });

      // Serialize for the background (strip checkboxRef DOM elements)
      const serialized = candidates.map((c, i) => ({
        candidateIndex:   i,
        label:            c.label,
        itemGroupIds:     c.itemGroups.map((g) => g.map((item) => item.id)),
        // Item names travel alongside IDs so results can be enriched later
        itemGroupDetails: c.itemGroups.map((g) =>
          g.map((item) => ({ id: item.id, name: item.name }))
        ),
      }));

      // Delegate to background — it opens the task tabs and coordinates results
      chrome.runtime.sendMessage({ type: "START_TAB_OPTIMIZATION", candidates: serialized })
        .catch(() => {});

      // Respond immediately; actual results arrive via OPTIMIZATION_COMPLETE
      sendResponse({ ok: true });
      break;
    }

    case "CANCEL_OPTIMIZATION": {
      cancelToken.cancelled = true;
      chrome.runtime.sendMessage({ type: "CANCEL_TAB_OPTIMIZATION" }).catch(() => {});
      removeOverlay();
      sendResponse({ ok: true });
      break;
    }

    case "APPLY_SPLIT": {
      applySplit(message.itemGroups);
      sendResponse({ ok: true });
      break;
    }

    case "OPTIMIZATION_COMPLETE": {
      // Show the result overlay on the warehouse page the user has open
      if (!isTaskTab) showOverlay(message.result);
      break;
    }

    default:
      break;
  }
});

// ── Split application ─────────────────────────────────────────────────────────

/**
 * Pre-selects the first parcel group's items in the warehouse DOM.
 * Refreshes DOM refs first to avoid clicking on Vue-detached elements.
 * @param {string[][]} itemGroups  - Arrays of item IDs
 */
function applySplit(itemGroups) {
  if (!itemGroups || itemGroups.length === 0) return;

  // Re-scrape so we always have live checkboxRef elements (Vue may have re-rendered)
  refreshItems();

  // Deselect all
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
 * @param {{ topThree: object[], savings: number }} result
 */
function showOverlay(result) {
  removeOverlay();
  if (!result || !result.topThree || result.topThree.length === 0) return;

  const best        = result.topThree[0];
  const savingsText = result.savings > 0
    ? `<span class="reflow-savings">Spare $${result.savings.toFixed(2)} vs. 1 Paket</span>`
    : "";

  const groupsHtml = best.groups.map((g, idx) => `
    <div class="reflow-parcel-group">
      <div class="reflow-parcel-title">Paket ${idx + 1} — ${g.cheapestLine.name}</div>
      <div class="reflow-parcel-price">$${g.cheapestLine.price.toFixed(2)} · ${g.cheapestLine.estimatedDays} Tage</div>
      <div class="reflow-parcel-items">${(g.items || []).map((i) => i.name).join(", ")}</div>
    </div>
  `).join("");

  const altOptionsHtml = result.topThree.slice(1).map((r, idx) => `
    <div class="reflow-alt-option">
      <span class="reflow-alt-label">Option ${idx + 2}: ${r.candidate.label}</span>
      <span class="reflow-alt-price">$${r.totalPrice.toFixed(2)}</span>
    </div>
  `).join("");

  const overlay = document.createElement("div");
  overlay.id    = "reflow-overlay";
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
    applySplit(best.groups.map((g) => (g.items || []).map((i) => i.id)));
    removeOverlay();
  });

  document.getElementById("reflow-tab-btn").addEventListener("click", () => {
    chrome.runtime.sendMessage({
      type:       "OPEN_IN_TAB",
      itemGroups: best.groups.map((g) => (g.items || []).map((i) => i.id)),
    });
  });
}

// ── Serialization ─────────────────────────────────────────────────────────────

function serializeItems(items) {
  return items.map(({ id, name, weight, dimensions, quantity, category }) => ({
    id, name, weight, dimensions, quantity, category,
  }));
}

// ── Boot ──────────────────────────────────────────────────────────────────────

init();

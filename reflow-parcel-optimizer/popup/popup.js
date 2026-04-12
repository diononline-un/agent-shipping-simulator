/**
 * ReFlow Parcel Optimizer — Popup Logic
 *
 * Manages all UI states and communicates with the content script
 * via chrome.runtime.sendMessage (routed through the background service worker).
 */

// ── State machine ─────────────────────────────────────────────────────────────

const STATES = ["not-gtbuy", "no-warehouse", "no-items", "ready", "running", "results", "error"];

function showState(name) {
  STATES.forEach((s) => {
    const el = document.getElementById(`state-${s}`);
    if (el) el.classList.toggle("active", s === name);
  });
}

// ── DOM refs ──────────────────────────────────────────────────────────────────

const itemCountLabel      = document.getElementById("item-count-label");
const itemList            = document.getElementById("item-list");
const totalWeightDisplay  = document.getElementById("total-weight-display");
const startBtn            = document.getElementById("start-optimization-btn");
const selectAllBtn        = document.getElementById("select-all-btn");
const selectNoneBtn       = document.getElementById("select-none-btn");
const stopBtn             = document.getElementById("stop-btn");
const progressLabel       = document.getElementById("progress-label");
const progressBarFill     = document.getElementById("progress-bar-fill");
const progressSub         = document.getElementById("progress-sub");
const resultsList         = document.getElementById("results-list");
const savingsBadge        = document.getElementById("savings-badge");
const newOptimizationBtn  = document.getElementById("new-optimization-btn");
const errorMessage        = document.getElementById("error-message");
const retryBtn            = document.getElementById("retry-btn");
const retryItemsBtn       = document.getElementById("retry-items-btn");
const maxPackagesSelect   = document.getElementById("max-packages-select");
const durationEstimate    = document.getElementById("duration-estimate");
const exportCsvBtn        = document.getElementById("export-csv-btn");
const exportOrdersHint    = document.getElementById("export-orders-hint");

// ── App state ──────────────────────────────────────────────────────────────────

let allItems    = [];   // WarehouseItem[] (serialized, no DOM refs)
let selectedIds = new Set();
let currentMode = "standard"; // "fast" | "standard" | "thorough"

// ── Helpers ───────────────────────────────────────────────────────────────────

function sendToContent(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ error: chrome.runtime.lastError.message });
      } else {
        resolve(response || {});
      }
    });
  });
}

function formatWeight(grams) {
  return grams >= 1000 ? `${(grams / 1000).toFixed(2)} kg` : `${grams} g`;
}

// ── Duration estimate (mirrors optimizer.js MODE_PER_K logic) ────────────────

const MODE_PER_K_POPUP = { fast: 8, standard: 12, thorough: 20 };

function estimateCandidateCount(n, maxPackages, mode) {
  if (n === 0) return 0;
  if (n === 1) return 1;
  const perK     = MODE_PER_K_POPUP[mode] || 12;
  const k2Actual = n <= 18 ? Math.pow(2, n - 1) - 1 : 3000;
  const k2Count  = Math.min(perK, k2Actual);
  const k3Count  = maxPackages >= 3 && n >= 3 ? perK : 0;
  const k4Count  = maxPackages >= 4 && n >= 4 ? perK : 0;
  return 1 + k2Count + k3Count + k4Count;
}

function formatDuration(candidateCount) {
  const secs = candidateCount * 12; // SECONDS_PER_CANDIDATE
  if (secs < 90) return `~${Math.ceil(secs / 10) * 10} Sek.`;
  return `~${Math.ceil(secs / 60)} Min.`;
}

function updateDurationEstimate() {
  const n      = selectedIds.size;
  const maxPkg = parseInt(maxPackagesSelect.value) || 2;
  const count  = estimateCandidateCount(n, maxPkg, currentMode);
  durationEstimate.textContent = n > 0
    ? `${count} Kandidaten · ${formatDuration(count)}`
    : "";
}

// ── Item list rendering ───────────────────────────────────────────────────────

function renderItemList() {
  itemList.innerHTML = "";
  if (allItems.length === 0) {
    itemList.innerHTML = '<div style="padding:12px;text-align:center;color:#94a3b8">Keine Items gefunden</div>';
    return;
  }

  allItems.forEach((item) => {
    const row = document.createElement("div");
    row.className = "item-row" + (selectedIds.has(item.id) ? "" : " disabled");

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = selectedIds.has(item.id);
    cb.id = `cb-${item.id}`;

    const name = document.createElement("label");
    name.className = "item-name";
    name.htmlFor = `cb-${item.id}`;
    name.textContent = item.name;

    const meta = document.createElement("span");
    meta.className = "item-meta";
    meta.textContent = formatWeight(item.weight);

    row.appendChild(cb);
    row.appendChild(name);
    row.appendChild(meta);

    cb.addEventListener("change", () => {
      if (cb.checked) {
        selectedIds.add(item.id);
        row.classList.remove("disabled");
      } else {
        selectedIds.delete(item.id);
        row.classList.add("disabled");
      }
      updateWeightSummary();
      startBtn.disabled = selectedIds.size === 0;
    });

    itemList.appendChild(row);
  });
}

function updateWeightSummary() {
  const total = allItems
    .filter((i) => selectedIds.has(i.id))
    .reduce((sum, i) => sum + i.weight, 0);
  totalWeightDisplay.textContent = formatWeight(total);
  updateDurationEstimate();
}

// ── Debug panel ───────────────────────────────────────────────────────────────

const debugPanel    = document.getElementById("debug-panel");
const debugLog      = document.getElementById("debug-log");
const debugToggle   = document.getElementById("debug-toggle-btn");
const debugClearBtn = document.getElementById("debug-clear-btn");
const debugCopyBtn  = document.getElementById("debug-copy-btn");
let   debugVisible  = false;
const logLines      = []; // kept for copy-to-clipboard

function appendLog(level, message, ts) {
  const lvlClass = `debug-lvl-${level}`;
  const entry    = document.createElement("div");
  entry.className = "debug-entry";
  entry.innerHTML =
    `<span class="debug-ts">${ts}</span>` +
    `<span class="${lvlClass}">[${level.toUpperCase().slice(0,4)}]</span>` +
    `<span class="debug-msg">${escapeHtml(message)}</span>`;
  debugLog.appendChild(entry);
  debugLog.scrollTop = debugLog.scrollHeight;
  logLines.push(`${ts} [${level.toUpperCase()}] ${message}`);
}

function escapeHtml(str) {
  return str.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

debugToggle.addEventListener("click", (e) => {
  e.preventDefault();
  debugVisible = !debugVisible;
  debugPanel.style.display = debugVisible ? "block" : "none";
  debugToggle.textContent = debugVisible ? "🐛 Debug ▲" : "🐛 Debug";
});

debugClearBtn.addEventListener("click", () => {
  debugLog.innerHTML = "";
  logLines.length = 0;
});

debugCopyBtn.addEventListener("click", () => {
  navigator.clipboard.writeText(logLines.join("\n")).catch(() => {});
  debugCopyBtn.textContent = "Kopiert ✓";
  setTimeout(() => { debugCopyBtn.textContent = "Kopieren"; }, 2000);
});

// ── Progress + Log updates (from content script via background) ───────────────

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "OPTIMIZATION_PROGRESS") {
    const { done, total, currentBest } = message;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    progressBarFill.style.width = `${pct}%`;
    progressLabel.textContent = total > 0
      ? `Kombination ${done}/${total} wird getestet...`
      : "Starte Optimierung...";
    progressSub.textContent = currentBest
      ? `Aktuell bestes Ergebnis: $${currentBest.toFixed(2)}`
      : "Kombinationen werden getestet";
  }

  if (message.type === "OPTIMIZATION_COMPLETE") {
    renderResults(message.result);
  }

  if (message.type === "SIMULATION_LOG") {
    appendLog(message.level, message.message, message.ts);
    // Auto-open debug panel on errors so user sees problems immediately
    if (message.level === "error" && !debugVisible) {
      debugVisible = true;
      debugPanel.style.display = "block";
      debugToggle.textContent = "🐛 Debug ▲";
    }
  }
});

// ── Results rendering ─────────────────────────────────────────────────────────

function renderResults(result) {
  resultsList.innerHTML = "";

  if (!result || result.topThree.length === 0) {
    resultsList.innerHTML = '<p style="color:#94a3b8;text-align:center">Keine Ergebnisse verfügbar.</p>';
    showState("results");
    return;
  }

  if (result.savings > 0) {
    savingsBadge.textContent = `$${result.savings.toFixed(2)} gespart`;
    savingsBadge.style.display = "inline-block";
  } else {
    savingsBadge.style.display = "none";
  }

  const rankLabels = ["🥇 Beste Option", "🥈 Option 2", "🥉 Option 3"];

  result.topThree.forEach((r, idx) => {
    const card = document.createElement("div");
    card.className = "result-card" + (idx === 0 ? " best" : "");

    const groupsHtml = r.groups.map((g, gi) => {
      const itemNames = (g.items || []).map((i) => i.name).join(", ");
      return `<div class="result-group-row">
        <span class="result-group-label">Paket ${gi + 1}:</span>
        <span>${g.cheapestLine.name} · $${g.cheapestLine.price.toFixed(2)} · ${g.cheapestLine.estimatedDays} Tage</span>
      </div>
      <div class="result-group-row" style="padding-left:50px">
        <span style="color:#64748b">${itemNames}</span>
      </div>`;
    }).join("");

    card.innerHTML = `
      <div class="result-card-header">
        <span class="result-rank">${rankLabels[idx] || `Option ${idx + 1}`}</span>
        <span class="result-price">$${r.totalPrice.toFixed(2)}</span>
      </div>
      <div class="result-label">${r.candidate.label}</div>
      <div class="result-groups">${groupsHtml}</div>
      <div class="result-actions">
        <button class="btn-apply">✓ Übernehmen</button>
        <button class="btn-open-tab">In Tab öffnen →</button>
      </div>
    `;

    card.querySelector(".btn-apply").addEventListener("click", () => {
      const itemGroups = r.groups.map((g) => (g.items || []).map((i) => i.id));
      sendToContent({ type: "APPLY_SPLIT", itemGroups });
      window.close();
    });

    card.querySelector(".btn-open-tab").addEventListener("click", () => {
      const itemGroups = r.groups.map((g) => (g.items || []).map((i) => i.id));
      sendToContent({ type: "OPEN_IN_TAB", itemGroups });
    });

    resultsList.appendChild(card);
  });

  showState("results");
}

// ── Event wiring ──────────────────────────────────────────────────────────────

selectAllBtn.addEventListener("click", () => {
  selectedIds = new Set(allItems.map((i) => i.id));
  renderItemList();
  updateWeightSummary();
  startBtn.disabled = selectedIds.size === 0;
});

selectNoneBtn.addEventListener("click", () => {
  selectedIds.clear();
  renderItemList();
  updateWeightSummary();
  startBtn.disabled = true;
});

maxPackagesSelect.addEventListener("change", () => updateDurationEstimate());

// Mode toggle buttons
document.getElementById("opt-mode-group").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-mode]");
  if (!btn) return;
  currentMode = btn.dataset.mode;
  document.querySelectorAll(".opt-mode-btn").forEach((b) =>
    b.classList.toggle("active", b === btn)
  );
  updateDurationEstimate();
});

startBtn.addEventListener("click", async () => {
  const maxPackages = parseInt(maxPackagesSelect.value) || 2;

  showState("running");
  progressBarFill.style.width = "0%";
  progressLabel.textContent = "Starte Optimierung...";
  progressSub.textContent = "Kombinationen werden berechnet";

  const response = await sendToContent({
    type:            "START_OPTIMIZATION",
    selectedItemIds: Array.from(selectedIds),
    maxPackages,
    mode:            currentMode,
  });

  if (response.error) {
    errorMessage.textContent = response.error;
    showState("error");
    return;
  }

  // Tab-based flow: response is { ok: true }.
  // Results arrive asynchronously via OPTIMIZATION_COMPLETE message.
  // Legacy direct flow: response.result contains the full result.
  if (response.result) {
    renderResults(response.result);
  }
  // Otherwise stay in "running" state — OPTIMIZATION_COMPLETE will call renderResults.
});

stopBtn.addEventListener("click", async () => {
  await sendToContent({ type: "CANCEL_OPTIMIZATION" });
  showState("ready");
});

newOptimizationBtn.addEventListener("click", () => showState("ready"));

retryBtn.addEventListener("click", () => showState("ready"));
retryItemsBtn.addEventListener("click", () => bootstrap());

// ── CSV Export ────────────────────────────────────────────────────────────────

/**
 * Normalize a product name for fuzzy matching.
 * Returns an array of lowercase words ≥ 3 characters.
 * @param {string} str
 * @returns {string[]}
 */
function normalizeForMatch(str) {
  return (str || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length >= 3);
}

/**
 * Jaccard similarity between two word arrays.
 * @param {string[]} a
 * @param {string[]} b
 * @returns {number} 0–1
 */
function jaccardSimilarity(a, b) {
  if (!a.length || !b.length) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = [...setA].filter((w) => setB.has(w)).length;
  const union        = new Set([...setA, ...setB]).size;
  return union > 0 ? intersection / union : 0;
}

/**
 * Find the best-matching order for a warehouse item (by name similarity).
 * @param {object}   warehouseItem
 * @param {object[]} orders
 * @returns {object|null}
 */
function findOrderMatch(warehouseItem, orders) {
  if (!orders || orders.length === 0) return null;
  const wWords = normalizeForMatch(warehouseItem.name);
  let best = null;
  let bestScore = 0;

  for (const order of orders) {
    const score = jaccardSimilarity(wWords, normalizeForMatch(order.name));
    if (score > bestScore && score >= 0.25) {
      bestScore = score;
      best = order;
    }
  }
  return best;
}

/**
 * Escape a value for CSV output.
 * @param {string|number} value
 * @returns {string}
 */
function csvEscape(value) {
  const str = String(value == null ? "" : value);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Build a CSV string from warehouse items + matched order data.
 * @param {object[]} items   Serialized warehouse items
 * @param {object[]} orders  Stored order items from chrome.storage.local
 * @returns {string}
 */
function buildCSV(items, orders) {
  const headers = [
    "Name",
    "Weight_g",
    "Length_cm",
    "Width_cm",
    "Height_cm",
    "Quantity",
    "Category",
    "PurchasePrice_CNY",
    "ProductURL",
    "OrderID",
    "ExportDate",
  ];

  const today = new Date().toISOString().slice(0, 10);

  const rows = items.map((item) => {
    const match = findOrderMatch(item, orders);
    return [
      csvEscape(item.name    || ""),
      item.weight            || "",
      item.dimensions?.length || "",
      item.dimensions?.width  || "",
      item.dimensions?.height || "",
      item.quantity          || 1,
      csvEscape(item.category || ""),
      match ? (match.price   || "") : "",
      match ? csvEscape(match.url || "") : "",
      match ? csvEscape(match.orderId || "") : "",
      today,
    ];
  });

  return [headers, ...rows]
    .map((row) => row.join(","))
    .join("\n");
}

/**
 * Trigger a CSV file download in the popup context.
 * Uses a Blob + anchor click — no extra permissions needed.
 * @param {string} csvString
 * @param {string} filename
 */
function downloadCSV(csvString, filename) {
  const bom  = "\uFEFF"; // UTF-8 BOM so Excel opens it correctly
  const blob = new Blob([bom + csvString], { type: "text/csv;charset=utf-8;" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/**
 * Update the export hint label below the export button.
 * Shows whether cached order data is available.
 */
async function updateExportHint() {
  const stored = await new Promise((resolve) => {
    chrome.storage.local.get(["reflow_orders", "reflow_orders_ts"], resolve);
  });

  const orders = stored.reflow_orders || [];
  if (orders.length > 0) {
    const when = stored.reflow_orders_ts
      ? new Date(stored.reflow_orders_ts).toLocaleDateString("de-DE")
      : "?";
    exportOrdersHint.textContent = `✓ ${orders.length} Bestellungen gecacht (${when}) — Preise werden verknüpft`;
    exportOrdersHint.className   = "export-hint has-data";
  } else {
    exportOrdersHint.textContent = "Tipp: gtbuy.com/user/order öffnen um Preisdaten einzuschließen";
    exportOrdersHint.className   = "export-hint no-data";
  }
}

exportCsvBtn.addEventListener("click", async () => {
  exportCsvBtn.disabled     = true;
  exportCsvBtn.textContent  = "Wird erstellt...";

  try {
    const stored = await new Promise((resolve) => {
      chrome.storage.local.get(["reflow_orders"], resolve);
    });
    const orders = stored.reflow_orders || [];

    const csv      = buildCSV(allItems, orders);
    const date     = new Date().toISOString().slice(0, 10);
    const filename = `reflow-warehouse-${date}.csv`;

    downloadCSV(csv, filename);
  } catch (err) {
    console.error("[ReFlow] CSV export failed:", err);
  } finally {
    exportCsvBtn.disabled    = false;
    exportCsvBtn.textContent = "📥 Als CSV exportieren";
  }
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────

async function bootstrap() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || "";

  // 1. Not on GTBuy at all
  const isGTBuy = /gtbuy\.com/i.test(url);
  if (!isGTBuy) {
    const el = document.getElementById("debug-url-not-gtbuy");
    if (el) el.textContent = url ? `Erkannte URL: ${url}` : "Keine URL erkannt";
    showState("not-gtbuy");
    return;
  }

  // 2. On GTBuy but not on warehouse path
  const isWarehouse = /warehouse/i.test(url);
  if (!isWarehouse) {
    const el = document.getElementById("debug-url-no-warehouse");
    if (el) el.textContent = `Erkannte URL: ${url}`;
    showState("no-warehouse");
    return;
  }

  // 3. On warehouse — try to fetch items from content script
  const response = await sendToContent({ type: "GET_ITEMS" });

  if (response.error) {
    errorMessage.textContent = `Extension nicht erreichbar. Bitte Seite neu laden. (${response.error})`;
    showState("error");
    return;
  }

  if (!response.items || response.items.length === 0) {
    const el = document.getElementById("debug-url-no-items");
    if (el) el.textContent = `URL: ${url}`;
    showState("no-items");
    return;
  }

  allItems   = response.items;
  selectedIds = new Set(allItems.map((i) => i.id));

  itemCountLabel.textContent = `${allItems.length} Item${allItems.length !== 1 ? "s" : ""} erkannt`;
  renderItemList();
  updateWeightSummary(); // also calls updateDurationEstimate
  startBtn.disabled = false;
  updateExportHint(); // show cached orders status
  showState("ready");
}

bootstrap();

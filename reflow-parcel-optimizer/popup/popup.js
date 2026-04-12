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

// ── App state ──────────────────────────────────────────────────────────────────

let allItems      = [];   // WarehouseItem[] (serialized, no DOM refs)
let selectedIds   = new Set();

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

startBtn.addEventListener("click", async () => {
  showState("running");
  progressBarFill.style.width = "0%";
  progressLabel.textContent = "Starte Optimierung...";
  progressSub.textContent = "Kombinationen werden berechnet";

  const response = await sendToContent({
    type: "START_OPTIMIZATION",
    selectedItemIds: Array.from(selectedIds),
  });

  if (response.error) {
    errorMessage.textContent = response.error;
    showState("error");
    return;
  }

  if (response.result) {
    renderResults(response.result);
  }
});

stopBtn.addEventListener("click", async () => {
  await sendToContent({ type: "CANCEL_OPTIMIZATION" });
  showState("ready");
});

newOptimizationBtn.addEventListener("click", () => showState("ready"));

retryBtn.addEventListener("click", () => showState("ready"));
retryItemsBtn.addEventListener("click", () => bootstrap());

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
  //    Permissive check: just look for "warehouse" anywhere in the path
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
    // Content script not reachable → extension not injected (reload page)
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

  allItems = response.items;
  selectedIds = new Set(allItems.map((i) => i.id));

  itemCountLabel.textContent = `${allItems.length} Item${allItems.length !== 1 ? "s" : ""} erkannt`;
  renderItemList();
  updateWeightSummary();
  startBtn.disabled = false;
  showState("ready");
}

bootstrap();

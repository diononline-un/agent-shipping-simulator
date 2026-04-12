/**
 * ReFlow Parcel Optimizer — Background Service Worker
 *
 * Coordinates tab-based parallel candidate simulation:
 *   1. Receives START_TAB_OPTIMIZATION from the active tab's content script
 *   2. Opens one browser tab per candidate (≤ CONCURRENCY at a time)
 *   3. Serves task details to each tab via GET_TAB_TASK
 *   4. Collects CANDIDATE_DONE / CANDIDATE_SKIP, tracks progress
 *   5. Sends OPTIMIZATION_PROGRESS + OPTIMIZATION_COMPLETE to all extension pages
 *   6. Closes all task tabs when done
 */

const CONCURRENCY         = 1;    // sequential tabs — prevents cross-tab price contamination on GTBuy SPA
const TAB_STAGGER_MS      = 400;  // ms between tab opens (GTBuy rate-limit friendliness)
const GTBUY_WAREHOUSE_URL = "https://gtbuy.com/user/warehouse";

// ── In-memory optimization state ──────────────────────────────────────────────

/**
 * @type {{
 *   tasks:       Map<number, {candidateIndex:number, label:string, itemGroupIds:string[][]}>,
 *   itemDetails: Map<string, {id:string, name:string}>,
 *   results:     object[],
 *   total:       number,
 *   done:        number,
 *   openCount:   number,
 *   queue:       object[],
 * } | null}
 */
let optState = null;

/**
 * Maps tabId → item ID array for tabs opened via "In Tab öffnen".
 * One entry per group: each tab pre-selects its own group's items.
 * @type {Map<number, string[]>}
 */
const splitTasks = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function forwardToContentScript(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return { error: "No active tab" };
  return chrome.tabs.sendMessage(tab.id, message).catch((e) => ({ error: e.message }));
}

// ── Message router ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // Badge update from warehouse content script
  if (message.type === "ITEMS_DETECTED") {
    chrome.action.setBadgeText({
      text: message.count > 0 ? String(message.count) : "",
      tabId: sender.tab?.id,
    });
    chrome.action.setBadgeBackgroundColor({ color: "#FF6B35" });
    return;
  }

  // Popup → active tab content script relay
  const relayMessages = ["GET_ITEMS", "START_OPTIMIZATION", "CANCEL_OPTIMIZATION", "APPLY_SPLIT"];
  if (relayMessages.includes(message.type)) {
    forwardToContentScript(message)
      .then(sendResponse)
      .catch((e) => sendResponse({ error: e.message }));
    return true; // keep channel open for async response
  }

  // "Open in Tab" flow — opens one tab per group; each tab pre-selects its group's items.
  if (message.type === "OPEN_IN_TAB") {
    const itemGroups = message.itemGroups || []; // string[][]
    Promise.all(
      itemGroups.map((groupIds, idx) =>
        chrome.tabs.create({ url: GTBUY_WAREHOUSE_URL, active: idx === 0 })
          .then((tab) => { splitTasks.set(tab.id, groupIds); })
      )
    )
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ error: e.message }));
    return true;
  }

  // Content script in a split tab asks which items to pre-select.
  if (message.type === "GET_SPLIT_TASK") {
    const tabId   = sender.tab?.id;
    const itemIds = tabId ? (splitTasks.get(tabId) ?? null) : null;
    if (itemIds !== null) splitTasks.delete(tabId); // consume so it isn't applied twice
    sendResponse({ itemIds });
    return;
  }

  // ── Tab-based optimization ─────────────────────────────────────────────────

  // Content script sends this after generating candidates from the selected items
  if (message.type === "START_TAB_OPTIMIZATION") {
    startTabOptimization(message.candidates).catch(console.error);
    sendResponse({ ok: true });
    return;
  }

  // Each task tab asks for its assigned candidate on load
  if (message.type === "GET_TAB_TASK") {
    const tabId = sender.tab?.id;
    const task  = (optState && tabId) ? (optState.tasks.get(tabId) ?? null) : null;
    sendResponse({ task });
    return;
  }

  // Task tab finished successfully
  if (message.type === "CANDIDATE_DONE") {
    recordResult(message, sender.tab?.id, false);
    sendResponse({ ok: true });
    return;
  }

  // Task tab encountered an unrecoverable error
  if (message.type === "CANDIDATE_SKIP") {
    recordResult(message, sender.tab?.id, true);
    sendResponse({ ok: true });
    return;
  }

  // User pressed Stop in the popup
  if (message.type === "CANCEL_TAB_OPTIMIZATION") {
    cancelOptimization();
    sendResponse({ ok: true });
    return;
  }
});

// ── Tab optimization logic ────────────────────────────────────────────────────

async function startTabOptimization(candidates) {
  cancelOptimization(); // clean up any previous run

  // Build a flat id→name lookup used later to enrich results
  const itemDetails = new Map();
  candidates.forEach((c) => {
    (c.itemGroupDetails || []).forEach((group) => {
      group.forEach(({ id, name }) => itemDetails.set(id, { id, name }));
    });
  });

  optState = {
    tasks:     new Map(),
    itemDetails,
    results:   [],
    total:     candidates.length,
    done:      0,
    openCount: 0,
    queue:     candidates.map((c) => ({ ...c })),
  };

  await openNextBatch();
}

async function openNextBatch() {
  if (!optState) return;

  while (optState.openCount < CONCURRENCY && optState.queue.length > 0) {
    const candidate = optState.queue.shift();
    optState.openCount++;

    try {
      const tab = await chrome.tabs.create({ url: GTBUY_WAREHOUSE_URL, active: false });
      optState.tasks.set(tab.id, {
        candidateIndex: candidate.candidateIndex,
        label:          candidate.label,
        itemGroupIds:   candidate.itemGroupIds,
      });
    } catch (_) {
      // Could not open tab — count it as skipped
      optState.openCount--;
      recordResult(
        { candidateIndex: candidate.candidateIndex, label: candidate.label },
        null,
        true
      );
    }

    await sleep(TAB_STAGGER_MS);
  }
}

function recordResult(message, tabId, skipped) {
  if (!optState) return;

  optState.done++;
  optState.openCount = Math.max(0, optState.openCount - 1);

  if (!skipped && message.groups) {
    // Enrich serialized groups with item names from the lookup table
    const enrichedGroups = (message.groups || []).map((g) => ({
      items:        (g.itemIds || []).map((id) => optState.itemDetails.get(id) || { id, name: id }),
      cheapestLine: g.cheapestLine,
      allLines:     g.allLines,
    }));

    optState.results.push({
      candidateIndex: message.candidateIndex,
      candidate:      { label: message.label || `Kandidat ${message.candidateIndex + 1}` },
      totalPrice:     message.totalPrice || 0,
      groups:         enrichedGroups,
      skipped:        false,
    });
  } else {
    optState.results.push({
      candidateIndex: message.candidateIndex,
      candidate:      { label: message.label || `Kandidat ${message.candidateIndex + 1}` },
      totalPrice:     0,
      groups:         [],
      skipped:        true,
    });
  }

  // Close the task tab
  if (tabId) {
    chrome.tabs.remove(tabId).catch(() => {});
    optState.tasks.delete(tabId);
  }

  // Broadcast progress to popup (and any other open extension pages)
  const valid       = optState.results.filter((r) => !r.skipped && r.totalPrice > 0);
  const currentBest = valid.length > 0 ? Math.min(...valid.map((r) => r.totalPrice)) : null;
  chrome.runtime.sendMessage({
    type: "OPTIMIZATION_PROGRESS",
    done: optState.done,
    total: optState.total,
    currentBest,
  }).catch(() => {}); // popup might be closed

  if (optState.done >= optState.total) {
    finishOptimization();
  } else {
    openNextBatch().catch(console.error);
  }
}

function finishOptimization() {
  if (!optState) return;

  const results = [...optState.results];
  optState = null;

  const valid = results.filter((r) => !r.skipped && r.totalPrice > 0);
  valid.sort((a, b) => a.totalPrice - b.totalPrice);

  const topThree = valid.slice(0, 3);
  const baseline = results.find((r) => r.candidateIndex === 0) || null;
  const savings  = baseline && !baseline.skipped && topThree.length > 0
    ? Math.max(0, baseline.totalPrice - topThree[0].totalPrice)
    : 0;

  chrome.runtime.sendMessage({
    type: "OPTIMIZATION_COMPLETE",
    result: { topThree, savings, baseline },
  }).catch(() => {});
}

function cancelOptimization() {
  if (!optState) return;
  for (const [tabId] of optState.tasks) {
    chrome.tabs.remove(tabId).catch(() => {});
  }
  optState = null;
}

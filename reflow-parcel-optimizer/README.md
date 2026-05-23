# ReFlow Parcel Optimizer

Chrome Extension (Manifest V3) that automatically optimizes parcel grouping on GTBuy.com to minimize international shipping costs. Given a warehouse full of items from multiple orders, it scrapes item metadata, generates combinatorial split candidates (1–4 packages), **simulates each candidate via DOM automation** on live GTBuy pages, and ranks results by total shipping cost.

**Version:** 0.1.0 | **Tech:** Vanilla JS, zero dependencies, no build step

---

## Architecture Overview

```
 ┌──────────────────────────────────────────────────────────────────┐
 │  POPUP (popup/popup.html + popup.js + popup.css)                │
 │  ─ State machine with 7 states                                  │
 │  ─ Item selection, mode config, progress, results, CSV export   │
 │  ─ Communicates via chrome.runtime.sendMessage → background      │
 └───────────────────────────┬──────────────────────────────────────┘
                             │ chrome.runtime.sendMessage
                             ▼
 ┌──────────────────────────────────────────────────────────────────┐
 │  BACKGROUND SERVICE WORKER (background/service-worker.js)       │
 │  ─ Message router / relay between popup and content scripts     │
 │  ─ Tab-based parallel simulation orchestrator                  │
 │  ─ CSV export tab coordinator                                   │
 │  ─ "Open in Tab" split task manager                             │
 │  ─ Broadcasts OPTIMIZATION_PROGRESS / OPTIMIZATION_COMPLETE     │
 │  ─ Opens/closes dedicated chrome.windows for simulation         │
 └─────────┬──────────────────────────────────┬────────────────────┘
           │ chrome.tabs.sendMessage          │ chrome.tabs.create
           ▼                                  ▼
 ┌──────────────────────────┐   ┌───────────────────────────────────┐
 │  CONTENT SCRIPTS          │   │  TASK TABS (background-opened)    │
 │  (content/*.js)           │   │  ─ Each runs simulateCandidate() │
 │  ─ scraper.js             │   │  ─ Reports CANDIDATE_DONE/SKIP  │
 │  ─ simulator.js           │   │  ─ Closed by background when     │
 │  ─ optimizer.js           │   │    done                          │
 │  ─ orders-scraper.js      │   │                                   │
 │  ─ content.js             │   └───────────────────────────────────┘
 │  ─ agents/gtbuy.js        │
 │  ─ types.js               │
 └──────────────────────────┘
```

### Key Design Decisions

| Decision | Rationale |
|---|---|
| **Tab-based simulation** | Avoids Vue SPA state contamination between candidates in a single tab |
| **CONCURRENCY = 1** | Sequential tabs prevent cross-tab price contamination on GTBuy's Vue SPA |
| **Dedicated minimized window** | `chrome.windows.create({state:"minimized"})` isolates simulation from user's browsing session |
| **Message-based coordination** | All IPC flows through `chrome.runtime.sendMessage`; service worker is the central router |
| **No build tools** | Pure vanilla ES6+ loaded via `manifest.json` `content_scripts` array; global scope dependency resolution |
| **Agent abstraction** | `content/agents/gtbuy.js` encapsulates platform-specific selectors/parsers; `SUPPORTED_AGENTS` array enables multi-platform support |
| **DOM-ref serialization** | `checkboxRef` stripped via `serializeItems()` before crossing message boundaries (Chrome extension messaging cannot transfer DOM elements) |

---

## File Manifest

```
reflow-parcel-optimizer/
├── manifest.json                    # Chrome Extension Manifest V3
├── assets/
│   ├── icon-16.png                  # Extension icon (16px)
│   ├── icon-48.png                  # Extension icon (48px)
│   └── icon-128.png                 # Extension icon (128px)
├── background/
│   └── service-worker.js            # Central coordinator (348 LOC)
├── content/
│   ├── agents/
│   │   └── gtbuy.js                 # GTBuy platform configuration (125 LOC)
│   ├── content.js                   # Entry point, message dispatch, overlay (439 LOC)
│   ├── optimizer.js                 # Combination generator & pre-scoring (486 LOC)
│   ├── orders-scraper.js            # Paginated orders scraper (376 LOC)
│   ├── scraper.js                   # Two-pass warehouse item scraper (220 LOC)
│   ├── simulator.js                 # DOM-based simulation engine (470 LOC)
│   └── types.js                     # JSDoc type definitions (46 LOC)
├── popup/
│   ├── popup.html                   # Extension popup UI (142 LOC)
│   ├── popup.css                    # Dark-theme popup styles (539 LOC)
│   └── popup.js                     # State machine, UI logic, CSV builder (641 LOC)
└── styles/
    └── overlay.css                  # In-page result overlay styles (217 LOC)

Total: 4,086 lines of source + 3 PNG assets
```

---

## Component Deep-Dive

### 1. Agent Configuration (`content/agents/gtbuy.js`)

```js
const gtbuyConfig = {
  id: "gtbuy",
  name: "GTBuy",
  urlPattern:         /gtbuy\.com/,
  warehouseUrlPattern: /gtbuy\.com.*warehouse/i,
  ordersUrlPattern:    /gtbuy\.com.*\border\b/i,

  selectors: {
    itemContainer:      "div.table-content > div",
    itemCheckbox:       "input[type='checkbox']",
    selectAllCheckbox:  "div.all-select-footer input, .select-all input, footer input[type='checkbox']",
    nameCell:           "td:nth-child(1)",
    weightCell:         "td:nth-child(4)",
    dimensionCell:      "td:nth-child(5)",
    categoryCell:       "td:nth-child(7)",
    submitButton:       "div.bor-e2, .create-parcel-btn, button.submit-parcel",
    shippingLineRows:   "table tbody tr, .shipping-line-list > div, .mailing-route tr",
    shippingLineName:   "td:nth-child(1)",
    shippingLinePrice:  "td:nth-child(3)",
    shippingLineDays:   "td:nth-child(4)",
    shippingPageMarker: "Mailing Route",
    FORBIDDEN_BUTTON_TEXTS: ["Submit Parcel", "Confirm Order", "Place Order", "Pay Now"],
  },

  parsers: {
    weight(text)     { … },   // "1930" → 1930 (grams)
    dimensions(text) { … },   // "40 * 33 * 12" → {length, width, height}
    price(text)      { … },   // "$58.46" → 58.46
  },

  isWarehousePage(url) { … },
  isOrdersPage(url)    { … },
};
```

To add a new shipping platform, create a new config object matching this interface and append it to `SUPPORTED_AGENTS` in `content.js`.

---

### 2. Warehouse Scraper (`content/scraper.js`)

**Two-pass strategy:**

| Pass | Method | When Used | Failure Mode |
|---|---|---|---|
| **Pass 1** | CSS selectors from `agentConfig.selectors` | Fast path; `querySelectorAll(selectors.itemContainer)` | Returns `null` if 0 containers found |
| **Pass 2** | Content-based: `TreeWalker` scans all text nodes for `/(\d+)\s*\*\s*(\d+)\s*\*\s*(\d+)/` (dimension pattern) | Fallback when CSS selectors fail (site redesign) | Returns `{items:[], error:"…"}` if nothing found |

**`findItemContainer(el, maxLevels=8)`** — Walks up DOM from a dimension text node, checking at each ancestor:
1. Contains weight-like text (`/\b(\d{2,5})\b/` — 2–5 digit token)
2. Contains dimension pattern
3. Has `input[type='checkbox']` descendant

**`findOrderIdNear(container, maxLevels=8)`** — Extracts `IGT…` order ID from card header by walking up DOM.

**`scrapeItems(agentConfig)`** — Public API, returns `{items: WarehouseItem[], error: string|null}`.

---

### 3. Optimizer Engine (`content/optimizer.js`)

#### Algorithm Summary

```
generateCandidates(items, {maxPackages, mode})
  │
  ├── k=1: Baseline (all items in 1 parcel) — always simulated, always index 0
  │
  ├── k=2: 
  │     ├── n ≤ 18 → enumerate all 2^[n-1] splits (bitmask, item[0] anchored to group A)
  │     ├── n > 18 → random sample of 3,000 splits
  │     └── tierSplitsK2 → greedy fill to each weight tier boundary (500g, 1kg, 2kg, 3kg, 5kg, 10kg, 20kg, 30kg)
  │     └── Pre-score & keep top `perK` (8/12/20 depending on mode)
  │
  ├── k=3 (if maxPackages ≥ 3):
  │     ├── smartThreeWaySplits with 4 strategies:
  │     │     1. Greedy tier-boundary splits (all tier threshold pairs)
  │     │     2. Round-robin assignment to lightest group (3 item orderings: heaviest-first, lightest-first, original)
  │     │     3. Sub-split heaviest group from k=2 tier splits
  │     │     4. Random sampling
  │     └── Pre-score & keep top `perK`
  │
  └── k=4 (if maxPackages ≥ 4):
        ├── smartFourWaySplits with 3 strategies:
        │     1. Round-robin to 4 groups (3 orderings)
        │     2. Sub-split heaviest group from top k=3 candidates
        │     3. Random sampling
        └── Pre-score & keep top `perK`
```

#### Weight & Pre-scoring

- **`effectiveWeight(item)`** — `max(actual_weight, volumetric_weight)` where volumetric = `(L × W × H) / 5` (÷5000 cm³/kg × 1000 → g)
- **`estimateTierCost(weightG)`** — 8-tier piecewise-linear step function:
  - ≤500g: `w × 0.010`
  - 500–1000g: `5 + (w-500) × 0.008`
  - 1000–2000g: `9 + (w-1000) × 0.006`
  - 2000–3000g: `15 + (w-2000) × 0.005`
  - 3000–5000g: `20 + (w-3000) × 0.004`
  - 5000–10000g: `28 + (w-5000) × 0.003`
  - 10000–20000g: `43 + (w-10000) × 0.002`
  - >20000g: `63 + (w-20000) × 0.0015`
- **`scoreCandidate(itemGroups)`** — Sum of per-group `estimateTierCost`, used only for candidate ranking (actual costs come from simulation)

#### Depth Modes

| Mode | Candidates per k-level | Estimated Duration | Optimality |
|---|---|---|---|
| `fast` | 8 | ~5 min | ~90% |
| `standard` | 12 (default) | ~7 min | ~97% |
| `thorough` | 20 | ~12 min | ~99% |

#### Duration Estimation

```js
SECONDS_PER_CANDIDATE = 12;
estimateCandidateCount(n, maxPackages, mode)  // mirrors perK logic
formatDuration(count)  // → "~7 Min." or "~50 Sek."
```

#### Deduplication

**`candidateKey(itemGroups)`** — Canonical key: per-group item IDs sorted, then groups sorted. `"id1,id3,id5|id2,id4"`. Prevents structural duplicates (identical splits with different internal ordering).

---

### 4. DOM Simulation Engine (`content/simulator.js`)

Simulates the parcel creation flow **without placing any real orders**. Blacklist-based safety guarantee in `FORBIDDEN_BUTTON_TEXTS`.

#### Flow per Candidate Group

```
simulateCandidate(candidate, agentConfig, cancelToken, onLog)
  │
  └── for each group in candidate.itemGroups:
        │
        ├── 1. Re-scrape to refresh stale checkboxRefs (Vue re-renders)
        │
        ├── 2. deselectAll(agentConfig)
        │     ├── Uncheck "Select All" if checked
        │     └── Uncheck each item checkbox
        │
        ├── 3. selectItems(items)
        │     └── Per item: setCheckbox(inputEl, true) via Vue-compatible events
        │
        ├── 4. findSubmitButton(agentConfig)
        │     ├── Try configured CSS selector
        │     └── Fallback: text-match "Create Parcel" / "Submit for Delivery"
        │
        ├── 5. assertNotForbidden(submitBtn) — blacklist check
        │
        ├── 6. safeClick(submitBtn)
        │
        ├── 7. Wait 800ms, check for GTBuy "Select items for pickup" error dialog
        │     └── Dismiss if present, retry
        │
        ├── 8. waitFor(shippingLinesPresent, 15000ms)
        │
        ├── 9. readShippingLines(agentConfig)
        │     ├── GTBuy /submit/preview: VBTUY_PRICE_SEL selector (div-based)
        │     │   └── Walk up Vue scoped attributes (data-v-XXXX) to find row root
        │     │   └── Parse name, price (USD float), estimated days (N-N regex)
        │     └── Fallback: classic <table> layout via agent config selectors
        │
        ├── 10. Pick cheapest line per group
        │
        └── 11. navigateBack(agentConfig)
              ├── Try "Back"/"Cancel" text links first
              └── Fallback: window.history.back()
              └── waitFor(warehousePresent, 10000ms)
```

#### Vue Checkbox Handling

GTBuy uses Element Plus (Vue component library). Standard `.checked` property mutations are immediately reverted by Vue's virtual-DOM reconciler. The solution:

**`findClickTarget(inputEl)`** resolves the correct click target:
1. `.el-checkbox__inner` (the visual square element)
2. Closest `<label>` ancestor
3. Parent element (not BODY/FORM/TABLE/TBODY/TR/TD/TH)
4. The input itself (fallback)

**`setCheckbox(inputEl, targetChecked)`** dispatches:
- `MouseEvent("click")` on the visual target (bubbles, cancelable)
- `Event("change")` + `Event("input")` on the hidden `<input>` (belt-and-suspenders)

#### Timing Constants
- `SIMULATION_PAUSE_MS = 2000` — pause between groups
- `SHIPPING_PAGE_TIMEOUT_MS = 15000` — max wait for price table
- `WAREHOUSE_RELOAD_TIMEOUT_MS = 10000` — max wait for warehouse after navigating back

#### Error Recovery
On any failure: dismiss any open dialogs → `window.history.back()` → wait for warehouse to reappear. If recovery fails, the candidate is marked `skipped`.

---

### 5. Orders Scraper (`content/orders-scraper.js`)

Scrapes `gtbuy.com/user/order` for purchase data to enable CSV export with order info.

#### Per-Page Scraping

```
scrapeOrders(agentConfig)
  │
  ├── findOrderCards()
  │     ├── TreeWalker over leaf text nodes matching /Order\s+No\s*[：:]\s*([A-Za-z0-9]{6,})/i
  │     └── findCardContainer(el) — walk up DOM, find container with ≥2 children + "$" price
  │
  └── extractItemsFromCard(cardEl, orderId)
        ├── leafElements(cardEl) — collect all leaf text nodes
        ├── Find USD prices via /^\$\s*([\d,]+\.?\d*)$/
        │     └── Sort prices, pick smallest as unitPrice, largest as totalPrice
        ├── Find quantity via /^[xX×]\s*(\d+)$/ (badge) or derive from unitPrice/totalPrice
        ├── Find product name: text node 10–120 chars, not matching skip patterns
        └── Find description: text matching /^(?:Color|Size|Style|Material|Type|Spec)\s*[：:]/i
```

#### Paginated Export Flow

```
runOrdersScrapeFlow(agentConfig)
  │
  └── for page in 1..MAX_PAGES(20):
        ├── waitForOrderCards(8000ms) — MutationObserver-based
        ├── scrapeOrders(agentConfig)
        ├── storeOrders(orders) — merge into chrome.storage.local["reflow_orders"]
        ├── Send ORDERS_SCRAPE_PROGRESS to background
        ├── findNextPageButton()
        │     ├── Ant Design: li.ant-pagination-next:not(.ant-pagination-disabled)
        │     └── Generic: text ">" / "›" / "Next" / "下一页"
        └── Click next, wait for SPA re-render
```

`storeOrders()` merges by `orderId` key — paginating accumulates across pages.

---

### 6. Content Script (`content/content.js`)

Entry point injected by manifest.json at `document_idle`. Three operating modes:

| Mode | Detection | Behavior |
|---|---|---|
| **Normal** | User has warehouse tab open | Scrapes items, handles GET_ITEMS / START_OPTIMIZATION / CANCEL_OPTIMIZATION / APPLY_SPLIT messages |
| **Task Tab** | Tab was created by background; polls `GET_TAB_TASK` (5 retries over 2.5s) | Runs `simulateCandidate()`, reports `CANDIDATE_DONE` / `CANDIDATE_SKIP` |
| **Split Task** | Tab was created via "Open in Tab"; polls `GET_SPLIT_TASK` | Pre-selects items for one parcel group |
| **Export Task** | Orders page; polls `GET_EXPORT_TASK` | Runs `runOrdersScrapeFlow()` for paginated export or does single-page refresh |

#### SPA Navigation Handling

`MutationObserver` on `document.body` detects URL changes in GTBuy's Vue SPA and triggers `refreshItems()` or `refreshOrders()` when navigating between warehouse/orders pages.

#### Item Serialization

```js
function serializeItems(items) {
  return items.map(({ id, name, weight, dimensions, quantity, category, orderId }) => ({
    id, name, weight, dimensions, quantity, category, orderId: orderId || "",
  }));
}
```

Strips `checkboxRef` (DOM element) — not transferable across Chrome extension message ports.

#### Overlay Injection

After `OPTIMIZATION_COMPLETE`, `showOverlay()` injects `<div id="reflow-overlay">`:
- Full-screen modal with dark backdrop (`rgba(0,0,0,0.65)`)
- Best option with parcel group details (shipping line name, price, estimated days, items)
- Alternative options (2nd and 3rd place)
- "Apply Split" → pre-selects package 1 items
- "Open in Tab" → opens one tab per package group
- Fixed positioning at `z-index: 2147483647`

---

### 7. Background Service Worker (`background/service-worker.js`)

#### Tab-Based Optimization Orchestrator

```
START_TAB_OPTIMIZATION(candidates)
  │
  ├── cancelOptimization() — clean previous run
  ├── Build itemDetails Map (id → {id, name}) for later result enrichment
  ├── Initialize optState:
  │     tasks:     Map<tabId, candidate>
  │     itemDetails: Map<id, {id, name}>
  │     results:   []
  │     total:     candidates.length
  │     done:      0
  │     openCount: 0
  │     queue:     [...candidates]
  │     windowId:  null
  │
  ├── chrome.windows.create({url:"about:blank", state:"minimized", focused:false})
  │     └── Sets optState.windowId (falls back to null if permission missing)
  │     └── Blank tab preserved to prevent window auto-close on zero tabs
  │
  └── openNextBatch()
        └── while (openCount < CONCURRENCY && queue.length > 0):
              ├── Dequeue candidate
              ├── openCount++
              ├── chrome.tabs.create({url:warehouse, active:false, windowId})
              ├── optState.tasks.set(tab.id, {candidateIndex, label, itemGroupIds})
              └── sleep(TAB_STAGGER_MS = 400ms)
```

**`CONCURRENCY = 1`** — Sequential execution prevents GTBuy's Vue SPA from inadvertently sharing state between tabs (e.g., stale prices, conflicting checkbox state). Each tab loads the warehouse, selects its group, submits, reads prices, and navigates back independently.

#### Result Collection and Completion

```
recordResult(message, tabId, skipped)
  │
  ├── optState.done++
  ├── openCount--
  │
  ├── If !skipped: enrich groups with item names from itemDetails Map
  │     └── Strip itemIds → resolve to {id, name} objects
  │
  ├── chrome.tabs.remove(tabId) — close task tab
  ├── optState.tasks.delete(tabId)
  │
  ├── Broadcast OPTIMIZATION_PROGRESS {done, total, currentBest}
  │
  └── if done >= total → finishOptimization()
        ├── Close simulation window
        ├── Sort results by totalPrice ASC
        ├── Compute topThree, baseline (index 0), savings
        └── Broadcast OPTIMIZATION_COMPLETE {topThree, savings, baseline}
```

#### CSV Export Flow

```
START_ORDERS_SCRAPE
  └── background opens hidden orders tab (active: false)
      └── Content script calls GET_EXPORT_TASK → confirmed as export tab
          └── runOrdersScrapeFlow() paginates, accumulates via chrome.storage.local
              └── ORDERS_SCRAPE_DONE → background closes tab, forwards to popup
```

#### Open in Tab Flow

```
OPEN_IN_TAB (message.itemGroups: string[][])
  └── Per group: chrome.tabs.create({url: warehouse})
      └── splitTasks.set(tab.id, groupItemIds)
      └── Tab loads → content.js checkForSplitTask()
          └── GET_SPLIT_TASK → pre-selects items
```

---

### 8. Popup (`popup/popup.js`, `popup.html`, `popup.css`)

#### State Machine

| State | Element | Condition |
|---|---|---|
| `not-gtbuy` | `#state-not-gtbuy` | URL not matching `gtbuy.com` |
| `no-warehouse` | `#state-no-warehouse` | On GTBuy but not on `/warehouse` path |
| `no-items` | `#state-no-items` | Warehouse page but scraper returned 0 items |
| `ready` | `#state-ready` | Items scraped, list rendered, awaiting user config |
| `running` | `#state-running` | Optimization in progress; progress bar + stop button |
| `results` | `#state-results` | Top 3 results displayed with Apply/Open-in-Tab actions |
| `error` | `#state-error` | Error message with retry button |

#### CSV Export Flow

```
Export button click
  ├── Persist warehouse items to chrome.storage.local
  ├── Send START_ORDERS_SCRAPE → background opens hidden orders tab
  ├── Monitor ORDERS_SCRAPE_PROGRESS (page updates)
  └── ORDERS_SCRAPE_DONE → finishExport()
        ├── Fetch reflow_warehouse_items + reflow_orders from storage
        ├── buildCSV(items, orders):
        │     ├── headers: Name, Weight_g, Length_cm, Width_cm, Height_cm,
        │     │            Quantity, Category, OrderID, Description,
        │     │            UnitPrice_USD, TotalPrice_USD, ExportDate
        │     ├── findOrderMatch(warehouseItem, ordersByIdMap, ordersArray):
        │     │     ├── Exact orderId match (O(1) via Map)
        │     │     └── Jaccard word-similarity fallback (≥30% threshold)
        │     └── csvEscape(value) with double-quote escaping
        └── downloadCSV(csv, filename):
              ├── Prepend UTF-8 BOM (\uFEFF) for Excel compatibility
              ├── Blob with text/csv MIME type
              └── Create <a>, click, revoke object URL
```

#### Debug Panel

Real-time log viewer with timestamped entries, color-coded by level (`info`, `warn`, `error`). Auto-opens on `error` events. Supports clear and copy-to-clipboard.

---

## Message Protocol Reference

All messages are JSON objects with a `type` field. Communication flows through `chrome.runtime.sendMessage`.

### Full Message Catalog

| Type | Direction | Payload | Response |
|---|---|---|---|
| `GET_ITEMS` | Popup → Background → Content | `{}` | `{items: WarehouseItem[]}` |
| `ITEMS_DETECTED` | Content → Background | `{count: number}` | — (badge update) |
| `START_OPTIMIZATION` | Popup → Background → Content | `{selectedItemIds, maxPackages, mode}` | `{ok: true}` |
| `START_TAB_OPTIMIZATION` | Content → Background | `{candidates: serializedCandidates[]}` | `{ok: true}` |
| `GET_TAB_TASK` | Task Tab → Background | `{}` | `{task: {candidateIndex, label, itemGroupIds} \| null}` |
| `CANDIDATE_DONE` | Task Tab → Background | `{candidateIndex, label, totalPrice, groups}` | `{ok: true}` |
| `CANDIDATE_SKIP` | Task Tab → Background | `{candidateIndex, label}` | `{ok: true}` |
| `OPTIMIZATION_PROGRESS` | Background → Popup | `{done, total, currentBest}` | — |
| `OPTIMIZATION_COMPLETE` | Background → Popup + Content | `{result: {topThree, savings, baseline}}` | — |
| `SIMULATION_LOG` | Content → Background → Popup | `{level, message, ts}` | — |
| `CANCEL_OPTIMIZATION` | Popup → Background → Content | `{}` | `{ok: true}` |
| `CANCEL_TAB_OPTIMIZATION` | Content → Background | `{}` | `{ok: true}` |
| `APPLY_SPLIT` | Popup → Background → Content | `{itemGroups: string[][]}` | `{ok: true}` |
| `OPEN_IN_TAB` | Popup → Background | `{itemGroups: string[][]}` | `{ok: true}` |
| `GET_SPLIT_TASK` | Split Tab → Background | `{}` | `{itemIds: string[] \| null}` |
| `START_ORDERS_SCRAPE` | Popup → Background | `{}` | `{ok: true}` |
| `GET_EXPORT_TASK` | Orders Tab → Background | `{}` | `{isExportTab: boolean}` |
| `ORDERS_SCRAPE_PROGRESS` | Orders Tab → Background → Popup | `{page, count}` | — |
| `ORDERS_SCRAPE_DONE` | Orders Tab → Background → Popup | `{count}` | — |
| `ORDERS_DETECTED` | Content → Background | `{count}` | — |

---

## Data Type Definitions

Extracted from `content/types.js` (JSDoc, no runtime impact):

```typescript
interface Dimensions {
  length: number;  // cm
  width: number;   // cm
  height: number;  // cm
}

interface WarehouseItem {
  id: string;
  name: string;
  weight: number;          // grams
  dimensions: Dimensions;  // cm
  quantity: number;
  category: string;        // e.g. "Common Goods", "Sensitive"
  checkboxRef: Element;    // DOM reference — stripped during serialization
  thumbnailUrl?: string;
  orderId?: string;        // extracted from card header "Order No: IGT..."
}

interface ShippingLine {
  name: string;            // e.g. "JD-DHL-DE(Economy)"
  price: number;           // USD float
  currency: string;        // "USD"
  estimatedDays: string;   // e.g. "9-16"
  features: string[];      // e.g. ["Insurance Available", "Tax free"]
}

interface ParcelCandidate {
  label: string;           // e.g. "2 Pakete — 4.92 kg + 3.14 kg"
  itemGroups: WarehouseItem[][];  // each inner array = one parcel
}

interface SimGroupResult {
  items: WarehouseItem[];
  cheapestLine: ShippingLine;
  allLines: ShippingLine[];
}

interface SimulationResult {
  candidate: ParcelCandidate;
  groups: SimGroupResult[];
  totalPrice: number;
  skipped?: boolean;       // true if simulation failed
}

interface OptimizationResult {
  results: SimulationResult[];
  baseline: SimulationResult;  // index 0 (all items in 1 parcel)
  topThree: SimulationResult[];
  savings: number;          // baseline.totalPrice - topThree[0].totalPrice
}
```

---

## Storage Keys

`chrome.storage.local`:

| Key | Type | Purpose | TTL |
|---|---|---|---|
| `reflow_warehouse_items` | `WarehouseItem[]` (serialized) | Persisted warehouse items for CSV export | Written on scrape, never auto-cleared |
| `reflow_warehouse_items_ts` | `number` | Timestamp of last warehouse scrape | — |
| `reflow_orders` | `object[]` | Merged order entries keyed by `orderId` | Accumulated across pagination |
| `reflow_orders_ts` | `number` | Timestamp of last order scrape | — |
| `reflow_orders_url` | `string` | Source URL for order data | — |

In-memory state (service worker):
- `optState` — optimization run: `tasks` Map, `itemDetails` Map, `results`, counters, `queue`
- `splitTasks` — Map of `tabId → itemIds[]` for "Open in Tab" flow
- `exportTabId` — current export tab ID (singular)

---

## Permission Model

```json
{
  "permissions":      ["activeTab", "storage", "tabs", "windows"],
  "host_permissions": ["*://gtbuy.com/*", "*://*.gtbuy.com/*"]
}
```

| Permission | Usage |
|---|---|
| `activeTab` | Access the current tab's URL and content script |
| `storage` | `chrome.storage.local` for warehouse items and orders |
| `tabs` | Create/remove/query/send messages to tabs |
| `windows` | Create/remove dedicated simulation window |
| `*://gtbuy.com/*` | Content script injection + host access |

No external API calls — all data sourced from DOM scraping.

---

## Integration Points

The agent abstraction enables multi-platform support. To add a new shipping platform:

1. Create `content/agents/<platform>.js` matching `gtbuyConfig` interface
2. Set `urlPattern`, `warehouseUrlPattern`, `ordersUrlPattern` for URL detection
3. Configure CSS selectors and parsers for the platform's DOM structure
4. Add config to `manifest.json` `content_scripts[0].js` array
5. Append to `SUPPORTED_AGENTS` array in `content/content.js`

The optimizer engine (`content/optimizer.js`) and simulator (`content/simulator.js`) are platform-agnostic — they operate on the abstracted `WarehouseItem` / `ShippingLine` data model and interact with the DOM through `agentConfig.selectors`.

The CSV export module (`popup/popup.js:buildCSV`, `popup/popup.js:findOrderMatch`) is also reusable across platforms — the Jaccard word-similarity fallback matching works with any product naming convention.

---

## Build & Installation

No build step required. Load as an unpacked Chrome extension:

1. Navigate to `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select `reflow-parcel-optimizer/` directory

File load order is defined in `manifest.json` `content_scripts[0].js` array. Each content script file runs in the same isolation context — globals from earlier files (`gtbuy.js` → `scraper.js` → `orders-scraper.js` → `simulator.js` → `optimizer.js` → `content.js`) are available to later files. This is intentional and replaces a module bundler.

---

## Constraints & Limitations

| Constraint | Detail |
|---|---|
| **CONCURRENCY = 1** | Sequential tab execution prevents parallel simulation (necessary for GTBuy SPA integrity) |
| **SIMULATION_PAUSE_MS = 2000** | Artificial delay between candidate groups (prevents rate-limiting / IP bans) |
| **MAX_PAGES = 20** | Orders scraper stops after 20 pages of pagination |
| **n ≤ 18 enumeration** | Full enumeration of 2-way splits only for ≤18 items (2¹⁷ = 131,072 max); >18 items uses 3,000 random samples |
| **Serialized-only over messages** | DOM elements (checkboxRef) cannot cross Chrome message boundaries; items must be re-scraped in task tabs |
| **German-only UI** | All user-facing text is hardcoded in German (`de-DE`) |
| **GTBuy HTML dependency** | Scrapers depend on GTBuy's DOM structure; site redesigns may break selectors (content-based fallback mitigates this) |
| **No off-screen scraping** | All simulation requires visible tabs (Chrome background tabs may throttle/delay execution) |
| **Single-platform** | Only GTBuy agent is implemented; `SUPPORTED_AGENTS` framework supports multi-platform extension |

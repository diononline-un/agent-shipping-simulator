/**
 * ReFlow Parcel Optimizer — Combination Generator & Optimization Engine
 *
 * Strategy: Smart candidates (weight-tier boundary splits) +
 *           all 2-way splits of selected items, capped at MAX_CANDIDATES.
 */

/* global module */

const MAX_CANDIDATES = 30;

// Weight tier breakpoints in grams (common GTBuy shipping tier boundaries)
const WEIGHT_TIERS_G = [5000, 10000, 20000];

/**
 * Returns the total weight of an item array in grams.
 * @param {import('./types').WarehouseItem[]} items
 * @returns {number}
 */
function totalWeight(items) {
  return items.reduce((sum, item) => sum + item.weight, 0);
}

/**
 * Generates all unique 2-way splits of an array.
 * A split [A, B] and [B, A] are considered the same — only one is returned.
 * @param {import('./types').WarehouseItem[]} items
 * @returns {[import('./types').WarehouseItem[], import('./types').WarehouseItem[]][]}
 */
function allTwoWaySplits(items) {
  const splits = [];
  const n = items.length;
  // Enumerate all subsets for group A (skip empty and full set)
  // To avoid duplicates, only iterate over subsets where item[0] is always in group A
  for (let mask = 1; mask < (1 << n) - 1; mask++) {
    // De-duplicate: only accept masks where bit 0 is set (item[0] always in A)
    if (!(mask & 1)) continue;

    const groupA = [];
    const groupB = [];
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) groupA.push(items[i]);
      else groupB.push(items[i]);
    }
    splits.push([groupA, groupB]);
  }
  return splits;
}

/**
 * Generates weight-tier-boundary splits.
 * For each tier limit G, fills group A with the heaviest items that fit under G,
 * puts the rest in group B.
 * @param {import('./types').WarehouseItem[]} items
 * @returns {[import('./types').WarehouseItem[], import('./types').WarehouseItem[]][]}
 */
function tierSplits(items) {
  const sorted = [...items].sort((a, b) => b.weight - a.weight);
  const results = [];

  for (const tier of WEIGHT_TIERS_G) {
    const groupA = [];
    const groupB = [];
    let accumulated = 0;

    for (const item of sorted) {
      if (accumulated + item.weight <= tier) {
        groupA.push(item);
        accumulated += item.weight;
      } else {
        groupB.push(item);
      }
    }

    // Only add if both groups are non-empty (otherwise same as "all in one")
    if (groupA.length > 0 && groupB.length > 0) {
      results.push([groupA, groupB]);
    }
  }
  return results;
}

/**
 * Builds a human-readable label for a candidate.
 * @param {import('./types').WarehouseItem[][]} itemGroups
 * @returns {string}
 */
function candidateLabel(itemGroups) {
  if (itemGroups.length === 1) {
    return `1 Paket — ${(totalWeight(itemGroups[0]) / 1000).toFixed(2)} kg`;
  }
  const weights = itemGroups.map((g) => `${(totalWeight(g) / 1000).toFixed(2)} kg`);
  return `${itemGroups.length} Pakete — ${weights.join(" + ")}`;
}

/**
 * Deduplicates candidates by their sorted item-ID signature.
 * @param {import('./types').ParcelCandidate[]} candidates
 * @returns {import('./types').ParcelCandidate[]}
 */
function deduplicate(candidates) {
  const seen = new Set();
  return candidates.filter((c) => {
    const key = c.itemGroups
      .map((g) => g.map((i) => i.id).sort().join(","))
      .sort()
      .join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Generates up to MAX_CANDIDATES parcel split candidates for the given items.
 *
 * Order: [0] Baseline (all in one), then tier splits, then 2-way splits.
 * If total > MAX_CANDIDATES, tier splits are always kept and 2-way splits
 * are sampled evenly to fill the remaining slots.
 *
 * @param {import('./types').WarehouseItem[]} items
 * @returns {import('./types').ParcelCandidate[]}
 */
function generateCandidates(items) {
  if (items.length === 0) return [];

  const candidates = [];

  // Baseline: all items in 1 parcel
  candidates.push({
    label: candidateLabel([items]),
    itemGroups: [items],
  });

  // Only baseline makes sense for a single item
  if (items.length === 1) return candidates;

  // Weight-tier boundary splits
  for (const [groupA, groupB] of tierSplits(items)) {
    candidates.push({
      label: candidateLabel([groupA, groupB]),
      itemGroups: [groupA, groupB],
    });
  }

  // All 2-way splits
  const twoWay = allTwoWaySplits(items).map(([groupA, groupB]) => ({
    label: candidateLabel([groupA, groupB]),
    itemGroups: [groupA, groupB],
  }));

  // Deduplicate before capping
  const allCandidates = deduplicate([...candidates, ...twoWay]);

  if (allCandidates.length <= MAX_CANDIDATES) {
    return allCandidates;
  }

  // Cap: always keep baseline + tier splits, sample remaining 2-way splits
  const tierCount = candidates.length; // baseline + tier splits
  const slotsLeft = MAX_CANDIDATES - tierCount;

  // Sample evenly from 2-way splits (skip duplicates already in tier splits)
  const twoWayUnique = twoWay.filter((c) => {
    const key = c.itemGroups
      .map((g) => g.map((i) => i.id).sort().join(","))
      .sort()
      .join("|");
    return !candidates.some((existing) => {
      const k2 = existing.itemGroups
        .map((g) => g.map((i) => i.id).sort().join(","))
        .sort()
        .join("|");
      return k2 === key;
    });
  });

  const step = Math.max(1, Math.floor(twoWayUnique.length / slotsLeft));
  const sampled = twoWayUnique.filter((_, i) => i % step === 0).slice(0, slotsLeft);

  return [...candidates, ...sampled];
}

/**
 * Runs the full optimization loop.
 * Calls simulateCandidate for each candidate and returns sorted results.
 *
 * @param {import('./types').WarehouseItem[]} items
 * @param {Object}   agentConfig
 * @param {Function} simulateCandidate - async (candidate, agentConfig, cancelToken, onLog) => SimulationResult
 * @param {Function} onProgress        - (done: number, total: number, currentBest: number|null) => void
 * @param {{ cancelled: boolean }} cancelToken
 * @param {Function} [onLog]           - (level: string, message: string) => void
 * @returns {Promise<import('./types').OptimizationResult>}
 */
async function runOptimization(items, agentConfig, simulateCandidate, onProgress, cancelToken, onLog) {
  const log = onLog || (() => {});
  const candidates = generateCandidates(items);
  const results = [];
  let baseline = null;

  log("info", `Optimizer: ${candidates.length} Kandidaten für ${items.length} Items`);

  for (let i = 0; i < candidates.length; i++) {
    if (cancelToken.cancelled) { log("warn", "Optimierung abgebrochen"); break; }

    const currentBest = results.length > 0
      ? Math.min(...results.filter((r) => !r.skipped).map((r) => r.totalPrice))
      : null;

    onProgress(i, candidates.length, currentBest);
    log("info", `── Kandidat ${i + 1}/${candidates.length}: ${candidates[i].label}`);

    const result = await simulateCandidate(candidates[i], agentConfig, cancelToken, log);
    results.push(result);

    if (result.skipped) {
      log("warn", `   ↳ Übersprungen`);
    } else {
      log("info", `   ↳ Gesamt: $${result.totalPrice.toFixed(2)}`);
    }

    if (i === 0) baseline = result;
  }

  onProgress(candidates.length, candidates.length, null);

  const valid = results.filter((r) => !r.skipped && r.totalPrice > 0);
  valid.sort((a, b) => a.totalPrice - b.totalPrice);

  const topThree = valid.slice(0, 3);
  const savings = baseline && !baseline.skipped && topThree.length > 0
    ? baseline.totalPrice - topThree[0].totalPrice
    : 0;

  return { results, baseline, topThree, savings };
}

if (typeof module !== "undefined") module.exports = { generateCandidates, runOptimization, totalWeight };

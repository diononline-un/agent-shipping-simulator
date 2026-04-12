/**
 * ReFlow Parcel Optimizer — Combination Generator & Optimization Engine
 *
 * Strategy:
 *  k=1 — baseline (all items in one parcel)
 *  k=2 — enumerate all 2-way splits (n≤18) or sample (n>18), pre-score, keep top N
 *  k=3 — smart sampling (tier splits + round-robin + sub-splits), pre-score, keep top N
 *  k=4 — smart sampling (round-robin + sub-splits of k=3 + random), pre-score, keep top N
 *
 * Pre-scoring uses effective weight (max of actual weight and volumetric weight)
 * to estimate shipping cost without simulation.  The candidate cap is always 100;
 * the slot budget is divided between k levels based on maxPackages.
 */

/* global module */

// Weight tier breakpoints in grams (common GTBuy shipping tier boundaries)
const WEIGHT_TIERS_G = [500, 1000, 2000, 3000, 5000, 10000, 20000, 30000];

// Assumed seconds per simulated candidate — used for the duration estimate only
const SECONDS_PER_CANDIDATE = 12;

// Hard cap on total candidates regardless of settings
const MAX_CANDIDATES = 100;

// ── Weight helpers ────────────────────────────────────────────────────────────

/**
 * Returns the effective weight of an item in grams.
 * Volumetric weight (L×W×H / 5000 cm³→kg, converted to g) is used when it
 * exceeds the declared weight.  GTBuy divisor: 5000 cm³/kg.
 * @param {{ weight: number, dimensions?: { length: number, width: number, height: number } }} item
 * @returns {number}
 */
function effectiveWeight(item) {
  const actual = item.weight || 0;
  const d = item.dimensions;
  if (d && d.length > 0 && d.width > 0 && d.height > 0) {
    // cm³ / 5000 → kg × 1000 → g  ≡  cm³ / 5
    const vol = (d.length * d.width * d.height) / 5;
    return Math.max(actual, vol);
  }
  return actual;
}

/**
 * Returns the total effective weight of an item array in grams.
 */
function totalWeight(items) {
  return items.reduce((sum, item) => sum + effectiveWeight(item), 0);
}

// ── Pre-scoring ───────────────────────────────────────────────────────────────

/**
 * Rough cost estimate for a given effective weight in grams.
 * Only used for candidate ranking — actual costs come from simulation.
 * Models a typical progressive step-function shipping price curve.
 */
function estimateTierCost(weightG) {
  if (weightG <=   500) return weightG * 0.010;
  if (weightG <=  1000) return  5  + (weightG -   500) * 0.008;
  if (weightG <=  2000) return  9  + (weightG -  1000) * 0.006;
  if (weightG <=  3000) return 15  + (weightG -  2000) * 0.005;
  if (weightG <=  5000) return 20  + (weightG -  3000) * 0.004;
  if (weightG <= 10000) return 28  + (weightG -  5000) * 0.003;
  if (weightG <= 20000) return 43  + (weightG - 10000) * 0.002;
  return                        63  + (weightG - 20000) * 0.0015;
}

/**
 * Pre-scores a candidate split — lower is better (cheaper estimated shipping).
 * @param {Array[]} itemGroups
 * @returns {number}
 */
function scoreCandidate(itemGroups) {
  return itemGroups.reduce((sum, g) => sum + estimateTierCost(totalWeight(g)), 0);
}

// ── Label / key helpers ───────────────────────────────────────────────────────

function candidateLabel(itemGroups) {
  if (itemGroups.length === 1) {
    return `1 Paket — ${(totalWeight(itemGroups[0]) / 1000).toFixed(2)} kg`;
  }
  const weights = itemGroups.map((g) => `${(totalWeight(g) / 1000).toFixed(2)} kg`);
  return `${itemGroups.length} Pakete — ${weights.join(" + ")}`;
}

/** Canonical deduplication key for a candidate. */
function candidateKey(itemGroups) {
  return itemGroups
    .map((g) => g.map((i) => i.id).sort().join(","))
    .sort()
    .join("|");
}

// ── k=2 generators ────────────────────────────────────────────────────────────

/**
 * Generates all unique 2-way splits.
 * For n ≤ 18 every split is enumerated (max 2^17 = 131 072).
 * For n > 18 a random sample of 3 000 splits is used instead.
 * item[0] is always in group A, which eliminates mirror duplicates.
 */
function allTwoWaySplits(items) {
  const n = items.length;
  if (n > 18) {
    const splits = [];
    for (let s = 0; s < 3000; s++) {
      const shuffled = [...items].sort(() => Math.random() - 0.5);
      const cut = Math.floor(1 + Math.random() * (n - 2));
      splits.push([shuffled.slice(0, cut), shuffled.slice(cut)]);
    }
    return splits;
  }
  // item[0] is always in group A (eliminates mirror duplicates).
  // Remaining items[1..n-1]: bit (i-1) = 1 → group A, 0 → group B.
  // mask=0            → all remaining items in B (valid: gB non-empty)
  // mask=2^(n-1)-1    → all remaining items in A (invalid: gB empty) — excluded
  const splits = [];
  for (let mask = 0; mask < (1 << (n - 1)) - 1; mask++) {
    const gA = [items[0]];
    const gB = [];
    for (let i = 1; i < n; i++) {
      if (mask & (1 << (i - 1))) gA.push(items[i]);
      else gB.push(items[i]);
    }
    splits.push([gA, gB]);
  }
  return splits;
}

/**
 * Generates 2-way splits anchored at each weight-tier boundary.
 * Items are sorted heaviest-first; group A fills up to each tier limit.
 */
function tierSplitsK2(items) {
  const sorted = [...items].sort((a, b) => effectiveWeight(b) - effectiveWeight(a));
  const results = [];
  for (const tier of WEIGHT_TIERS_G) {
    const gA = [], gB = [];
    let acc = 0;
    for (const item of sorted) {
      const w = effectiveWeight(item);
      if (acc + w <= tier) { gA.push(item); acc += w; }
      else gB.push(item);
    }
    if (gA.length > 0 && gB.length > 0) results.push([gA, gB]);
  }
  return results;
}

// ── k=3 generator ────────────────────────────────────────────────────────────

/**
 * Generates smart k=3 candidates via four strategies:
 *  1. Greedy tier-boundary splits with two threshold pairs
 *  2. Round-robin assignment to the currently lightest group (3 item orderings)
 *  3. Sub-split the heaviest group from each tier-based 2-way split
 *  4. Random sampling to fill remaining budget
 *
 * @param {Array} items
 * @param {number} budget  - soft target for how many raw candidates to generate
 * @returns {Array[][]}
 */
function smartThreeWaySplits(items, budget) {
  if (items.length < 3) return [];
  const candidates = [];

  // 1. Tier-boundary greedy splits (all pairs of tier thresholds)
  const sorted = [...items].sort((a, b) => effectiveWeight(b) - effectiveWeight(a));
  for (let ti = 0; ti < WEIGHT_TIERS_G.length; ti++) {
    for (let tj = ti; tj < WEIGHT_TIERS_G.length; tj++) {
      const t1 = WEIGHT_TIERS_G[ti];
      const t2 = WEIGHT_TIERS_G[tj];
      const gA = [], gB = [], gC = [];
      let accA = 0, accB = 0;
      for (const item of sorted) {
        const w = effectiveWeight(item);
        if (accA + w <= t1)      { gA.push(item); accA += w; }
        else if (accB + w <= t2) { gB.push(item); accB += w; }
        else                       gC.push(item);
      }
      if (gA.length && gB.length && gC.length) candidates.push([gA, gB, gC]);
    }
  }

  // 2. Round-robin (assign each item to the currently lightest group)
  for (const ordering of [
    [...items].sort((a, b) => effectiveWeight(b) - effectiveWeight(a)),
    [...items].sort((a, b) => effectiveWeight(a) - effectiveWeight(b)),
    [...items],
  ]) {
    const groups = [[], [], []];
    const sums   = [0, 0, 0];
    for (const item of ordering) {
      const idx = sums.indexOf(Math.min(...sums));
      groups[idx].push(item);
      sums[idx] += effectiveWeight(item);
    }
    if (groups.every((g) => g.length > 0)) candidates.push(groups);
  }

  // 3. Sub-split the heavier group from each tier-based 2-way split
  for (const [gA, gB] of tierSplitsK2(items)) {
    const heavier = totalWeight(gA) >= totalWeight(gB) ? gA : gB;
    const lighter = totalWeight(gA) <  totalWeight(gB) ? gA : gB;
    if (heavier.length < 2) continue;
    // 3a. Tier sub-splits of heavier group
    for (const [h1, h2] of tierSplitsK2(heavier).slice(0, 3)) {
      candidates.push([lighter, h1, h2]);
    }
    // 3b. Even halving of heavier group (heaviest items first)
    const hSorted = [...heavier].sort((a, b) => effectiveWeight(b) - effectiveWeight(a));
    const mid = Math.ceil(hSorted.length / 2);
    candidates.push([lighter, hSorted.slice(0, mid), hSorted.slice(mid)]);
  }

  // 4. Random sampling to fill remaining budget
  const needed = Math.max(0, budget - candidates.length);
  for (let s = 0; s < needed * 5 && s < 3000; s++) {
    const shuffled = [...items].sort(() => Math.random() - 0.5);
    const n = items.length;
    const s1 = Math.floor(1 + Math.random() * (n - 2));
    const s2 = Math.floor(s1 + 1 + Math.random() * (n - s1 - 1));
    if (s2 < n) {
      candidates.push([
        shuffled.slice(0, s1),
        shuffled.slice(s1, s2),
        shuffled.slice(s2),
      ]);
    }
  }

  return candidates.filter((g) => g.every((grp) => grp && grp.length > 0));
}

// ── k=4 generator ────────────────────────────────────────────────────────────

/**
 * Generates smart k=4 candidates via three strategies:
 *  1. Round-robin assignment to lightest group (3 item orderings)
 *  2. Sub-split the heaviest group from top-scoring k=3 candidates
 *  3. Random sampling
 *
 * @param {Array} items
 * @param {number} budget
 * @returns {Array[][]}
 */
function smartFourWaySplits(items, budget) {
  if (items.length < 4) return [];
  const candidates = [];

  // 1. Round-robin (4 groups)
  for (const ordering of [
    [...items].sort((a, b) => effectiveWeight(b) - effectiveWeight(a)),
    [...items].sort((a, b) => effectiveWeight(a) - effectiveWeight(b)),
    [...items],
  ]) {
    const groups = [[], [], [], []];
    const sums   = [0, 0, 0, 0];
    for (const item of ordering) {
      const idx = sums.indexOf(Math.min(...sums));
      groups[idx].push(item);
      sums[idx] += effectiveWeight(item);
    }
    if (groups.every((g) => g.length > 0)) candidates.push(groups);
  }

  // 2. Sub-split heaviest group from top k=3 candidates
  const top3 = smartThreeWaySplits(items, 10)
    .map((g) => ({ score: scoreCandidate(g), groups: g }))
    .sort((a, b) => a.score - b.score)
    .slice(0, 8);

  for (const { groups: [gA, gB, gC] } of top3) {
    const sorted3 = [gA, gB, gC].sort((a, b) => totalWeight(b) - totalWeight(a));
    const heaviest = sorted3[0];
    const rest     = sorted3.slice(1);
    if (heaviest.length < 2) continue;
    // Even halving of the heaviest group
    const hSorted = [...heaviest].sort((a, b) => effectiveWeight(b) - effectiveWeight(a));
    const mid = Math.ceil(hSorted.length / 2);
    candidates.push([...rest, hSorted.slice(0, mid), hSorted.slice(mid)]);
    // Tier-based split of heaviest group
    for (const [h1, h2] of tierSplitsK2(heaviest).slice(0, 2)) {
      candidates.push([...rest, h1, h2]);
    }
  }

  // 3. Random sampling
  for (let s = 0; candidates.length < budget * 2 && s < 3000; s++) {
    const shuffled = [...items].sort(() => Math.random() - 0.5);
    const n = items.length;
    const cuts = new Set([0, n]);
    while (cuts.size < 5) cuts.add(Math.floor(1 + Math.random() * (n - 1)));
    const sorted_cuts = [...cuts].sort((a, b) => a - b);
    const groups = [];
    for (let i = 0; i < sorted_cuts.length - 1; i++) {
      groups.push(shuffled.slice(sorted_cuts[i], sorted_cuts[i + 1]));
    }
    if (groups.length === 4 && groups.every((g) => g.length > 0)) candidates.push(groups);
  }

  return candidates.filter((g) => g.every((grp) => grp && grp.length > 0));
}

// ── Main candidate generator ──────────────────────────────────────────────────

/**
 * Generates up to MAX_CANDIDATES (100) parcel split candidates.
 *
 * @param {import('./types').WarehouseItem[]} items
 * @param {{ maxPackages?: number }} [options]
 *   maxPackages: 1-4, defaults to 2.
 * @returns {import('./types').ParcelCandidate[]}
 */
function generateCandidates(items, options = {}) {
  const maxPackages = Math.min(Math.max(Math.floor(options.maxPackages) || 2, 1), 4);
  const budget      = MAX_CANDIDATES - 1; // slots for non-baseline candidates

  if (items.length === 0) return [];
  if (items.length === 1) {
    return [{ label: candidateLabel([items]), itemGroups: [items] }];
  }

  // Slot budget per k level
  let k2Budget, k3Budget, k4Budget;
  if (maxPackages === 2) {
    k2Budget = budget; k3Budget = 0; k4Budget = 0;
  } else if (maxPackages === 3) {
    k2Budget = Math.floor(budget * 0.55);
    k3Budget = budget - k2Budget;
    k4Budget = 0;
  } else {
    k2Budget = Math.floor(budget * 0.42);
    k3Budget = Math.floor(budget * 0.35);
    k4Budget = budget - k2Budget - k3Budget;
  }

  const result  = [];  // { score, itemGroups, label }
  const seenSet = new Set();

  function addCandidate(itemGroups, score) {
    if (itemGroups.some((g) => !g || g.length === 0)) return;
    const key = candidateKey(itemGroups);
    if (seenSet.has(key)) return;
    seenSet.add(key);
    result.push({ score, itemGroups, label: candidateLabel(itemGroups) });
  }

  /**
   * Scores a list of [groupA, groupB, ...] arrays, deduplicates, and adds the
   * top `limit` by score (lower = better) to `result`.
   */
  function pushBest(groupsList, limit) {
    const scored = [];
    for (const g of groupsList) {
      if (!Array.isArray(g) || !g.every((grp) => Array.isArray(grp) && grp.length > 0)) continue;
      const key = candidateKey(g);
      if (seenSet.has(key)) continue;
      scored.push({ score: scoreCandidate(g), key, itemGroups: g });
    }
    scored.sort((a, b) => a.score - b.score);
    let added = 0;
    for (const { score, key, itemGroups } of scored) {
      if (added >= limit) break;
      if (seenSet.has(key)) continue; // guard against duplicates within scored list
      seenSet.add(key);
      result.push({ score, itemGroups, label: candidateLabel(itemGroups) });
      added++;
    }
  }

  // k=1: Baseline (always index 0, always simulated)
  addCandidate([items], scoreCandidate([items]));

  // k=2
  if (items.length >= 2) {
    pushBest(
      [
        ...tierSplitsK2(items).map(([a, b]) => [a, b]),
        ...allTwoWaySplits(items).map(([a, b]) => [a, b]),
      ],
      k2Budget
    );
  }

  // k=3
  if (maxPackages >= 3 && items.length >= 3 && k3Budget > 0) {
    pushBest(smartThreeWaySplits(items, k3Budget * 4), k3Budget);
  }

  // k=4
  if (maxPackages >= 4 && items.length >= 4 && k4Budget > 0) {
    pushBest(smartFourWaySplits(items, k4Budget * 4), k4Budget);
  }

  // Baseline at index 0, rest sorted by ascending estimated cost
  const [baseline, ...rest] = result;
  rest.sort((a, b) => a.score - b.score);
  return [baseline, ...rest].map(({ label, itemGroups }) => ({ label, itemGroups }));
}

// ── Duration estimate ─────────────────────────────────────────────────────────

/**
 * Estimates the number of candidates that will be generated for `n` items.
 * Mirrors the slot-budget logic in generateCandidates without running the full algo.
 * @param {number} n            - number of selected items
 * @param {number} maxPackages  - 1-4
 * @returns {number}
 */
function estimateCandidateCount(n, maxPackages) {
  if (n === 0) return 0;
  if (n === 1) return 1;
  const budget = MAX_CANDIDATES - 1;
  let k2Budget, k3Budget, k4Budget;
  if (maxPackages === 2) {
    k2Budget = budget; k3Budget = 0; k4Budget = 0;
  } else if (maxPackages === 3) {
    k2Budget = Math.floor(budget * 0.55); k3Budget = budget - k2Budget; k4Budget = 0;
  } else {
    k2Budget = Math.floor(budget * 0.42); k3Budget = Math.floor(budget * 0.35); k4Budget = budget - k2Budget - k3Budget;
  }
  // Actual 2-way count (exact for n≤18, approximate for larger)
  const k2Actual = n <= 18 ? Math.pow(2, n - 1) - 1 : 3000;
  const k2Count  = Math.min(k2Budget, k2Actual);
  const k3Count  = maxPackages >= 3 && n >= 3 ? k3Budget : 0;
  const k4Count  = maxPackages >= 4 && n >= 4 ? k4Budget : 0;
  return 1 + k2Count + k3Count + k4Count;
}

/**
 * Formats a candidate count into a human-readable duration string.
 * @param {number} candidateCount
 * @returns {string}
 */
function formatDuration(candidateCount) {
  const secs = candidateCount * SECONDS_PER_CANDIDATE;
  if (secs < 90) return `~${Math.ceil(secs / 10) * 10} Sek.`;
  return `~${Math.ceil(secs / 60)} Min.`;
}

// ── Legacy direct-simulation path ─────────────────────────────────────────────

/**
 * Kept for compatibility — the tab-based flow in content.js bypasses this.
 */
async function runOptimization(items, agentConfig, simulateCandidate, onProgress, cancelToken, onLog) {
  const log = onLog || (() => {});
  const candidates = generateCandidates(items);
  const results    = [];
  let baseline     = null;

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

    if (result.skipped) log("warn", `   ↳ Übersprungen`);
    else log("info", `   ↳ Gesamt: $${result.totalPrice.toFixed(2)}`);

    if (i === 0) baseline = result;
  }

  onProgress(candidates.length, candidates.length, null);

  const valid = results.filter((r) => !r.skipped && r.totalPrice > 0);
  valid.sort((a, b) => a.totalPrice - b.totalPrice);

  const topThree = valid.slice(0, 3);
  const savings  = baseline && !baseline.skipped && topThree.length > 0
    ? baseline.totalPrice - topThree[0].totalPrice
    : 0;

  return { results, baseline, topThree, savings };
}

if (typeof module !== "undefined") {
  module.exports = { generateCandidates, runOptimization, totalWeight, estimateCandidateCount, formatDuration };
}

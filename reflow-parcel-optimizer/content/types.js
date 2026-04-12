/**
 * ReFlow Parcel Optimizer — Shared Type Definitions (JSDoc)
 *
 * @typedef {Object} Dimensions
 * @property {number} length - in cm
 * @property {number} width  - in cm
 * @property {number} height - in cm
 *
 * @typedef {Object} WarehouseItem
 * @property {string}      id           - Internal ID or order number
 * @property {string}      name         - Product name
 * @property {number}      weight       - Weight in grams
 * @property {Dimensions}  dimensions   - Dimensions in cm
 * @property {number}      quantity     - Quantity
 * @property {string}      category     - e.g. "Common Goods", "Common Brand", "Sensitive"
 * @property {Element}     checkboxRef  - DOM reference to the item's checkbox
 * @property {string}      [thumbnailUrl]
 *
 * @typedef {Object} ShippingLine
 * @property {string}   name             - e.g. "JD-DHL-DE(Economy)"
 * @property {number}   price            - in USD
 * @property {string}   currency         - "USD"
 * @property {string}   estimatedDays    - e.g. "9-16"
 * @property {string[]} features         - ["Insurance Available", "Tax free", ...]
 *
 * @typedef {Object} ParcelCandidate
 * @property {string}             label      - Human readable label, e.g. "2-Split: 4.9kg + 3.1kg"
 * @property {WarehouseItem[][]}  itemGroups - Each inner array is one parcel
 *
 * @typedef {Object} SimGroupResult
 * @property {WarehouseItem[]} items
 * @property {ShippingLine}    cheapestLine
 * @property {ShippingLine[]}  allLines
 *
 * @typedef {Object} SimulationResult
 * @property {ParcelCandidate}   candidate
 * @property {SimGroupResult[]}  groups
 * @property {number}            totalPrice
 * @property {boolean}           [skipped]  - true if simulation failed/timed out
 *
 * @typedef {Object} OptimizationResult
 * @property {SimulationResult[]} results
 * @property {SimulationResult}   baseline    - All items in 1 parcel
 * @property {SimulationResult[]} topThree    - Sorted by totalPrice ascending
 * @property {number}             savings     - baseline.totalPrice - topThree[0].totalPrice
 */

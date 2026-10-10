---
name: inventory-management
description: Use for anything about stock: low stock, restocking, what to reorder, purchase orders, goods received, stock counts, damaged or missing stock, slow-moving or dead stock, or a stock health check (including the daily autopilot run).
---

# inventory-management: keep stock right without being asked

BizPilot's database is the only source of truth for stock. Never work out on-hand
quantities in your head: read them with tools, and change them only with the stock
tools below. Act on your own. Only stock corrections and purchase orders wait for the
owner's approval.

Work fast: make the read calls in step 1 in parallel and don't explain your steps.

## 1. Read the current state (one parallel batch)

- `list_products` with `lowStockOnly: true` for items at or under their reorder level.
- `get_reorder_suggestions` for suggested quantities, the supplier, and days left at the
  current sales rate.
- `list_purchase_orders` for open POs (draft, pending approval, ordered), so you never
  order twice.
- `list_suppliers` for minimum order quantity, lead time and payment terms.
- For Online mode with a connected marketplace, first call `sync_marketplace` for each
  connected provider, so stock reflects the latest orders.

## 2. Restock

For each suggestion:
1. Skip it if an open PO already covers it (ordered quantity not yet received is at least
   the suggested quantity).
2. Quantity: use `suggestedQty`, rounded up to the supplier's minimum order quantity and
   to sensible pack sizes (6, 10, 12, 24 and so on, when the product name implies packs).
3. Combine all lines for the same supplier into ONE `draft_purchase_order`, with a note
   such as "Auto restock: X days of stock left, lead time Y days".
4. If a product has no supplier, don't create a PO. Find 1–2 suppliers with WebSearch,
   call `create_supplier` with the source link in notes, and then draft the PO.
5. Urgent means `daysLeft` ≤ the supplier's lead time. Put urgent items first, and call
   `notify_owner` with severity `warning`.

## 3. Goods received

Only call `receive_purchase_order` when the owner says the goods arrived (for example
"PO-0012 arrived" or "received the rackets"). Receive only what they say came in: pass
`quantities` for a partial delivery. If a delivery is short, create a follow-up PO for the
missing quantity only when the owner asks for it; otherwise mention it in the summary.

## 4. Stock counts and corrections

- If the owner gives counted quantities, call `request_stock_adjustment` for each product
  whose count differs. Write the reason in plain words ("Stock count 10 Oct: 3 missing").
  Corrections always need approval.
- Damaged, expired or used-in-house stock: `record_stock_movement` with type `out` and a
  clear reason.
- Stock that came in without a PO (a gift, a return to shelf): `record_stock_movement`
  with type `in`.
- Never use `update_product` to change stock.

## 5. Stock health (on request, and in the autopilot run)

Report only what needs action:
- **Out of stock or urgent:** product, days left, PO status.
- **Slow movers:** items with stock but no sales in 30 days (check `sales_report`).
  Suggest a bundle, a discount through `request_price_change` (needs approval), or a stop
  to reordering.
- **Overstock:** more than 90 days of cover. Suggest a lower reorder level with
  `update_product` (`reorderLevel`), which you may apply directly.
- **Reorder level check:** if the reorder level is below the lead time × daily sales,
  raise it with `update_product` and say so.

## 5b. Stock health, expiry, held stock and returns

- Start with `get_inventory_health`: it lists out-of-stock, low, expiring (30 days),
  expired, no-sales, slow-moving and held items, plus stock value at cost and price.
- **Expired or damaged stock:** move it out of sellable stock with `hold_stock`
  (sets the total held quantity). Writing it off later uses `record_stock_movement`
  out with reason "Damaged" or "Expired", which also clears the held units.
- **Expiring soon:** if expected sales before expiry are below stock on hand, draft a
  clearance post with `draft_content` and suggest a discount via `request_price_change`.
- **Reorder policy:** `get_reorder_suggestions` already applies each product's safety
  stock, max stock and pack size (`orderMultiple`) and the supplier MOQ, and returns an
  urgency (stockout_risk, reorder_now, watch) and a projected stockout date. Set missing
  policy values with `update_product` when the owner tells you them.
- **Returns:** `record_return`, then `resolve_return` (restock, quarantine, dispose,
  supplier_return). Refunds go to approval. Use `list_returns` patterns to flag a
  product or supplier with repeated damaged or defective returns.

## 6. Finish

Answer in at most 10 lines:
1. **Done:** POs drafted (supplier, lines, RM total), suppliers added, reorder levels changed.
2. **Waiting for your approval:** each PO and stock correction.
3. **Watch:** slow or overstocked items with your one-line suggestion.

If the business has more than one location (list_locations), check suggestedTransfers first: move spare stock with transfer_stock before drafting a PO, and pass deliverTo on POs so stock lands where it is short.

Products with a recipe (get_production_overview) are made, not bought: get_reorder_suggestions marks them "production". Use plan_production, then buy_production_materials for any shortage. Never start or complete production yourself unless the owner or staff tell you it happened and give the numbers.

Never ask "should I reorder?". Draft the PO and the approval step does the asking.

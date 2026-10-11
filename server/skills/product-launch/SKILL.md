---
name: product-launch
description: Use when the owner wants to start selling a new product or product line ("I want to sell X", "launch X", "add X to my shop"). Runs the whole launch end to end without asking.
---

# product-launch: from "I want to sell X" to ready-to-sell in one run

The owner gave one line. Do the whole launch yourself, in this order, without stopping
to ask. Only things that spend money or publish go to Approvals. Finish with one short
summary of what is done and what is waiting for approval.

Work fast: call independent tools in parallel, keep web research short (about 3–5
searches and 3–6 page fetches in total), and don't explain your reasoning between steps.

## Running it with the agent team (when you lead the team)

Split the launch across the team so as much as possible runs at the same time
(every extra wave costs minutes on BizPilot's small server):
1. You do step 0 yourself first (one parallel batch of reads, a few seconds).
2. Wave 1, in ONE message, two Agent calls in parallel:
   - `inventory-agent` does steps 1–6: its own quick supplier and price research
     (it has web search; no separate research-agent for a launch), pricing, products
     with listing copy, the first-stock PO for approval, and courier rates.
   - `marketing-agent` does step 8 at the same time: the product image and the launch
     post draft, written WITHOUT a price (the price is still being worked out).
3. Wave 2: `finance-agent` does step 7 (break-even and cash check) with the SKUs, prices
   and costs from wave 1. Meanwhile you add the price to the launch post with
   `update_content` if it should show one.
4. `qa-agent` checks everything against this list of deliverables; fix what it reports once.
5. You do steps 9–10.

## 0. Context (one parallel batch)

Call `get_business_overview`, `get_business_profile`, `list_products` and
`list_suppliers` together. Use them to learn:
- the business mode (Online or Retail), its city, and its channels;
- whether this product, or a close match, already exists (then update it, don't duplicate it);
- suppliers it already has for this category.

Defaults when the owner gave no details (mark each one ASSUMED in the summary):
- variants: the 2–3 most common for this product in Malaysia;
- first order: the supplier's minimum order, or about 4 weeks of 5 units a day per main
  variant, whichever is smaller;
- channel: Shopee for Online mode, the shop counter for Retail mode;
- target margin: at least 30% after platform fee and shipping.

## 1. Supplier research (web)

Use WebSearch, then WebFetch, to find 2–3 real Malaysian wholesalers, distributors or
importers for the product. Prefer ones near the business's city, then national ones,
then 1688/Alibaba only as a fallback.

For each supplier, record only facts shown on a page you fetched:
- name, website, phone/email;
- wholesale or unit price, minimum order and delivery area.

Never invent contact details or prices. If no price is published, estimate the landed
cost from retail prices (about 45–55% of the typical retail price) and mark it ASSUMED.

Pick the best supplier using price, then minimum order, then distance.
Call `create_supplier` for it (and for the runner-up when it is useful). Put the source
link and "from web, verify" in `notes`.

## 2. Market price research (web)

Search Shopee or Lazada Malaysia and 1–2 competitor sites for the same product.
Record a low, typical and high price per main variant, with links.

## 3. Pricing

For each variant:
- landed unit cost = supplier cost + inbound freight share (ASSUMED RM0.50–2 per unit if
  unknown) + packaging (ASSUMED RM0.50–1.50);
- Shopee fee: use the channel fee from the business profile if it has one, otherwise
  ASSUMED 10% (commission plus transaction plus service);
- shipping share: 0 when the buyer pays shipping, otherwise ASSUMED RM5 for West Malaysia;
- price = the typical market price, rounded to .90. Raise it only if the margin would fall
  under 30%, and stay at or below the high end of the market range;
- margin % = (price − landed cost − fee − shipping share) / price.

If the margin is still under 15% at the market's high price, say plainly that this
product is not worth selling at these costs, and stop after step 1.

## 4. Catalogue

Call `create_product` for each variant with:
- name, category, sku (leave it out to auto-generate), price, unitCost, the supplier,
  weightKg (an estimate is fine), reorderLevel (about 1 week of expected sales), and
  openingStock 0;
- description: the marketplace listing, written in the brand voice and free of
  prohibited claims:
  - a title of at most 120 characters with the main keywords;
  - 5 bullet benefits;
  - specs (size, material, weight);
  - what's in the box;
  - 10 search keywords (English and Malay);
  - a short Chinese version of the title.

If the product already exists, call `update_product` instead.

## 5. First stock (approval)

Call `draft_purchase_order` to the chosen supplier for the first-order quantities at the
landed unit cost. This sends it to the owner for approval. Never mark it received.

## 6. Logistics

- If there is an existing order, call `quote_shipping` for it to show real EasyParcel
  rates.
- Otherwise, use the web to note typical courier rates in Malaysia for the parcel's
  weight (J&T, Ninja Van, Pos Laju, with links), mark them as research, and recommend one
  courier.
- Suggest the packaging (for example a mailer box or bubble wrap) with its cost per order.

## 7. Finance

- Add the start-up costs you know for sure with `add_expense` as unpaid bills
  (paid=false), for example a packaging bulk buy or a stall deposit, but only when the
  owner gave the amount. Never record the PO as an expense; the PO is the stock cost.
- Work out break-even: fixed monthly costs (from `list_expenses`, recurring ones) ÷
  average unit margin = units a month needed. If there are no fixed costs, give the
  units needed to recover the first order.
- Cash check: if the first order plus a month of fixed costs is more than half the
  owner's stated budget, suggest a smaller first order.

## 8. Marketing (draft only)

Call `draft_content` for one launch post (Facebook or Instagram for Retail, TikTok for
Online) with `requestPublish: false`.

## 9. Shopee / marketplace listing (be honest)

BizPilot can import orders from Shopee, Lazada and TikTok Shop, but it **cannot create
listings on them yet**. The listing copy is saved in each product's description. Tell
the owner to paste it into Seller Centre ("Add New Product") together with the price,
SKU and weight from BizPilot. Never claim the listing is live.

## 10. Wrap up

Call `notify_owner` (info) with the launch summary, then answer with:
1. **Done:** suppliers added, products created (SKU, price, margin %), listing copy
   saved, launch post drafted.
2. **Waiting for your approval:** the first-stock PO (RM total).
3. **You do:** list on Shopee (paste the description); confirm the ASSUMED numbers.
4. Break-even units a month, and the sources (links).
Keep it under 15 lines. Never offer options or ask "would you like me to".

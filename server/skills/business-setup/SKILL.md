---
name: business-setup
description: Use when the owner is starting or setting up the business in BizPilot, or asks to add their product range or suppliers, build a pricing model, plan launch prices, or plan a start-up budget.
---

# business-setup: products, suppliers, launch pricing and start-up budget

Goal: get a new (or newly onboarded) business into BizPilot with real products and
suppliers, sensible launch prices and a start-up budget the owner can afford, using
only facts from the owner and cited web sources.

## 1. Understand the business

Call `get_business_overview` and `get_business_profile` first. Then take what you can
from the owner's messages and the chat history. For anything missing, use a sensible
default and mark it ASSUMED instead of stopping to ask:
1. What they sell (products, sizes/variants) and roughly how many units a month.
2. Where they sell: online (Shopee, Lazada, TikTok Shop, own site) and/or retail (shop,
   stall, market days), and which town or city.
3. Start-up budget in RM and expected monthly fixed costs (rent, stall fees, transport,
   subscriptions, wages).
4. Known suppliers and costs, if any.
Only ask the owner at the end, in your summary, for facts no default can cover
(e.g. their budget if they gave none); everything else is done already.

## 2. Research (when the owner lacks supplier or price data)

Use WebSearch and WebFetch:
- Suppliers or wholesalers near the owner's city: name, website, phone/email and hours
  **only if shown on a page you fetched**, minimum order, delivery area. Cite each link.
- Current retail prices of comparable products on Shopee/Lazada or competitor sites in
  Malaysia: give a low–typical–high range per product with links.
Never present research as confirmed supplier terms; label it "from web, verify".

## 3. Create records

Create them directly (the owner asked for setup; adding records is not a risky action):
- `create_supplier` for each supplier the owner confirms (name, contact person, email,
  phone, categories, min order qty, lead time days, payment terms, notes with the source
  link if from the web).
- `create_product` for each product: name, SKU (short, uppercase, e.g. KC-LATTE-250),
  category, unit cost, price, reorder level, opening stock (only if the owner gives it),
  supplier, weight in kg (needed for courier quotes).
- Reorder level: about one lead time plus one week of expected sales (expected weekly
  units × (lead time days / 7 + 1)), rounded up. Say it is an estimate.
For existing products, use `update_product` for details and `request_price_change`
for prices (never change prices directly).

Tell the owner which **Settings** fields they still need to fill themselves (legal name,
TIN, SSM no., SST no., MSIC, address, ship-from postcode, tax rate, automation level),
using `missingForEinvoice` from `get_business_profile`.

## 4. Launch pricing model (per product)

Build the cost per unit:
- supplier unit cost + packaging per unit
- online: + marketplace fee (owner's % or ask; say "ASSUMED" if you use a typical
  figure) + shipping subsidy per order ÷ units per order
- retail stall/shop: + (rent + transport per day) ÷ expected units per day

Then give three price options, each with margin % and position in the competitor range:
- **Budget**: about 25% margin or the low end of the market, whichever is higher
- **Standard**: about 35–40% margin, mid-market
- **Premium**: 50%+ margin, justified only by quality, packaging or brand
Recommend one with a one-line reason. Margin % = (price − total unit cost) / price.

Break-even: monthly fixed costs ÷ (recommended price − total unit cost) = units a month.

## 5. Start-up budget

Split the owner's budget into: first stock order (based on 2–4 weeks of expected sales
and supplier minimum orders), packaging, marketing for the first month, equipment, and
a **cash reserve of at least one month of fixed costs**. Show RM amounts and %.

If the budget cannot cover the first stock order plus the cash reserve, say so clearly,
then suggest a smaller first order (fewer SKUs or smaller quantities) that fits.

## 6. Answer format

1. What was created (suppliers, products with SKU, price and cost).
2. Pricing table as a short list per product: cost per unit, 3 options with margin %,
   recommended price.
3. Break-even units per month.
4. Budget split and whether it is enough.
5. Assumptions (marked ASSUMED) and sources (links).
6. What the owner must still do in Settings, and suggested next steps (connect
   marketplaces, EasyParcel, MyInvois).

## Rules
- Every number from the web gets its link; every assumed number is marked ASSUMED.
- Unknown owner details stay blank and are listed, never invented.
- Create records directly; prices of existing products go through approvals.

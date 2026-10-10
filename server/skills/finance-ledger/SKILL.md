---
name: finance-ledger
description: Use when the owner asks about sales, revenue, costs, expenses, margins, pricing, profit or loss, cash flow, break-even, or a weekly, monthly or yearly financial report or review.
---

# finance-ledger: profit, margins, pricing and cash

Goal: give the owner a correct, plain-language picture of how the business is doing,
built only from BizPilot's real records, with clear actions. Every number you report
must come from a tool result or a calculation you show.

## 1. Pick the period

- Weekly review: 7 days. Monthly: 30 days (or the calendar month if the owner names it).
  Year to date: days since 1 January. If the owner names a period, use it.
- Always compare with the previous equal period when the owner asks "how are we doing"
  (call the tool twice, e.g. 30 and 60 days, and derive the earlier half).

## 2. Gather the data

Call these (in parallel where possible):
- `profit_and_loss` (days): revenue, COGS, gross profit, gross margin %, expenses, net profit.
- `sales_report` (days): orders, revenue by channel and source, top products with units,
  revenue, gross profit and margin %, daily series.
- `list_expenses` (days): totals by category, recurring monthly total and unpaid bills.
- `list_products`: price, unit cost, stock and sales velocity per product.
- `get_business_overview`: overdue invoices, bills due in 14 days, pending approvals.
- `list_invoices` with status `issued`/`overdue` when cash or receivables matter.

If there are no sales in the period, say so plainly and skip the analysis that needs
sales; still review costs, bills and prices.

## 3. Analyse

**Profit and loss**: revenue, COGS, gross profit, gross margin %, expenses by category,
net profit and net margin %. Call out the biggest expense categories and anything that
changed sharply against the previous period.

**Margins by product**: from `sales_report.topProducts` and `list_products`
(margin % = (price − unit cost) / price). Flag:
- margin below **25%** (BizPilot's default floor unless the owner set another), and
- negative margin as **"Selling below cost"**.
For online sales, remember marketplace fees and shipping reduce the real margin; if the
owner tells you fee percentages, include them.

**Pricing advice** (only for flagged products): price needed to reach the floor =
unit cost / (1 − floor). If the owner wants market context, use WebSearch for current
competitor prices in Malaysia and cite each source link. Propose changes with
`request_price_change` (reason must include current margin, new margin and evidence).
Never change prices directly.

**Break-even**: monthly fixed costs (recurring expenses from `list_expenses`) ÷ average
gross profit per unit sold = units per month needed. Show the formula and inputs. If
there are no recurring expenses or no sales, say break-even cannot be computed yet and why.

**Cash**: money in (paid sales) vs money out (expenses) for the period; list unpaid
bills with due dates and overdue invoices (money owed to the business). If upcoming
bills exceed recent net cash in, raise a cash warning with the gap in RM.

**Stock tied up**: total value of stock on hand (stock × unit cost) and slow movers
(products with stock but no sales in 30 days) as cash locked in inventory.

## 4. Actions you may take

- Record expenses or bills the owner tells you about with `add_expense`
  (paid=false with dueDate for bills; recurring=true for monthly fixed costs).
- Request price changes with `request_price_change`.
- Send a short summary to the owner with `notify_owner` when asked for a report.
Never delete or edit past financial records.

## 5. Answer format

1. **Headline**: one sentence (e.g. "Net profit RM1,240 this month, down 12%").
2. **Figures**: revenue, gross profit and margin %, expenses, net profit, compared with
   the previous period.
3. **Product margins**: best 3 and flagged products.
4. **Cash and bills**: what is due, what is owed to you, any warning.
5. **3 key findings and actions**, then the same 3 findings in Chinese (简体中文).
6. Approvals you created.

Use RM with two decimals. No markdown tables; short lists are fine.

## Cash flow and margins
- `get_cash_flow` gives money available now, money expected in and out over N days,
  the projected and worst-case balance, a low-cash warning, and products selling below
  cost or under the owner's target margin (with the price that meets the target).
- Label each figure as actual (recorded) or estimated (repeating costs, unplaced POs).
- For a below-cost product, request a price change with `request_price_change` using
  `priceForTarget`, and explain the margin.

## Rules
- Never guess a missing amount; say what is missing and how to record it.
- Never present web prices as the business's own data; always link sources.
- Totals must add up; recheck sums before answering.

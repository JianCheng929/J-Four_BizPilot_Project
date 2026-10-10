---
name: einvoice-prep
description: Use when the owner asks to create, issue, fix, check or submit an invoice or LHDN MyInvois e-invoice, invoice paid orders, prepare a consolidated e-invoice for the month, or check whether the business is ready for e-invoicing.
---

# einvoice-prep: invoices and LHDN MyInvois e-invoices

Goal: every sale that needs an invoice gets a correct draft invoice in BizPilot, the
owner approves issuing it, and (when the owner wants) it is submitted to LHDN MyInvois
through an approval. You prepare and check; the owner approves; BizPilot submits.

## 1. Check readiness first (every time)

1. Call `get_business_profile`. If `missingForEinvoice` is not empty, list the missing
   fields and tell the owner to fill them in **Settings → Business profile**. You may still
   create draft invoices, but do not request e-invoice submission until they are filled.
2. Call `get_business_overview` and look at `integrations`: if `myinvois` is not ready,
   say e-invoices can be drafted but not submitted until MyInvois is connected in
   **Settings → Integrations** (sandbox first, then production).
3. Tax: use the business's `defaultTaxRatePct` only if the business has an SST number
   (`sstNo` not empty and not "NA"). If it is not SST-registered, tax rate is 0. Never
   invent a tax rate.

## 2. Work out what needs invoicing

Depending on the request:

- **A named customer or order**: find it with `list_orders` (by status/source) and check
  its `invoiceId`. If it already has an invoice, use `get_invoice` and work on that one
  instead of creating a duplicate.
- **"Invoice my paid orders" / weekly run**: `list_orders` with a generous limit, keep
  orders where `payment` is paid, status is not cancelled and `invoiceId` is empty.
  Default window: the last 7 days unless the owner says otherwise.
- **A custom invoice** (services, deposits, B2B quote turned into invoice): collect the
  buyer details and lines from the owner's message.

## 3. Buyer details (never invent)

Business (B2B) buyers need, for MyInvois: registered name, TIN, SSM/BRN (or NRIC /
passport for individuals), address, email and phone. If the owner gave a TIN and an ID,
you may validate it with `check_buyer_tin` (only when MyInvois is connected) and report
the result.

When the buyer is an individual who does not ask for an e-invoice, use the general
public TIN `EI00000000010` (the buyer is "General Public"). For a foreign buyer
without a Malaysian TIN, LHDN's guideline uses `EI00000000020`; mention that the owner
should confirm against LHDN's current e-Invoice guideline.

If any required buyer detail is missing, create the draft with what you have, list the
missing fields clearly in your answer, and do **not** request e-invoice submission for it.

## 4. Create the draft

Call `create_invoice`:
- From an order: pass `order` plus any buyer fields the order lacks (`customerTin`,
  `customerBrn`, `customerAddress`, `customerEmail`).
- Custom: pass `customerName`, buyer fields and `lines` (description, quantity,
  unitPrice, taxRate). Use clear line descriptions (product name, size/variant).
- `dueDays`: use what the owner says; default 14 for B2B, 0 for paid retail orders.

BizPilot numbers invoices automatically with the business's invoice prefix; never type
an invoice number yourself.

After creating, call `get_invoice` and check: subtotal = sum of lines, tax = subtotal ×
rate, total = subtotal + tax, buyer name present, no negative or zero-quantity lines.
Report any mismatch instead of hiding it.

## 5. Ask for approvals

- `request_invoice_issue` for each draft the owner wants sent (it is emailed to the
  buyer if email is connected).
- `request_einvoice_submit` only when: the business profile is complete, MyInvois is
  connected, and the buyer details are complete (or the buyer is General Public).
  Never claim an e-invoice was submitted or validated unless a tool result says so.

## 6. Consolidated e-invoice (month end)

If the owner asks about consolidating small B2C sales: sales to buyers who did not ask
for an e-invoice can be combined into one consolidated e-invoice for the month, issued
shortly after month end (LHDN's guideline gives the deadline; tell the owner to confirm
the current rule). Use `sales_report` / `list_orders` for the month's B2C paid orders,
summarise the count and total, and explain that consolidated submission is done in the
MyInvois portal if BizPilot cannot submit it.

## 7. Cancelling or correcting

A validated e-invoice can only be cancelled within LHDN's short cancellation window
(72 hours under the current guideline). After that, a credit or debit note is needed.
Explain this; do not change issued invoices yourself.

## Answer format

Finish with: invoices created (number, buyer, total), approvals waiting, invoices
blocked and exactly what is missing for each, and any readiness gaps (profile fields,
MyInvois connection).

## Rules
- Never invent buyer details, TINs, tax rates or amounts.
- Never include bank account numbers in invoices or messages.
- Legal validity comes from LHDN validation, not from a signature or logo.
- Money and submissions always go through approvals.

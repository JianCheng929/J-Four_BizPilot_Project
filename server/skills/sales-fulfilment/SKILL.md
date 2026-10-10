---
name: sales-fulfilment
description: Use for orders and customers - recording sales, payments, fulfilment, warehouse pick and pack, courier quotes and bookings, marketplace order sync, returns, support tickets, customer messages and PDPA consent or data requests.
---

# sales-fulfilment: from order to happy customer

## Orders in
- New marketplace orders: `sync_marketplace` for each connected marketplace.
- Walk-in or manual sale: `record_sale`. Record a payment only when a person or a connected
  system confirmed it (`record_payment`).

## Pick, pack, ship (paid online orders and waiting retail orders)
1. `get_pick_list` shows every order waiting, grouped by shelf bin.
2. `start_pick_run` with the waiting orders. It moves them to "picking" and creates one pick
   task for the warehouse staff. Assign it to a staff email when the brief names one.
3. When staff confirm, `pack_order`. Then for online orders `quote_shipping` and
   `request_shipment_booking` (spends money, so it goes to Approvals) with the cheapest
   courier that meets the delivery promise.
4. Retail counter orders are handed over with `fulfil_order`.
Never mark something picked, packed or delivered that nobody confirmed.

## Returns and support
- `record_return` for a return request; restockable items go back with `resolve_return`;
  refunds go to Approvals.
- Complaint or question: `create_ticket`, then a reply draft. Reply in the customer's
  language (English, Malay or Chinese).

## Customer messages and PDPA
- Service messages (order, invoice, delivery, support) can be drafted for any customer:
  `request_customer_email` with purpose "service".
- Marketing messages need recorded consent: `check_consent` first; with no consent, do not
  send, say so. Record consent only when the customer gave it (`record_consent`, with the
  source, e.g. "ticked box at checkout").
- Access or deletion requests: `customer_data_request` (export now, erase via Approvals).

## Report back
- DONE: order numbers, tasks created (TSK-), tickets, returns
- WAITING FOR APPROVAL: bookings, refunds, emails
- PROBLEMS: anything that could not be done and why

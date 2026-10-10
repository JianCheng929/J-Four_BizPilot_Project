import * as ops from '../../../src/lib/ops.ts';
import { supabaseAdmin } from './supabase.ts';
import { readSnapshot, withBusiness } from './workspace.ts';

const ACTOR = 'BizPilot scheduler';
let warned = false;

/**
 * Daily billing jobs (blueprint D5): make due copies of repeating invoices
 * (each waits in Approvals to be issued), mark late invoices overdue and
 * expire old quotations. Deterministic code, not the AI.
 */
async function tick() {
  const { data, error } = await supabaseAdmin().from('invoices').select('business_id').not('recurrence', 'is', null).limit(1000);
  if (error) {
    // The recurrence column comes from industrial.sql; until it is run there is nothing to do.
    if (!warned) console.log(`Recurring invoices off: ${error.message}`);
    warned = true;
    return;
  }
  const today = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10); // Malaysia date
  for (const businessId of new Set((data ?? []).map((r: { business_id: string }) => r.business_id))) {
    try {
      const snap = await readSnapshot(businessId);
      if (!snap.invoices.some((i) => i.recurrence?.active && i.recurrence.nextDate <= today)) continue;
      const made = await withBusiness(businessId, (db) => {
        ops.refreshOverdue(db);
        ops.refreshExpiredQuotations(db);
        return ops.runRecurringInvoices(db, ACTOR, today).map((i) => i.invoiceNumber);
      });
      if (made.length) console.log(`Recurring invoices for ${businessId}: ${made.join(', ')}`);
    } catch (e) {
      console.error('Recurring invoices failed', businessId, (e as Error).message);
    }
  }
}

export function startBilling() {
  const run = () => void tick().catch((e) => console.error('Billing:', (e as Error).message));
  setTimeout(run, 2 * 60_000);
  setInterval(run, 60 * 60_000);
}

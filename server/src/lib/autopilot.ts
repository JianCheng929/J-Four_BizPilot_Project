import { supabaseAdmin } from './supabase.ts';
import { settingsFromBusiness, type BusinessRow } from '../../../src/lib/db/remote.ts';
import { isBusinessBusy, startTask } from '../agent/runner.ts';
import { checkEngine } from '../agent/workbuddy.ts';

/**
 * Daily autopilot: WorkBuddy runs each business's routine operations by itself
 * once a day (after the owner's chosen hour, Malaysia time) and leaves the
 * result as a chat in Command Centre. Risky actions still go to Approvals.
 *
 * Render's free plan sleeps when idle, so the run happens at the first check
 * after the server is awake past that hour (see DEPLOY.md for keeping it awake).
 */

export const AUTOPILOT_PROMPT = `Daily autopilot run. The owner is not watching: do everything yourself, in this order, and skip any step whose integration is not connected (just note it):
1. Sync orders and reviews from every connected marketplace (sync_marketplace). If the owner's own website is connected, re-sync it with the website-import skill (new or changed products, stock and orders only). Then call get_signals and handle every item it lists, across all modules.
2. Stock: check reorder suggestions and draft purchase orders for anything running low.
3. Orders: for paid online orders awaiting fulfilment with an address, get courier quotes and request booking of the best option.
4. Reviews: draft replies for new reviews in the brand voice; escalate safety, fake-product or refund complaints.
5. Invoices: follow the einvoice-prep skill for paid orders without an invoice. Check get_receivables_payables and send_payment_reminder for overdue invoices that had no reminder in the last 7 days.
6. Finance: follow the finance-ledger skill for the last 7 days and flag margin, cash or bill problems.
7. Finish with notify_owner: a short briefing of what you did, what is waiting for approval, and the top 3 things for today.`;

const myt = (d = new Date()) => new Date(d.getTime() + 8 * 3_600_000); // Asia/Kuala_Lumpur, no DST

async function tick() {
  const now = myt();
  const date = now.toISOString().slice(0, 10);
  const hour = now.getUTCHours();
  const { data, error } = await supabaseAdmin().from('businesses').select('*');
  if (error) throw new Error(error.message);
  for (const row of (data ?? []) as BusinessRow[]) {
    const s = settingsFromBusiness(row);
    if (s.autopilot === false || hour < (Number.isFinite(s.autopilotHour) ? s.autopilotHour : 8)) continue;
    const conversationId = `autopilot-${date}`;
    const { count } = await supabaseAdmin().from('agent_tasks').select('id', { count: 'exact', head: true }).eq('business_id', row.id).eq('conversation_id', conversationId);
    if ((count ?? 0) > 0 || isBusinessBusy(row.id)) continue;
    if (!(await checkEngine()).online) return;
    console.log(`Autopilot: starting daily run for ${s.name || row.id}`);
    await startTask(row.id, AUTOPILOT_PROMPT, conversationId);
    return; // one run at a time on a small server; the next tick picks up the next business
  }
}

export function startAutopilot() {
  const run = () => void tick().catch((e) => console.error('Autopilot:', (e as Error).message));
  setTimeout(run, 60_000);
  setInterval(run, 5 * 60_000);
}

import { supabaseAdmin } from './supabase.ts';
import { settingsFromBusiness, type BusinessRow } from '../../../src/lib/db/remote.ts';
import { detectSignals, signalChatId, type Signal } from '../../../src/lib/signals.ts';
import { readSnapshot } from './workspace.ts';
import { hasRoomForBackground, startTask } from '../agent/runner.ts';
import { checkEngine } from '../agent/workbuddy.ts';

/**
 * The reactor: BizPilot acting on what happens in the business without being
 * asked (blueprint §25 observe → analyse → plan → act). Every few minutes it
 * reads each business's records, works out what needs attention
 * (src/lib/signals.ts, the same list the web app shows as "BizPilot noticed")
 * and starts WorkBuddy on each new `auto` signal, once per signal. Risky steps
 * still wait in Approvals; the agent ends each run with notify_owner.
 *
 * Off when the owner turns autopilot off or sets automation level 1.
 */

const EVERY_MS = 3 * 60_000;
const DAILY_CAP = 8; // agent runs per business per day started by the reactor

export function reactorPrompt(sig: Signal) {
  return `BizPilot noticed this by itself (the owner did not ask, and is not watching): ${sig.title}.
Evidence from the records: ${sig.evidence}

${sig.prompt}

Act now on your own with your tools. Do everything that needs no approval yourself; send the risky steps (money, prices, publishing, messages to customers or suppliers) to Approvals with the approval tools. Do the follow-on work in the other modules too. Keep it short and finish with notify_owner.`;
}

async function startedToday(businessId: string) {
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const { count } = await supabaseAdmin().from('agent_tasks').select('id', { count: 'exact', head: true })
    .eq('business_id', businessId).like('conversation_id', 'auto-%').gte('created_at', since);
  return count ?? 0;
}

async function alreadyHandled(businessId: string, conversationId: string) {
  const { count } = await supabaseAdmin().from('agent_tasks').select('id', { count: 'exact', head: true })
    .eq('business_id', businessId).eq('conversation_id', conversationId);
  return (count ?? 0) > 0;
}

async function tick() {
  if (!hasRoomForBackground()) return; // leave room for the owner's own goals
  const { data, error } = await supabaseAdmin().from('businesses').select('*');
  if (error) throw new Error(error.message);
  for (const row of (data ?? []) as BusinessRow[]) {
    const s = settingsFromBusiness(row);
    if (s.autopilot === false || (s.automationLevel ?? 2) < 2) continue;
    if ((await startedToday(row.id)) >= DAILY_CAP) continue;
    const db = await readSnapshot(row.id);
    for (const sig of detectSignals(db).filter((x) => x.auto)) {
      const conversationId = signalChatId(sig.key);
      if (await alreadyHandled(row.id, conversationId)) continue;
      if (!(await checkEngine()).online) return;
      console.log(`Reactor: ${s.name || row.id}: ${sig.title}`);
      await startTask(row.id, reactorPrompt(sig), conversationId);
      return; // one run at a time; the next tick picks up the next signal
    }
  }
}

export function startReactor() {
  const run = () => void tick().catch((e) => console.error('Reactor:', (e as Error).message));
  setTimeout(run, 90_000);
  setInterval(run, EVERY_MS);
}

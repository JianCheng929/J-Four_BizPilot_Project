import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { isSupabaseConfigured, supabaseAdmin } from './lib/supabase.ts';
import { publishDueContent } from './lib/execute.ts';
import { checkEngine } from './agent/workbuddy.ts';
import { integrations } from './routes/integrations.ts';
import { approvals } from './routes/approvals.ts';
import { sync } from './routes/sync.ts';
import { shipping } from './routes/shipping.ts';
import { einvoice } from './routes/einvoice.ts';
import { email } from './routes/email.ts';
import { agent } from './routes/agent.ts';
import { pos, tokens } from './routes/pos.ts';

const app = express();
const PORT = Number(process.env.PORT || 4000);
const origins = (process.env.APP_URL || 'http://localhost:5173').split(',').map((s) => s.trim());

app.use(cors({ origin: (origin, cb) => cb(null, !origin || origins.includes(origin) || /^http:\/\/localhost:\d+$/.test(origin)) }));
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => res.json({ ok: true, supabase: isSupabaseConfigured() }));

app.use('/api/integrations', integrations);
app.use('/api/approvals', approvals);
app.use('/api/sync', sync);
app.use('/api/shipping', shipping);
app.use('/api/einvoice', einvoice);
app.use('/api/email', email);
app.use('/api/agent', agent);
app.use('/api/tokens', tokens);
app.use('/api/pos', pos);

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

if (!isSupabaseConfigured()) {
  console.error('\n  Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in server/.env — see SUPABASE_SETUP.md\n');
}

app.listen(PORT, async () => {
  console.log(`BizPilot server on http://localhost:${PORT}`);
  checkEngine(true).then((h) =>
    console.log(h.online ? 'WorkBuddy engine: online' : `WorkBuddy engine: OFFLINE — ${h.error}\n  Run "npm run workbuddy:login" once in the server folder to sign BizPilot in to its WorkBuddy account.`),
  );
  if (!isSupabaseConfigured()) return;
  // Tasks interrupted by a restart can't resume.
  await supabaseAdmin().from('agent_tasks').update({ status: 'failed', result: 'Interrupted because the BizPilot server restarted.' }).in('status', ['starting', 'running', 'waiting_permission']);
  setInterval(() => void publishDueContent().catch((e) => console.error(e)), 60_000);
});

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { isSupabaseConfigured } from './lib/supabase.ts';
import { publishDueContent } from './lib/execute.ts';
import { startBilling } from './lib/billing.ts';
import { checkEngine, restoreLogin, saveLogin } from './agent/workbuddy.ts';
import { integrations } from './routes/integrations.ts';
import { approvals } from './routes/approvals.ts';
import { sync } from './routes/sync.ts';
import { shipping } from './routes/shipping.ts';
import { einvoice } from './routes/einvoice.ts';
import { email } from './routes/email.ts';
import { agent } from './routes/agent.ts';
import { pos, tokens } from './routes/pos.ts';
import { admin } from './routes/admin.ts';
import { media } from './routes/media.ts';
import { backups } from './routes/backups.ts';
import { startBackups } from './lib/backup.ts';
import { handOffRuns, resumeInterruptedTasks } from './agent/runner.ts';
import { startAutopilot } from './lib/autopilot.ts';
import { startReactor } from './lib/reactor.ts';
import { rateLimit } from './lib/ratelimit.ts';

const app = express();
const PORT = Number(process.env.PORT || 4000);
const origins = (process.env.APP_URL || 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim().replace(/\/+$/, ''))
  .filter(Boolean);
// The browser sends a Supabase bearer token (no cookies), so allowing the app's
// own Vercel deployments is safe; every API call is still authenticated.
const allowedOrigin = (o: string) =>
  origins.includes(o) || /^http:\/\/localhost:\d+$/.test(o) || /^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(o);

app.use(cors({ origin: (origin, cb) => cb(null, !origin || allowedOrigin(origin)) }));
// Goals can carry the owner's photos and documents (already shrunk in the browser).
app.use('/api/agent/tasks', express.json({ limit: '16mb' }));
app.use(express.json({ limit: '1mb' }));
// Render sits behind one proxy; trust it so req.ip is the caller's address.
app.set('trust proxy', 1);
app.use('/api', rateLimit({ name: 'api', windowMs: 60_000, max: 300, key: (req) => req.ip ?? 'unknown' }));
app.use('/admin', rateLimit({ name: 'admin', windowMs: 15 * 60_000, max: 600, key: (req) => req.ip ?? 'unknown' }));

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
app.use('/api/media', media);
app.use('/api/backups', backups);
app.use('/admin', admin);

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

if (!isSupabaseConfigured()) {
  console.error('\n  Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in server/.env — see SUPABASE_SETUP.md\n');
}

const httpServer = app.listen(PORT, async () => {
  console.log(`BizPilot server on http://localhost:${PORT}`);
  // Cloud disks are wiped on restart: put the saved WorkBuddy login back before first use.
  await restoreLogin().catch((e) => console.error(e));
  // Check the sign-in a little later, so a goal sent right after a wake-up gets the CPU first.
  setTimeout(() => void checkEngine().then((h) =>
    console.log(h.online ? 'WorkBuddy engine: online' : `WorkBuddy engine: OFFLINE — ${h.error}\n  Sign it in at /admin/workbuddy on this server (or "npm run workbuddy:login" locally).`),
  ), 3 * 60_000);
  // Render's free plan sleeps after 15 idle minutes and takes about a minute to wake.
  // Ping our own public address so the first goal (and the daily autopilot) never waits for that.
  const self = process.env.KEEP_AWAKE_URL || process.env.RENDER_EXTERNAL_URL;
  if (self && process.env.KEEP_AWAKE !== 'off') {
    setInterval(() => void fetch(`${self.replace(/\/$/, '')}/health`).catch(() => undefined), 10 * 60_000);
  }
  // Keep the stored copy current when the runtime refreshes its token.
  setInterval(() => void saveLogin().catch((e) => console.error(e)), 5 * 60_000);
  if (!isSupabaseConfigured()) return;
  // Goals cut off by a restart or deploy continue by themselves (checked now and every 30 s).
  const resume = () => void resumeInterruptedTasks().catch((e) => console.error('resume', e));
  setTimeout(resume, 5_000);
  setInterval(resume, 30_000);
  setInterval(() => void publishDueContent().catch((e) => console.error(e)), 60_000);
  startAutopilot();
  startBilling();
  startReactor();
  startBackups();
});

// Render stops the old server on each deploy: hand running goals to the new one, then exit.
let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    httpServer.close();
    const done = () => process.exit(0);
    setTimeout(done, 8_000).unref();
    void handOffRuns().catch((e) => console.error(e)).finally(done);
  });
}

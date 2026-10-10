import { supabaseAdmin } from './supabase.ts';
import { TABLES } from '../../../src/lib/db/remote.ts';

/**
 * Daily backups (blueprint §17): every business's full records as one JSON file in
 * the private Supabase Storage bucket "backups" (<businessId>/<YYYY-MM-DD>.json).
 * Only this server can read the bucket; owners and managers download a copy
 * through /api/backups. The newest KEEP files are kept.
 */

const BUCKET = 'backups';
const KEEP = 30;

export async function backupBusiness(businessId: string): Promise<{ path: string; bytes: number }> {
  const admin = supabaseAdmin();
  const out: Record<string, unknown> = { backedUpAt: new Date().toISOString(), businessId };
  const { data: biz, error: bErr } = await admin.from('businesses').select('*').eq('id', businessId).maybeSingle();
  if (bErr) throw new Error(bErr.message);
  out.business = biz;
  for (const [key, cfg] of Object.entries(TABLES)) {
    const rows: unknown[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await admin.from(cfg.table).select('*').eq('business_id', businessId).range(from, from + 999);
      if (error) {
        if (cfg.optional) break; // table not created yet
        throw new Error(`${cfg.table}: ${error.message}`);
      }
      rows.push(...(data ?? []));
      if (!data || data.length < 1000) break;
    }
    out[key] = rows;
  }
  const body = Buffer.from(JSON.stringify(out));
  const path = `${businessId}/${new Date().toISOString().slice(0, 10)}.json`;
  const { error } = await admin.storage.from(BUCKET).upload(path, body, { contentType: 'application/json', upsert: true });
  if (error) throw new Error(/bucket/i.test(error.message) ? 'Backup storage is not set up: run supabase/industrial.sql.' : error.message);
  // Keep the newest KEEP backups.
  const { data: files } = await admin.storage.from(BUCKET).list(businessId, { limit: 200, sortBy: { column: 'name', order: 'desc' } });
  const old = (files ?? []).slice(KEEP).map((f) => `${businessId}/${f.name}`);
  if (old.length) await admin.storage.from(BUCKET).remove(old);
  return { path, bytes: body.length };
}

export async function listBackups(businessId: string) {
  const admin = supabaseAdmin();
  const { data, error } = await admin.storage.from(BUCKET).list(businessId, { limit: KEEP + 5, sortBy: { column: 'name', order: 'desc' } });
  if (error) throw new Error(error.message);
  return Promise.all((data ?? []).filter((f) => f.name.endsWith('.json')).map(async (f) => {
    const { data: s } = await admin.storage.from(BUCKET).createSignedUrl(`${businessId}/${f.name}`, 300, { download: `bizpilot-backup-${f.name}` });
    return { date: f.name.replace('.json', ''), bytes: (f.metadata as { size?: number } | null)?.size ?? null, url: s?.signedUrl ?? null };
  }));
}

async function tick() {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabaseAdmin().from('businesses').select('id');
  if (error) throw new Error(error.message);
  for (const { id } of (data ?? []) as { id: string }[]) {
    const { data: files } = await supabaseAdmin().storage.from(BUCKET).list(id, { search: today });
    if (files?.some((f) => f.name === `${today}.json`)) continue;
    await backupBusiness(id).catch((e) => console.error(`Backup ${id}:`, (e as Error).message));
  }
}

export function startBackups() {
  const run = () => void tick().catch((e) => console.error('Backups:', (e as Error).message));
  setTimeout(run, 5 * 60_000);
  setInterval(run, 60 * 60_000);
}

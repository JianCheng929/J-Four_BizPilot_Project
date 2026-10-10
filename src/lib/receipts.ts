import { getSupabase } from './db/supabase';

/** Receipts live in the private "receipts" bucket under <businessId>/; only members of the business can read them. */
const BUCKET = 'receipts';

export async function uploadReceipt(businessId: string, expenseId: string, file: File): Promise<string> {
  const supa = getSupabase();
  if (!supa) throw new Error('Supabase is not configured.');
  if (file.size > 10 * 1024 * 1024) throw new Error('Receipts must be under 10 MB.');
  if (!/^(image\/|application\/pdf)/.test(file.type)) throw new Error('Upload a photo or a PDF.');
  const ext = (file.name.split('.').pop() || (file.type === 'application/pdf' ? 'pdf' : 'jpg')).toLowerCase().replace(/[^a-z0-9]/g, '');
  const path = `${businessId}/${expenseId}-${Date.now()}.${ext}`;
  const { error } = await supa.storage.from(BUCKET).upload(path, file, { contentType: file.type, upsert: false });
  if (error) throw new Error(/bucket/i.test(error.message) ? 'Receipt storage is not set up yet: run supabase/industrial.sql.' : error.message);
  return path;
}

export async function openReceipt(path: string) {
  const supa = getSupabase();
  if (!supa) throw new Error('Supabase is not configured.');
  const { data, error } = await supa.storage.from(BUCKET).createSignedUrl(path, 300);
  if (error || !data) throw new Error(error?.message ?? 'Could not open the receipt.');
  window.open(data.signedUrl, '_blank', 'noopener');
}

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { DatabaseBackup, Download, Loader2 } from 'lucide-react';
import { api, post } from '@/lib/api';
import { useBizPilot } from '@/lib/store';
import { fmtDate } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { SectionCard } from './common';

interface Backup { date: string; bytes: number | null; url: string | null }

/** Blueprint §17: automatic daily backups kept for 30 days, downloadable by owners and managers. */
export function BackupsCard() {
  const { can } = useBizPilot();
  const [list, setList] = useState<Backup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { setList(await api<Backup[]>('/api/backups')); setError(null); } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { if (can.manage) void load(); }, [can.manage, load]);
  if (!can.manage) return null;
  const now = async () => {
    setBusy(true);
    try { await post('/api/backups'); toast.success('Backup saved'); await load(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <SectionCard
      title="Automatic backups"
      description="BizPilot saves a full copy of your records every day and keeps the last 30, in private storage only the server can read. Download one any time."
      actions={<Button size="sm" variant="outline" disabled={busy} onClick={() => void now()}>{busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <DatabaseBackup className="mr-1 h-4 w-4" />} Back up now</Button>}
    >
      {error ? <div className="text-sm text-amber-700">{error}</div> : list === null ? <Loader2 className="h-4 w-4 animate-spin text-slate-400" /> : list.length === 0 ? (
        <div className="text-sm text-slate-500">No backups yet. The first one runs within the hour, or press "Back up now".</div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {list.slice(0, 10).map((b) => (
            <a key={b.date} href={b.url ?? undefined} className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-slate-50">
              <Download className="h-3.5 w-3.5" /> {fmtDate(b.date)}{b.bytes ? ` · ${Math.max(1, Math.round(b.bytes / 1024))} KB` : ''}
            </a>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

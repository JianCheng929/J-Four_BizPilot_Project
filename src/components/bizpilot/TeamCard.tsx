import { useCallback, useEffect, useState } from 'react';
import { Download, Loader2, Trash2, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { useBizPilot } from '@/lib/store';
import { getSupabase } from '@/lib/db/supabase';
import { TABLES } from '@/lib/db/remote';
import { productsToCsv } from '@/lib/csv';
import * as ops from '@/lib/ops';
import type { TeamMember, TeamRole } from '@/lib/db/types';
import { fmtDateTime } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Pill, SimpleSelect, SectionCard, primaryBtn } from './common';

const ROLE_HELP: Record<TeamRole, string> = {
  owner: 'Everything, including the team and deleting the business.',
  manager: 'Everything day to day, plus deciding approvals, settings and integrations.',
  staff: 'Sales, stock, suppliers, invoices, content and asking the AI. Cannot approve.',
  viewer: 'Can look at everything but change nothing.',
};

const ROLE_OPTIONS = (['manager', 'staff', 'viewer'] as const).map((r) => ({ value: r, label: r[0].toUpperCase() + r.slice(1) }));

/** Blueprint §13.10 / §17: staff, roles and permissions. */
export function TeamCard() {
  const { business, session, role, can, actor, run } = useBizPilot();
  const supa = getSupabase()!;
  const [members, setMembers] = useState<TeamMember[] | null>(null);
  const [missing, setMissing] = useState(false);
  const [email, setEmail] = useState('');
  const [newRole, setNewRole] = useState<TeamMember['role']>('staff');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await supa.from('business_members').select('*').eq('business_id', business.id).order('invited_at');
    if (error) {
      setMissing(/does not exist|schema cache/i.test(error.message));
      setMembers([]);
      return;
    }
    setMembers((data ?? []).map((r: Record<string, unknown>) => ({
      id: String(r.id), businessId: String(r.business_id), userId: (r.user_id as string) ?? null, email: String(r.email),
      role: r.role as TeamMember['role'], invitedBy: String(r.invited_by ?? ''), invitedAt: String(r.invited_at), acceptedAt: (r.accepted_at as string) ?? null,
    })));
  }, [supa, business.id]);

  useEffect(() => { void load(); }, [load]);

  const audit = (action: string, details: string) =>
    run((d, a) => ops.audit(d, a, action, 'team', business.id, details));

  const invite = async () => {
    const e = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return toast.error('Enter a valid email address.');
    if (e === session.user.email?.toLowerCase()) return toast.error('That is you, the owner.');
    setBusy(true);
    const { error } = await supa.from('business_members').insert({ business_id: business.id, email: e, role: newRole, invited_by: actor });
    setBusy(false);
    if (error) return toast.error(/duplicate/i.test(error.message) ? 'That person is already on the team.' : error.message);
    audit('invite', `Invited ${e} as ${newRole}`);
    toast.success(`Invited ${e}. They sign up at ${window.location.origin} with this email and land in your business.`);
    setEmail('');
    void load();
  };

  const changeRole = async (m: TeamMember, r: TeamMember['role']) => {
    const { error } = await supa.from('business_members').update({ role: r }).eq('id', m.id);
    if (error) return toast.error(error.message);
    audit('role_change', `${m.email}: ${m.role} → ${r}`);
    void load();
  };

  const remove = async (m: TeamMember) => {
    if (!window.confirm(`Remove ${m.email} from the team? They lose access straight away.`)) return;
    const { error } = await supa.from('business_members').delete().eq('id', m.id);
    if (error) return toast.error(error.message);
    audit('remove', `Removed ${m.email} (${m.role})`);
    void load();
  };

  return (
    <SectionCard title="Team and permissions" description={`You are the ${role}. ${ROLE_HELP[role]}`}>
      {missing ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50/60 px-4 py-3 text-sm">
          Run <code>supabase/industrial.sql</code> in the Supabase SQL Editor to turn on team roles.
        </div>
      ) : (
        <div className="space-y-4">
          {can.owner && (
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-56 flex-1">
                <Input type="email" placeholder="colleague@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
              <div className="w-36"><SimpleSelect value={newRole} onChange={(v) => setNewRole(v as TeamMember['role'])} options={ROLE_OPTIONS} /></div>
              <Button className={primaryBtn} disabled={busy} onClick={() => void invite()}>
                {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <UserPlus className="mr-1 h-4 w-4" />} Invite
              </Button>
            </div>
          )}
          <Table>
            <TableHeader>
              <TableRow><TableHead>Person</TableHead><TableHead>Role</TableHead><TableHead>Status</TableHead><TableHead /></TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell>{business.role === 'owner' ? session.user.email : 'Business owner'}</TableCell>
                <TableCell><Pill tone="teal">Owner</Pill></TableCell>
                <TableCell className="text-xs text-slate-500">Active</TableCell>
                <TableCell />
              </TableRow>
              {(members ?? []).map((m) => (
                <TableRow key={m.id}>
                  <TableCell>{m.email}</TableCell>
                  <TableCell className="w-36">
                    {can.owner ? <SimpleSelect size="sm" value={m.role} onChange={(v) => void changeRole(m, v as TeamMember['role'])} options={ROLE_OPTIONS} /> : <span className="capitalize">{m.role}</span>}
                  </TableCell>
                  <TableCell className="text-xs text-slate-500">{m.acceptedAt ? `Joined ${fmtDateTime(m.acceptedAt)}` : 'Invited, not signed up yet'}</TableCell>
                  <TableCell className="text-right">
                    {can.owner && (
                      <Button size="icon" variant="ghost" onClick={() => void remove(m)} aria-label={`Remove ${m.email}`}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {members === null && <TableRow><TableCell colSpan={4}><Loader2 className="mx-auto h-4 w-4 animate-spin" /></TableCell></TableRow>}
            </TableBody>
          </Table>
          <ul className="space-y-0.5 text-xs text-slate-500">
            {(['manager', 'staff', 'viewer'] as const).map((r) => <li key={r}><span className="font-medium capitalize text-slate-700">{r}:</span> {ROLE_HELP[r]}</li>)}
          </ul>
        </div>
      )}
    </SectionCard>
  );
}

/** Blueprint §19 "Users can export their own data": every record, straight from the database. */
export function DataExportCard() {
  const { business, db } = useBizPilot();
  const supa = getSupabase()!;
  const [busy, setBusy] = useState(false);

  const save = (name: string, text: string, type: string) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const exportAll = async () => {
    setBusy(true);
    try {
      const out: Record<string, unknown> = { exportedAt: new Date().toISOString(), business: { id: business.id, name: db.settings.name, settings: db.settings } };
      for (const [key, cfg] of Object.entries(TABLES)) {
        const rows: unknown[] = [];
        // Page through everything, not only what the app keeps in memory.
        for (let from = 0; ; from += 1000) {
          const { data, error } = await supa.from(cfg.table).select('*').eq('business_id', business.id).range(from, from + 999);
          if (error) throw new Error(`${cfg.table}: ${error.message}`);
          rows.push(...(data ?? []));
          if (!data || data.length < 1000) break;
        }
        out[key] = rows;
      }
      save(`bizpilot-export-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(out, null, 1), 'application/json');
      toast.success('Export downloaded');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SectionCard title="Export your data" description="Your records are yours. Download them any time.">
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={busy} onClick={() => void exportAll()}>
          {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Download className="mr-1 h-4 w-4" />} All records (JSON)
        </Button>
        <Button variant="outline" onClick={() => save(`bizpilot-products-${new Date().toISOString().slice(0, 10)}.csv`, productsToCsv(db), 'text/csv;charset=utf-8')}>
          <Download className="mr-1 h-4 w-4" /> Product catalogue (CSV)
        </Button>
      </div>
      <p className="mt-2 text-xs text-slate-500">The JSON file holds every table (products, stock movements, orders, invoices, expenses, suppliers, reviews, approvals, the full audit log and more). Sales reports export from Reports.</p>
    </SectionCard>
  );
}

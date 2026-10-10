import { useCallback, useEffect, useState } from 'react';
import { Bot, CheckCircle2, Copy, ExternalLink, KeyRound, Loader2, LogOut, RefreshCw, Trash2, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { useBizPilot } from '@/lib/store';
import { api, post, API_BASE } from '@/lib/api';
import type { BusinessSettings } from '@/lib/db/types';
import { PageHeader } from '@/components/layout/AppShell';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { fmtDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { DataExportCard, TeamCard } from '@/components/bizpilot/TeamCard';
import { TwoStepCard } from '@/components/bizpilot/TwoStep';
import { BackupsCard } from '@/components/bizpilot/BackupsCard';
import { openAgentChat } from '@/components/bizpilot/agentChat';

// ---------------------------------------------------------------- types from the server

interface WorkBuddyStatus {
  engine: string;
  connected: boolean;
  account: string | null;
  error: string | null;
}

interface IntegrationField {
  key: string;
  label: string;
  secret: boolean;
  placeholder: string;
  help: string;
  value: string;
  isSet: boolean;
  fromEnv: boolean;
}

interface Integration {
  id: string;
  label: string;
  category: string;
  description: string;
  docs: string;
  oauth: boolean;
  callbackUrl: string | null;
  fields: IntegrationField[];
  configured: boolean;
  connected: boolean;
  status: string;
  account: Record<string, unknown> | null;
  lastTestedAt: string | null;
  lastSyncAt: string | null;
  error: string | null;
}

interface ApiToken {
  id: string;
  name: string;
  token_hint: string;
  created_at: string;
  last_used_at: string | null;
}

const MARKETPLACES = ['shopee', 'lazada', 'tiktok_shop'];

const STATES: [string, string][] = [
  ['01', 'Johor'], ['02', 'Kedah'], ['03', 'Kelantan'], ['04', 'Melaka'], ['05', 'Negeri Sembilan'], ['06', 'Pahang'],
  ['07', 'Pulau Pinang'], ['08', 'Perak'], ['09', 'Perlis'], ['10', 'Selangor'], ['11', 'Terengganu'], ['12', 'Sabah'],
  ['13', 'Sarawak'], ['14', 'W.P. Kuala Lumpur'], ['15', 'W.P. Labuan'], ['16', 'W.P. Putrajaya'],
];

function F({ label, hint, children, className }: { label: string; hint?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('grid gap-1.5', className)}>
      <Label className="text-xs text-slate-600">{label}</Label>
      {children}
      {hint && <span className="text-[11px] text-slate-400">{hint}</span>}
    </div>
  );
}

// ---------------------------------------------------------------- WorkBuddy engine

/** Read-only: BizPilot runs on its own built-in WorkBuddy account. */
function WorkBuddyCard() {
  const [st, setSt] = useState<WorkBuddyStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (refresh = false) => {
    setBusy(true);
    try {
      setSt(await api<WorkBuddyStatus>(`/api/agent/status${refresh ? '?refresh=1' : ''}`));
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  return (
    <Card className="border-teal-200">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Bot className="h-4 w-4 text-teal-700" /> AI engine: WorkBuddy
          {st && (st.connected ? (
            <Badge className="bg-teal-100 text-teal-800 hover:bg-teal-100">Online</Badge>
          ) : (
            <Badge className="bg-red-100 text-red-700 hover:bg-red-100">Offline</Badge>
          ))}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-slate-600">
          BizPilot's AI agent is powered by WorkBuddy and is included with BizPilot; there is nothing to sign in to. When you give a goal
          in the Command Centre, WorkBuddy plans it, uses BizPilot's tools on your real records and sends anything risky to Approvals.
        </p>
        {err && <p className="rounded-md bg-red-50 p-2 text-xs text-red-700">{err}</p>}
        {st && !st.connected && (
          <p className="rounded-md bg-red-50 p-2 text-xs text-red-700">The AI engine is offline: {st.error ?? 'unknown error'}. The BizPilot administrator needs to fix this on the server.</p>
        )}
        <Button variant="ghost" size="sm" onClick={() => void load(true)} disabled={busy}>
          {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />} Check again
        </Button>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------- business profile

function ProfileForm() {
  const { db, updateSettings } = useBizPilot();
  const [s, setS] = useState<BusinessSettings>(db.settings);
  useEffect(() => setS(db.settings), [db.settings]);
  const set = <K extends keyof BusinessSettings>(k: K, v: BusinessSettings[K]) => setS((x) => ({ ...x, [k]: v }));
  const txt = (k: keyof BusinessSettings, label: string, hint?: string, placeholder?: string) => (
    <F label={label} hint={hint}>
      <Input value={String(s[k] ?? '')} placeholder={placeholder} onChange={(e) => set(k, e.target.value as never)} />
    </F>
  );
  const num = (k: keyof BusinessSettings, label: string, hint?: string) => (
    <F label={label} hint={hint}>
      <Input type="number" min={0} value={String(s[k] ?? 0)} onChange={(e) => set(k, Number(e.target.value) as never)} />
    </F>
  );
  const dirty = JSON.stringify(s) !== JSON.stringify(db.settings);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">Business</CardTitle></CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          {txt('name', 'Trading name')}
          <F label="Business type">
            <Select value={s.mode} onValueChange={(v) => set('mode', v as BusinessSettings['mode'])}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="online">Online</SelectItem>
                <SelectItem value="retail">Retail shop</SelectItem>
                <SelectItem value="hybrid">Online + retail</SelectItem>
              </SelectContent>
            </Select>
          </F>
          {txt('email', 'Business email')}
          {txt('phone', 'Phone', 'International format, e.g. +60123456789')}
          {txt('addressLine', 'Address', undefined, 'No. 1, Jalan …')}
          {txt('city', 'City')}
          {txt('postcode', 'Postcode')}
          <F label="State">
            <Select value={s.stateCode} onValueChange={(v) => set('stateCode', v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{STATES.map(([c, n]) => <SelectItem key={c} value={c}>{n}</SelectItem>)}</SelectContent>
            </Select>
          </F>
          {txt('shipFromPostcode', 'Ship-from postcode', 'Used for courier quotes. Defaults to the postcode above.')}
          <F label="Starting capital / modal (RM)" hint={`e.g. 1000. BizPilot manages your money from here: sales add to it, expenses and purchase orders take from it, and orders bigger than the money left are blocked.${s.openingCashDate ? ` Last set ${new Date(s.openingCashDate).toLocaleDateString()}.` : ''}`}>
            <Input type="number" min={0} step="0.01" value={String(s.openingCash ?? 0)} onChange={(e) => setS((x) => ({ ...x, openingCash: Number(e.target.value), openingCashDate: new Date().toISOString() }))} />
          </F>
          <F label="Target gross margin (%)" hint="Products below this margin are flagged in Finance → Pricing. Also the default in the pricing calculator.">
            <Input type="number" min={1} max={90} step="1" value={String(s.targetMarginPct ?? 30)} onChange={(e) => setS((x) => ({ ...x, targetMarginPct: Number(e.target.value) }))} />
          </F>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">Tax & e-Invoice (LHDN)</CardTitle></CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          {txt('legalName', 'Registered name (SSM)')}
          {txt('brn', 'SSM registration no.', 'New 12-digit format, e.g. 202301012345')}
          {txt('tin', 'Tax Identification No. (TIN)', 'e.g. C12345678090 or IG12345678090')}
          {txt('sstNo', 'SST registration no.', '"NA" if not registered')}
          {txt('msicCode', 'MSIC code', '5 digits, e.g. 47911 (retail sale via internet)')}
          {txt('msicDescription', 'MSIC description')}
          {num('defaultTaxRate', 'Default SST rate (%)', '0 if not SST-registered')}
          {txt('invoicePrefix', 'Invoice prefix')}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">AI agent & approvals</CardTitle></CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <F label="Automation level" className="sm:col-span-2">
            <Select value={String(s.automationLevel)} onValueChange={(v) => set('automationLevel', Number(v) as 1 | 2 | 3)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="1">1 · Assistant: WorkBuddy only analyses and recommends</SelectItem>
                <SelectItem value="2">2 · Co-pilot: WorkBuddy drafts, you approve every risky action</SelectItem>
                <SelectItem value="3">3 · Autopilot: low-risk routine actions under your limit run automatically</SelectItem>
              </SelectContent>
            </Select>
          </F>
          <F label="Daily autopilot" hint="WorkBuddy does the daily operations by itself (sync, restock, reviews, invoices, finance check) and leaves a report in Command Centre. Risky actions still wait for your approval.">
            <Select value={s.autopilot ? 'on' : 'off'} onValueChange={(v) => set('autopilot', v === 'on')}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="on">On</SelectItem>
                <SelectItem value="off">Off</SelectItem>
              </SelectContent>
            </Select>
          </F>
          {num('autopilotHour', 'Autopilot time (hour, 0-23)', 'Malaysia time. Default 8 = 8am.')}
          {num('approvalLimitAmount', 'Approval limit (RM)', 'Above this, actions are medium/high risk and never auto-run.')}
          {num('lowStockThresholdDays', 'Low-stock warning (days of stock)')}
          <F label="Brand voice" className="sm:col-span-2"><Textarea rows={2} value={s.brandVoice} onChange={(e) => set('brandVoice', e.target.value)} placeholder="Friendly, simple English with a little Manglish…" /></F>
          <F label="Target audience" className="sm:col-span-2"><Textarea rows={2} value={s.targetAudience} onChange={(e) => set('targetAudience', e.target.value)} /></F>
          <F label="Prohibited claims" hint="Comma separated. WorkBuddy refuses drafts that contain them." className="sm:col-span-2">
            <Textarea rows={2} value={s.prohibitedClaims} onChange={(e) => set('prohibitedClaims', e.target.value)} placeholder="cure, 100% guaranteed, halal (unless certified)…" />
          </F>
        </CardContent>
      </Card>

      <div className="sticky bottom-3 flex justify-end">
        <Button className="bg-teal-700 text-white shadow hover:bg-teal-800" disabled={!dirty} onClick={() => updateSettings(s)}>
          Save business profile
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- integrations

function IntegrationCard({ item, onChange }: { item: Integration; onChange: () => Promise<void> }) {
  const { reload } = useBizPilot();
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(item.fields.map((f) => [f.key, f.value])));
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const doing = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    try { await fn(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  };

  const save = () => api(`/api/integrations/${item.id}`, { method: 'PUT', body: JSON.stringify({ credentials: vals }) });

  const badge = item.connected
    ? { t: 'Connected', c: 'bg-teal-100 text-teal-800' }
    : item.status === 'error'
      ? { t: 'Error', c: 'bg-red-100 text-red-700' }
      : item.configured
        ? { t: item.oauth ? 'Needs authorisation' : 'Not tested', c: 'bg-amber-100 text-amber-800' }
        : { t: 'Not set up', c: 'bg-slate-200 text-slate-600' };

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm">{item.label}</CardTitle>
          <Badge className={cn('hover:bg-inherit', badge.c)}>{badge.t}</Badge>
        </div>
        <p className="text-xs text-slate-500">{item.description}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-2">
          {item.fields.map((f) => (
            <F key={f.key} label={f.label} hint={f.fromEnv ? 'Using value from server/.env' : f.help}>
              <Input
                type={f.secret ? 'password' : 'text'}
                autoComplete="off"
                value={vals[f.key] ?? ''}
                placeholder={f.secret && f.isSet ? '•••••••• saved (leave blank to keep)' : f.placeholder}
                onChange={(e) => setVals((v) => ({ ...v, [f.key]: e.target.value }))}
              />
            </F>
          ))}
        </div>
        {item.oauth && item.callbackUrl && (
          <p className="text-[11px] text-slate-500">
            Redirect / callback URL to register in the {item.label} developer console:{' '}
            <code className="rounded bg-slate-100 px-1">{item.callbackUrl}</code>
            <button className="ml-1 align-middle text-slate-400 hover:text-slate-700" onClick={() => { void navigator.clipboard.writeText(item.callbackUrl!); toast.success('Copied'); }}>
              <Copy className="inline h-3 w-3" />
            </button>
          </p>
        )}
        {item.account && <p className="text-xs text-slate-600">Account: {Object.values(item.account).filter((v) => v != null && v !== '').join(' · ')}</p>}
        {item.lastSyncAt && <p className="text-xs text-slate-500">Last sync {fmtDateTime(item.lastSyncAt)}</p>}
        {(result || item.error) && (
          <p className={cn('flex items-start gap-1 text-xs', result?.ok ? 'text-teal-700' : 'text-red-600')}>
            {result?.ok ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5" /> : <XCircle className="mt-0.5 h-3.5 w-3.5" />}
            {result?.message ?? item.error}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={!!busy} onClick={() => doing('save', async () => { await save(); toast.success('Saved'); await onChange(); })}>
            {busy === 'save' && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}Save
          </Button>
          {item.oauth ? (
            <Button size="sm" className="bg-teal-700 text-white hover:bg-teal-800" disabled={!!busy} onClick={() => doing('connect', async () => {
              await save();
              const { url } = await post<{ url: string }>(`/api/integrations/${item.id}/connect`);
              window.location.href = url;
            })}>
              {busy === 'connect' && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}{item.connected ? 'Reconnect' : 'Connect'} {item.label}
            </Button>
          ) : null}
          <Button size="sm" variant={item.oauth ? 'outline' : 'default'} className={item.oauth ? '' : 'bg-teal-700 text-white hover:bg-teal-800'} disabled={!!busy} onClick={() => doing('test', async () => {
            await save();
            const r = await post<{ ok: boolean; message: string; taskId?: string }>(`/api/integrations/${item.id}/test`);
            setResult(r);
            await onChange();
            if (r.taskId) { await reload(); openAgentChat(r.taskId); } // own website: the agent starts reading it
          })}>
            {busy === 'test' && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}Test connection
          </Button>
          {MARKETPLACES.includes(item.id) && item.connected && (
            <Button size="sm" variant="outline" disabled={!!busy} onClick={() => doing('sync', async () => {
              const r = await post<{ message: string }>(`/api/sync/${item.id}`);
              toast.success(r.message);
              await Promise.all([onChange(), reload()]);
            })}>
              {busy === 'sync' ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}Sync now
            </Button>
          )}
          {item.id === 'website' && item.connected && (
            <Button size="sm" variant="outline" disabled={!!busy} title="BizPilot reads your site again and brings in what's new" onClick={() => doing('import', async () => {
              const t = await post<{ id: string }>('/api/integrations/website/import');
              await reload();
              openAgentChat(t.id);
            })}>
              {busy === 'import' ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}Import again
            </Button>
          )}
          {(item.configured || item.connected) && (
            <Button size="sm" variant="ghost" className="text-red-600" disabled={!!busy} onClick={() => doing('remove', async () => {
              if (!window.confirm(`Remove saved ${item.label} credentials and tokens?`)) return;
              await api(`/api/integrations/${item.id}`, { method: 'DELETE' });
              setVals({});
              await onChange();
            })}>Remove</Button>
          )}
          <a href={item.docs} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 self-center text-xs text-slate-500 hover:text-teal-700">
            Docs <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </CardContent>
    </Card>
  );
}

function Integrations() {
  const [items, setItems] = useState<Integration[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setItems(await api<Integration[]>('/api/integrations')); setErr(null); } catch (e) { setErr((e as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (err) return <p className="rounded-md bg-red-50 p-3 text-sm text-red-700">{err}</p>;
  if (!items) return <p className="flex items-center gap-2 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading integrations…</p>;
  const cats = [...new Set(items.map((i) => i.category))];
  return (
    <div className="space-y-5">
      <p className="text-xs text-slate-500">Credentials are stored on the BizPilot server only and are never sent back to the browser.</p>
      {cats.map((c) => (
        <div key={c} className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{c}</h3>
          <div className="grid gap-3 lg:grid-cols-2">
            {items.filter((i) => i.category === c).map((i) => <IntegrationCard key={i.id} item={i} onChange={load} />)}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- POS tokens

function PosTokens() {
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [fresh, setFresh] = useState<string | null>(null);
  const [name, setName] = useState('Shop till 1');
  const load = useCallback(async () => { try { setTokens(await api<ApiToken[]>('/api/tokens')); } catch (e) { toast.error((e as Error).message); } }, []);
  useEffect(() => { void load(); }, [load]);

  const example = `curl -X POST ${API_BASE}/api/pos/sales \\
  -H "Authorization: Bearer ${fresh ?? 'bp_…'}" -H "Content-Type: application/json" \\
  -d '{"externalId":"till1-000123","paymentMethod":"cash","items":[{"sku":"YOUR-SKU","quantity":1}]}'`;

  return (
    <Card>
      <CardHeader className="pb-3"><CardTitle className="flex items-center gap-2 text-base"><KeyRound className="h-4 w-4" /> POS / barcode till connection</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-slate-600">Create a token for your POS system or till app. Each completed sale it posts is recorded and deducts stock straight away.</p>
        <div className="flex flex-wrap gap-2">
          <Input className="max-w-xs" value={name} onChange={(e) => setName(e.target.value)} />
          <Button className="bg-teal-700 text-white hover:bg-teal-800" onClick={async () => {
            try { const r = await post<{ token: string }>('/api/tokens', { name }); setFresh(r.token); await load(); } catch (e) { toast.error((e as Error).message); }
          }}>Create token</Button>
        </div>
        {fresh && (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs">
            Copy this token now; it won't be shown again: <code className="break-all font-mono">{fresh}</code>
            <button className="ml-1" onClick={() => { void navigator.clipboard.writeText(fresh); toast.success('Copied'); }}><Copy className="inline h-3 w-3" /></button>
          </div>
        )}
        {tokens.length > 0 && (
          <ul className="divide-y rounded-md border text-xs">
            {tokens.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-2 p-2">
                <span><b>{t.name}</b> <span className="font-mono text-slate-500">{t.token_hint}</span></span>
                <span className="text-slate-500">{t.last_used_at ? `used ${fmtDateTime(t.last_used_at)}` : 'never used'}</span>
                <Button size="icon" variant="ghost" className="h-7 w-7 text-red-600" onClick={async () => { await api(`/api/tokens/${t.id}`, { method: 'DELETE' }); await load(); }}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <pre className="overflow-x-auto rounded-md bg-slate-900 p-3 text-[11px] text-slate-100">{example}</pre>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------- page

export function Settings() {
  const { session, signOut, db } = useBizPilot();
  const retail = db.settings.mode === 'retail' || db.settings.mode === 'hybrid';
  const [tab, setTab] = useState(() => {
    if (new URLSearchParams(window.location.search).get('integration')) return 'integrations';
    // Opened from the profile menu (e.g. "Two-step login")
    try { const t = sessionStorage.getItem('bp.settingsTab'); sessionStorage.removeItem('bp.settingsTab'); if (t) return t; } catch { /* optional */ }
    return 'workbuddy';
  });
  useEffect(() => {
    const open = (e: Event) => setTab((e as CustomEvent<string>).detail);
    window.addEventListener('bp:settings-tab', open);
    return () => window.removeEventListener('bp:settings-tab', open);
  }, []);

  // Return from an OAuth connect (Shopee / Lazada / TikTok Shop)
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (!q.get('integration')) return;
    const msg = q.get('message') ?? '';
    if (q.get('status') === 'ok') toast.success(msg || 'Connected');
    else toast.error(msg || 'Connection failed');
    window.history.replaceState(null, '', window.location.pathname);
  }, []);

  return (
    <div>
      <PageHeader
        title="Settings"
        subtitle="AI engine, business profile, integrations and account"
        actions={
          <Button variant="outline" size="sm" onClick={() => void signOut()}>
            <LogOut className="mr-1.5 h-4 w-4" /> Sign out {session.user.email}
          </Button>
        }
      />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-4">
          <TabsTrigger value="workbuddy">AI engine</TabsTrigger>
          <TabsTrigger value="profile">Business profile</TabsTrigger>
          <TabsTrigger value="integrations">Integrations</TabsTrigger>
          {/* Shop tills only exist in Retail mode */}
          {retail && <TabsTrigger value="pos">POS</TabsTrigger>}
          <TabsTrigger value="team">Team &amp; data</TabsTrigger>
        </TabsList>
        <TabsContent value="workbuddy"><WorkBuddyCard /></TabsContent>
        <TabsContent value="profile"><ProfileForm /></TabsContent>
        <TabsContent value="integrations"><Integrations /></TabsContent>
        {retail && <TabsContent value="pos"><PosTokens /></TabsContent>}
        <TabsContent value="team" className="space-y-4"><TeamCard /><TwoStepCard /><BackupsCard /><DataExportCard /></TabsContent>
      </Tabs>
    </div>
  );
}

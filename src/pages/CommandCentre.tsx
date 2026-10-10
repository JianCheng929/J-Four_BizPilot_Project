import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, Bot, CheckCircle2, ChevronDown, ChevronRight, CircleDot, ClipboardCheck, ListChecks,
  Loader2, MessageSquare, Send, Sparkles, Square, Wrench,
} from 'lucide-react';
import { toast } from 'sonner';
import { useBizPilot } from '@/lib/store';
import { api, post } from '@/lib/api';
import type { AgentEvent, AgentTask } from '@/lib/db/types';
import type { PageKey } from '@/components/layout/AppShell';
import { PageHeader } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { fmtDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Markdown } from '@/components/bizpilot/Markdown';

/**
 * Command Centre: the owner gives one goal, WorkBuddy plans it, calls BizPilot's
 * tools on real records, and every step streams here. Risky actions land in
 * Approvals.
 */

const GOALS: { label: string; prompt: string }[] = [
  { label: 'Morning briefing', prompt: 'Give me this morning\'s business briefing: sales yesterday and this week, orders waiting to ship, low stock, overdue invoices, bills due, unanswered reviews and pending approvals. Then tell me the 3 most important things to do today and send it to me as a notification.' },
  { label: 'Restock what is running low', prompt: 'Check which products are running low based on real sales velocity and supplier lead times, then draft purchase orders grouped by supplier and send them for my approval.' },
  { label: 'Answer reviews', prompt: 'Go through all new customer reviews. Draft a reply for each in our brand voice and in the customer\'s language, send them for approval, and escalate any that mention safety, fake products or refunds.' },
  { label: 'Sync marketplaces', prompt: 'Sync the latest orders and reviews from every connected marketplace, then tell me what came in, which orders still need shipping and whether any items could not be matched to products.' },
  { label: 'Ship today\'s orders', prompt: 'For every online order awaiting fulfilment that has a delivery address, get courier quotes and request booking of the cheapest reliable option for my approval.' },
  { label: 'Invoices & e-invoice', prompt: 'Find paid orders from the last 7 days without an invoice, create invoices for them, and request approval to submit them to LHDN MyInvois.' },
  { label: 'Weekly content plan', prompt: 'Look at our best-selling and slow-moving products from the last 30 days and draft a 7-day Facebook and Instagram content plan to push them, scheduled at sensible times, respecting our prohibited claims.' },
  { label: 'Pricing check', prompt: 'Review margins for all products from the last 30 days. Where the margin is below 25% suggest a new price with the reasoning, and request approval for the changes.' },
];

const ACTIVE: AgentTask['status'][] = ['starting', 'running', 'waiting_permission'];

const ICON: Record<AgentEvent['kind'], typeof Bot> = {
  status: CircleDot, message: MessageSquare, thought: Sparkles, plan: ListChecks, tool_call: Wrench,
  tool_result: CheckCircle2, error: AlertTriangle, artifact: ClipboardCheck,
};

function prettyJson(text: string) {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

function EventRow({ e }: { e: AgentEvent }) {
  const [open, setOpen] = useState(false);
  const Icon = ICON[e.kind] ?? CircleDot;
  const tone =
    e.kind === 'error' ? 'text-red-600' : e.kind === 'artifact' ? 'text-teal-700' : e.kind === 'plan' ? 'text-indigo-600' : e.kind === 'tool_call' ? 'text-amber-600' : 'text-slate-500';
  const expandable = e.kind === 'tool_result' || e.kind === 'tool_call' || e.kind === 'thought';
  const input = e.kind === 'tool_call' ? (e.data as { input?: unknown } | undefined)?.input : undefined;

  return (
    <li className="relative flex gap-3 pb-3">
      <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', tone)} />
      <div className="min-w-0 flex-1 text-sm">
        {e.kind === 'plan' ? (
          <div className="rounded-md border border-indigo-100 bg-indigo-50/60 p-2">
            <div className="mb-1 text-xs font-semibold text-indigo-700">Plan</div>
            <Markdown text={e.text} className="text-slate-700" />
          </div>
        ) : e.kind === 'message' ? (
          <Markdown text={e.text} className="text-slate-800" />
        ) : expandable ? (
          <button className="flex w-full items-start gap-1 text-left" onClick={() => setOpen((o) => !o)}>
            {open ? <ChevronDown className="mt-0.5 h-3.5 w-3.5 text-slate-400" /> : <ChevronRight className="mt-0.5 h-3.5 w-3.5 text-slate-400" />}
            <span className={cn(e.kind === 'tool_call' ? 'font-medium text-slate-700' : 'text-slate-500', 'truncate')}>
              {e.kind === 'tool_call' ? `Using ${e.text}` : e.kind === 'thought' ? 'Thinking…' : `Result: ${e.text.replace(/\s+/g, ' ').slice(0, 120)}`}
            </span>
          </button>
        ) : (
          <div className={cn(e.kind === 'error' ? 'text-red-700' : e.kind === 'artifact' ? 'font-medium text-teal-800' : 'text-slate-500')}>{e.text}</div>
        )}
        {open && (
          <pre className="mt-1 max-h-72 overflow-auto rounded-md bg-slate-50 p-2 text-[11px] text-slate-700">
            {e.kind === 'tool_call' ? JSON.stringify(input ?? {}, null, 2) : prettyJson(e.text)}
          </pre>
        )}
      </div>
      <span className="shrink-0 text-[10px] text-slate-400">{new Date(e.at).toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
    </li>
  );
}

function StatusBadge({ s }: { s: AgentTask['status'] }) {
  const map: Record<AgentTask['status'], string> = {
    starting: 'bg-slate-200 text-slate-700', running: 'bg-amber-100 text-amber-800', waiting_permission: 'bg-amber-100 text-amber-800',
    completed: 'bg-teal-100 text-teal-800', failed: 'bg-red-100 text-red-700', cancelled: 'bg-slate-200 text-slate-600',
  };
  return <Badge className={cn('capitalize hover:bg-inherit', map[s])}>{s.replace('_', ' ')}</Badge>;
}

export function CommandCentre({ onNavigate }: { onNavigate?: (p: PageKey) => void } = {}) {
  const { db, reload } = useBizPilot();
  const [prompt, setPrompt] = useState('');
  const [task, setTask] = useState<AgentTask | null>(null);
  const [sending, setSending] = useState(false);
  const [engine, setEngine] = useState<{ connected: boolean } | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const pending = db.approvals.filter((a) => a.status === 'pending').length;

  useEffect(() => {
    api<{ connected: boolean }>('/api/agent/status').then(setEngine).catch(() => setEngine(null));
  }, []);

  // Resume the latest running task after a page refresh
  useEffect(() => {
    if (task) return;
    const running = db.agentTasks.find((t) => ACTIVE.includes(t.status));
    if (running) setTask(running);
  }, [db.agentTasks, task]);

  const refresh = useCallback(async (id: string) => {
    try {
      const t = await api<AgentTask>(`/api/agent/tasks/${id}`);
      setTask(t);
      return t;
    } catch {
      return null;
    }
  }, []);

  // Live polling while WorkBuddy works
  useEffect(() => {
    if (!task || !ACTIVE.includes(task.status)) return;
    const h = window.setInterval(async () => {
      const t = await refresh(task.id);
      if (t && !ACTIVE.includes(t.status)) void reload();
    }, 1200);
    return () => window.clearInterval(h);
  }, [task?.id, task?.status, refresh, reload]);

  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [task?.events.length]);

  const send = async (text: string) => {
    const goal = text.trim();
    if (!goal) return;
    setSending(true);
    try {
      const t = await post<AgentTask>('/api/agent/tasks', { prompt: goal });
      setTask(t);
      setPrompt('');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const cancel = async () => {
    if (!task) return;
    try { await post(`/api/agent/tasks/${task.id}/cancel`); } catch (e) { toast.error((e as Error).message); }
  };

  const running = task && ACTIVE.includes(task.status);
  const created = task?.events.filter((e) => e.kind === 'artifact') ?? [];
  const toolCalls = task?.events.filter((e) => e.kind === 'tool_call').length ?? 0;

  return (
    <div>
      <PageHeader
        title="Command Centre"
        subtitle="Give WorkBuddy a goal. It plans, uses BizPilot's tools on your real data, and asks you before anything risky."
        actions={
          engine && (
            <Badge className={cn('hover:bg-inherit', engine.connected ? 'bg-teal-100 text-teal-800' : 'bg-slate-200 text-slate-600')}>
              <Bot className="mr-1 h-3 w-3" /> WorkBuddy {engine.connected ? 'online' : 'offline'}
            </Badge>
          )
        }
      />

      {engine && !engine.connected && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          The AI engine is offline right now, so goals can't run. Please contact the BizPilot administrator.
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
        <div className="space-y-4">
          <Card>
            <CardContent className="space-y-3 pt-5">
              <Textarea
                rows={3}
                value={prompt}
                placeholder="e.g. Restock anything that will run out within 10 days and draft the POs for my approval"
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send(prompt); }}
                disabled={!!running}
              />
              <div className="flex flex-wrap items-center gap-2">
                {GOALS.map((g) => (
                  <button
                    key={g.label}
                    disabled={!!running || sending}
                    onClick={() => setPrompt(g.prompt)}
                    className="rounded-full border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:border-teal-300 hover:text-teal-800 disabled:opacity-50"
                  >
                    {g.label}
                  </button>
                ))}
                <div className="ml-auto flex gap-2">
                  {running && (
                    <Button variant="outline" size="sm" onClick={cancel}><Square className="mr-1 h-3.5 w-3.5" /> Stop</Button>
                  )}
                  <Button className="bg-teal-700 text-white hover:bg-teal-800" disabled={!prompt.trim() || !!running || sending} onClick={() => void send(prompt)}>
                    {sending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Send className="mr-1.5 h-4 w-4" />} Run with WorkBuddy
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          {task ? (
            <Card>
              <CardHeader className="pb-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="text-sm font-medium text-slate-700">{task.prompt}</CardTitle>
                  <div className="flex items-center gap-2 text-xs text-slate-500">
                    {toolCalls > 0 && <span>{toolCalls} tool calls</span>}
                    <StatusBadge s={task.status} />
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <ol className="border-l border-slate-100 pl-1">
                  {task.events.map((e, i) => <EventRow key={`${e.at}-${i}`} e={e} />)}
                  {running && (
                    <li className="flex items-center gap-2 pb-2 text-xs text-slate-500"><Loader2 className="h-3.5 w-3.5 animate-spin" /> WorkBuddy is working…</li>
                  )}
                </ol>
                <div ref={bottom} />
                {task.result && !running && (
                  <div className={cn('mt-2 rounded-lg border p-3 text-sm', task.status === 'completed' ? 'border-teal-200 bg-teal-50/60' : 'border-red-200 bg-red-50')}>
                    <div className="mb-1 text-xs font-semibold text-slate-600">{task.status === 'completed' ? 'Result' : 'Stopped'}</div>
                    <Markdown text={task.result} className="text-slate-800" />
                  </div>
                )}
                {created.length > 0 && !running && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-600">
                    {created.length} record(s) created or requested.
                    {pending > 0 && (
                      <Button size="sm" variant="outline" onClick={() => onNavigate?.('approvals')}>
                        <ClipboardCheck className="mr-1 h-3.5 w-3.5" /> Review {pending} pending approval{pending > 1 ? 's' : ''}
                      </Button>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="py-10 text-center text-sm text-slate-500">
                <Bot className="mx-auto mb-2 h-8 w-8 text-teal-700" />
                Pick a suggested goal or type your own. Every step WorkBuddy takes will show here.
              </CardContent>
            </Card>
          )}
        </div>

        <Card className="h-fit">
          <CardHeader className="pb-2"><CardTitle className="text-sm">Recent goals</CardTitle></CardHeader>
          <CardContent className="space-y-1">
            {db.agentTasks.length === 0 && <p className="text-xs text-slate-500">No goals yet.</p>}
            {db.agentTasks.slice(0, 15).map((t) => (
              <button
                key={t.id}
                onClick={() => void refresh(t.id)}
                className={cn('w-full rounded-md px-2 py-1.5 text-left text-xs hover:bg-slate-50', task?.id === t.id && 'bg-slate-100')}
              >
                <div className="line-clamp-2 text-slate-700">{t.prompt}</div>
                <div className="mt-0.5 flex items-center justify-between text-[10px] text-slate-400">
                  {fmtDateTime(t.createdAt)} <span className="capitalize">{t.status}</span>
                </div>
              </button>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

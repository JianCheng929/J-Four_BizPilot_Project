import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, Bot, CheckCircle2, ChevronDown, ChevronRight, CircleDot, ClipboardCheck, ListChecks,
  Loader2, MessageSquare, PanelLeftClose, PanelLeftOpen, Plus, Send, Sparkles, Square, Trash2, Wrench,
} from 'lucide-react';
import { toast } from 'sonner';
import { useBizPilot } from '@/lib/store';
import { api, post } from '@/lib/api';
import type { AgentEvent, AgentTask } from '@/lib/db/types';
import type { PageKey } from '@/components/layout/AppShell';
import { PageHeader } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { fmtDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Markdown } from '@/components/bizpilot/Markdown';
import { VideoMaker, type VideoPlan } from '@/components/bizpilot/VideoMaker';

/**
 * Command Centre: a chat with WorkBuddy. Each chat keeps its history, so the
 * owner can follow up ("yes, add this"). WorkBuddy plans, calls BizPilot's
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
          <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] rounded-md bg-slate-50 p-2 text-[11px] text-slate-700">
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

interface Chat { id: string; title: string; messages: number; lastAt: string; lastStatus: AgentTask['status'] }

const chatOf = (t: AgentTask) => t.conversationId || t.id;

/** Chats from the tasks already loaded in the browser, so the page opens instantly. */
function chatsFrom(tasks: AgentTask[]): Chat[] {
  const chats = new Map<string, Chat>();
  for (const t of [...tasks].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const c = chats.get(chatOf(t));
    if (c) { c.messages++; c.lastAt = t.updatedAt; c.lastStatus = t.status; }
    else chats.set(chatOf(t), { id: chatOf(t), title: t.prompt.slice(0, 120), messages: 1, lastAt: t.updatedAt || t.createdAt, lastStatus: t.status });
  }
  return [...chats.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

/** Images and videos WorkBuddy made in this turn. */
function MediaOutputs({ task }: { task: AgentTask }) {
  const media = task.events
    .filter((e) => e.kind === 'artifact' && (e.data as { media?: string } | undefined)?.media)
    .map((e) => e.data as { media: 'image' | 'video'; url?: string } & Partial<VideoPlan>);
  if (!media.length) return null;
  const images = media.filter((m) => m.media === 'image' && m.url);
  const videos = media.filter((m) => m.media === 'video' && m.contentId);
  return (
    <div className="space-y-2">
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map((m, i) => (
            <a key={i} href={m.url} target="_blank" rel="noreferrer" title="Open full size">
              <img src={m.url} alt="Generated" className="h-40 w-40 rounded-lg border object-cover sm:h-48 sm:w-48" />
            </a>
          ))}
        </div>
      )}
      {videos.map((v) => (
        <VideoMaker key={v.contentId} plan={{ contentId: v.contentId!, title: v.title ?? 'Video', aspect: v.aspect ?? '9:16', scenes: v.scenes ?? [], engine: v.engine }} />
      ))}
    </div>
  );
}

/** One exchange: the owner's message, WorkBuddy's steps (folded once done) and its answer. */
function Turn({ task, onStop, pending, onNavigate }: { task: AgentTask; onStop: () => void; pending: number; onNavigate?: (p: PageKey) => void }) {
  const running = ACTIVE.includes(task.status);
  const [showSteps, setShowSteps] = useState(false);
  const steps = task.events.filter((e) => e.kind !== 'status' || running);
  const toolCalls = task.events.filter((e) => e.kind === 'tool_call').length;
  const created = task.events.filter((e) => e.kind === 'artifact').length;
  const lastMessage = [...task.events].reverse().find((e) => e.kind === 'message')?.text;
  const answer = task.result && task.result !== 'Done.' ? task.result : lastMessage ?? task.result;

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap [overflow-wrap:anywhere] rounded-2xl rounded-br-sm bg-teal-700 px-4 py-2.5 text-sm text-white">{task.prompt}</div>
      </div>
      <div className="flex gap-3">
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-teal-50 text-teal-700"><Bot className="h-4 w-4" /></div>
        <div className="min-w-0 flex-1 space-y-2">
          {running ? (
            <>
            <ol className="border-l border-slate-100 pl-1">
              {steps.map((e, i) => <EventRow key={`${e.at}-${i}`} e={e} />)}
              <li className="flex items-center gap-2 pb-2 text-xs text-slate-500">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> WorkBuddy is working…
                <Button variant="outline" size="sm" className="ml-2 h-6 px-2 text-xs" onClick={onStop}><Square className="mr-1 h-3 w-3" /> Stop</Button>
              </li>
            </ol>
            <MediaOutputs task={task} />
            </>
          ) : (
            <>
              {(toolCalls > 0 || steps.length > 2) && (
                <button className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700" onClick={() => setShowSteps((v) => !v)}>
                  {showSteps ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                  {toolCalls > 0 ? `Used ${toolCalls} tool${toolCalls > 1 ? 's' : ''}` : 'Show steps'}
                  <StatusBadge s={task.status} />
                </button>
              )}
              {showSteps && <ol className="border-l border-slate-100 pl-1">{steps.map((e, i) => <EventRow key={`${e.at}-${i}`} e={e} />)}</ol>}
              {answer && (
                <div className={cn('rounded-2xl rounded-tl-sm border px-4 py-3 text-sm', task.status === 'completed' ? 'border-slate-200 bg-white' : 'border-red-200 bg-red-50')}>
                  <Markdown text={answer} className="text-slate-800" />
                </div>
              )}
              <MediaOutputs task={task} />
              {created > 0 && (
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                  {created} record(s) created or requested.
                  {pending > 0 && (
                    <Button size="sm" variant="outline" className="h-7" onClick={() => onNavigate?.('approvals')}>
                      <ClipboardCheck className="mr-1 h-3.5 w-3.5" /> Review {pending} pending approval{pending > 1 ? 's' : ''}
                    </Button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function CommandCentre({ onNavigate }: { onNavigate?: (p: PageKey) => void } = {}) {
  const { db, reload } = useBizPilot();
  const [prompt, setPrompt] = useState('');
  const [chats, setChats] = useState<Chat[]>(() => chatsFrom(db.agentTasks));
  const [chatId, setChatId] = useState<string | null>(null);
  const [turns, setTurns] = useState<AgentTask[]>([]);
  const [loadingChat, setLoadingChat] = useState(false);
  const [sending, setSending] = useState(false);
  const [showChats, setShowChats] = useState(true);
  const [engine, setEngine] = useState<{ connected: boolean } | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const pending = db.approvals.filter((a) => a.status === 'pending').length;
  const active = turns.find((t) => ACTIVE.includes(t.status));

  const loadChats = useCallback(async () => {
    try { setChats(await api<Chat[]>('/api/agent/conversations')); } catch { /* list is optional */ }
  }, []);

  const tasksRef = useRef(db.agentTasks);
  tasksRef.current = db.agentTasks;
  const openChat = useCallback(async (id: string | null) => {
    setChatId(id);
    if (!id) { setTurns([]); return; }
    // Show what the browser already has straight away, then refresh from the server.
    const local = tasksRef.current.filter((t) => chatOf(t) === id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    setTurns(local);
    setLoadingChat(local.length === 0);
    try { setTurns(await api<AgentTask[]>(`/api/agent/conversations/${id}`)); }
    catch (e) { if (!local.length) toast.error((e as Error).message); }
    finally { setLoadingChat(false); }
  }, []);

  useEffect(() => {
    api<{ connected: boolean }>('/api/agent/status').then(setEngine).catch(() => setEngine(null));
    void loadChats();
  }, [loadChats]);

  // After a page refresh, reopen the chat that is still running
  useEffect(() => {
    if (chatId) return;
    const running = db.agentTasks.find((t) => ACTIVE.includes(t.status));
    if (running) void openChat(running.conversationId || running.id);
  }, [db.agentTasks, chatId, openChat]);

  // Live updates while WorkBuddy works
  const activeId = active?.id;
  useEffect(() => {
    if (!activeId) return;
    const h = window.setInterval(async () => {
      try {
        const t = await api<AgentTask>(`/api/agent/tasks/${activeId}`);
        setTurns((ts) => ts.map((x) => (x.id === t.id ? t : x)));
        if (!ACTIVE.includes(t.status)) { void reload(); void loadChats(); }
      } catch { /* try again next tick */ }
    }, 1200);
    return () => window.clearInterval(h);
  }, [activeId, reload, loadChats]);

  const lastEvents = turns.length ? turns[turns.length - 1].events.length : 0;
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [turns.length, lastEvents]);

  const send = async (text: string) => {
    const goal = text.trim();
    if (!goal || active) return;
    setSending(true);
    try {
      const t = await post<AgentTask>('/api/agent/tasks', { prompt: goal, conversationId: chatId });
      setTurns((ts) => [...ts, t]);
      setChatId(t.conversationId || t.id);
      setPrompt('');
      void loadChats();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const stop = async () => {
    if (!active) return;
    try { await post(`/api/agent/tasks/${active.id}/cancel`); } catch (e) { toast.error((e as Error).message); }
  };

  const removeChat = async (id: string) => {
    if (!window.confirm('Delete this chat? Records WorkBuddy created stay in BizPilot.')) return;
    try {
      await api(`/api/agent/conversations/${id}`, { method: 'DELETE' });
      if (id === chatId) void openChat(null);
      void loadChats();
    } catch (e) { toast.error((e as Error).message); }
  };

  return (
    <div>
      <PageHeader
        title="Command Centre"
        subtitle="Chat with WorkBuddy. It remembers the conversation, uses BizPilot's tools on your real data, and asks you before anything risky."
        actions={
          engine && (
            <Badge className={cn('hover:bg-inherit', engine.connected ? 'bg-teal-100 text-teal-800' : 'bg-slate-200 text-slate-600')}>
              <Bot className="mr-1 h-3 w-3" /> WorkBuddy {engine.connected ? 'online' : 'offline'}
            </Badge>
          )
        }
      />

      {engine && !engine.connected && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          The AI engine is offline right now, so messages can't run. Please contact the BizPilot administrator.
        </div>
      )}

      <div className={cn('grid gap-4', showChats ? 'lg:grid-cols-[260px_minmax(0,1fr)]' : 'lg:grid-cols-[minmax(0,1fr)]')}>
        <Card className={cn('h-fit min-w-0 lg:sticky lg:top-4', !showChats && 'hidden')}>
          <CardHeader className="pb-2">
            <div className="flex gap-1">
              <Button className="flex-1 bg-teal-700 text-white hover:bg-teal-800" disabled={!!active} onClick={() => { void openChat(null); setPrompt(''); }}>
                <Plus className="mr-1.5 h-4 w-4" /> New chat
              </Button>
              <Button variant="outline" size="icon" title="Hide chats" onClick={() => setShowChats(false)}>
                <PanelLeftClose className="h-4 w-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="max-h-[60vh] space-y-1 overflow-y-auto">
            {chats.length === 0 && <p className="px-2 text-xs text-slate-500">No chats yet.</p>}
            {chats.map((c) => (
              <div key={c.id} className={cn('group flex items-start gap-1 rounded-md hover:bg-slate-50', chatId === c.id && 'bg-slate-100')}>
                <button className="min-w-0 flex-1 px-2 py-1.5 text-left text-xs" disabled={!!active && chatId !== c.id} onClick={() => void openChat(c.id)}>
                  <div className="line-clamp-2 text-slate-700">{c.title}</div>
                  <div className="mt-0.5 text-[10px] text-slate-400">{fmtDateTime(c.lastAt)} · {c.messages} message{c.messages > 1 ? 's' : ''}</div>
                </button>
                <button title="Delete chat" className="mt-1.5 mr-1 hidden rounded p-1 text-slate-400 hover:text-red-600 group-hover:block" onClick={() => void removeChat(c.id)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="flex min-h-[70vh] min-w-0 flex-col">
          {!showChats && (
            <div className="flex items-center gap-2 border-b border-slate-100 px-4 pb-3">
              <Button variant="outline" size="sm" onClick={() => setShowChats(true)}>
                <PanelLeftOpen className="mr-1 h-4 w-4" /> Chats
              </Button>
              <Button variant="ghost" size="sm" disabled={!!active} onClick={() => { void openChat(null); setPrompt(''); }}>
                <Plus className="mr-1 h-4 w-4" /> New chat
              </Button>
            </div>
          )}
          <CardContent className="min-w-0 flex-1 space-y-6 overflow-y-auto pt-5">
            {loadingChat ? (
              <div className="flex justify-center py-10 text-slate-400"><Loader2 className="h-5 w-5 animate-spin" /></div>
            ) : turns.length === 0 ? (
              <div className="py-10 text-center text-sm text-slate-500">
                <Bot className="mx-auto mb-2 h-8 w-8 text-teal-700" />
                Ask anything about your business, or pick a suggestion below. You can follow up in the same chat.
              </div>
            ) : (
              turns.map((t) => <Turn key={t.id} task={t} onStop={() => void stop()} pending={pending} onNavigate={onNavigate} />)
            )}
            <div ref={bottom} />
          </CardContent>

          <div className="space-y-2 border-t border-slate-100 p-4">
            {turns.length === 0 && (
              <div className="flex flex-wrap gap-2">
                {GOALS.map((g) => (
                  <button
                    key={g.label}
                    disabled={sending}
                    onClick={() => setPrompt(g.prompt)}
                    className="rounded-full border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:border-teal-300 hover:text-teal-800 disabled:opacity-50"
                  >
                    {g.label}
                  </button>
                ))}
              </div>
            )}
            <div className="flex items-end gap-2">
              <Textarea
                rows={2}
                value={prompt}
                placeholder={turns.length ? 'Reply to WorkBuddy…' : 'e.g. Restock anything that will run out within 10 days and draft the POs for my approval'}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(prompt); } }}
                disabled={!!active}
              />
              <Button className="h-10 bg-teal-700 text-white hover:bg-teal-800" disabled={!prompt.trim() || !!active || sending} onClick={() => void send(prompt)}>
                {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </Button>
            </div>
            <p className="text-[11px] text-slate-400">Enter to send, Shift+Enter for a new line.</p>
          </div>
        </Card>
      </div>
    </div>
  );
}

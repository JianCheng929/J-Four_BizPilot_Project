import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, Bot, CheckCircle2, ChevronDown, ChevronRight, CircleDot, ClipboardCheck, ListChecks,
  FileSpreadsheet, FileText, Film, Image as ImageIcon, Loader2, MessageSquare, PanelLeftClose, PanelLeftOpen, Paperclip, Plus, Send, Sparkles, Square, Trash2, Wrench, X,
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
import { ACCEPT, MAX_FILES, readChatFile, type ChatFile } from '@/lib/attachments';

/**
 * Command Centre: a chat with WorkBuddy. Each chat keeps its history, so the
 * owner can follow up ("yes, add this"). WorkBuddy plans, calls BizPilot's
 * tools on real records, and every step streams here. Risky actions land in
 * Approvals.
 */

const GOALS: { label: string; prompt: string }[] = [
  { label: 'Weekly run (whole team)', prompt: 'Run this week\'s operations with the whole team in parallel: restock what is running low (move stock, plan production or draft purchase orders within the cash we have), get waiting orders picked, packed and quoted for shipping, check cash, overdue invoices and the budget and send reminders, and draft marketing for the slow movers. Quality-check everything, then give me one short summary and what needs my approval.' },
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

const FILE_ICON: Record<ChatFile['kind'], typeof Bot> = { image: ImageIcon, pdf: FileText, sheet: FileSpreadsheet, text: FileText, video: Film };

function FileChip({ name, kind, preview, onRemove, light }: { name: string; kind: ChatFile['kind']; preview?: string; onRemove?: () => void; light?: boolean }) {
  const Icon = FILE_ICON[kind] ?? FileText;
  return (
    <span className={cn('inline-flex max-w-[220px] items-center gap-1.5 rounded-lg border px-1.5 py-1 text-xs', light ? 'border-white/30 bg-white/15 text-white' : 'border-slate-200 bg-white text-slate-700')}>
      {preview ? <img src={preview} alt="" className="h-8 w-8 shrink-0 rounded object-cover" /> : <Icon className="h-4 w-4 shrink-0" />}
      <span className="truncate">{name}</span>
      {onRemove && <button title="Remove" className="shrink-0 rounded p-0.5 text-slate-400 hover:text-red-600" onClick={onRemove}><X className="h-3.5 w-3.5" /></button>}
    </span>
  );
}

/** Files the owner sent with a message (kept on the first event of the turn). */
function sentFiles(task: AgentTask) {
  for (const e of task.events) {
    const files = (e.data as { attachments?: { name: string; kind: ChatFile['kind'] }[] } | undefined)?.attachments;
    if (files?.length) return files;
  }
  return [];
}

const ICON: Record<AgentEvent['kind'], typeof Bot> = {
  status: CircleDot, message: MessageSquare, thought: Sparkles, plan: ListChecks, tool_call: Wrench,
  tool_result: CheckCircle2, error: AlertTriangle, artifact: ClipboardCheck,
};

function prettyJson(text: string) {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

const AGENT_LABEL: Record<string, string> = {
  'research-agent': 'Research', 'inventory-agent': 'Inventory', 'sales-agent': 'Sales', 'finance-agent': 'Finance', 'marketing-agent': 'Marketing', 'qa-agent': 'Quality check',
};
const AGENT_TONE: Record<string, string> = {
  'research-agent': 'bg-sky-100 text-sky-800', 'inventory-agent': 'bg-amber-100 text-amber-800', 'sales-agent': 'bg-violet-100 text-violet-800',
  'finance-agent': 'bg-emerald-100 text-emerald-800', 'marketing-agent': 'bg-pink-100 text-pink-800', 'qa-agent': 'bg-slate-800 text-white',
};
const agentOf = (e: AgentEvent) => (e.data as { agent?: string } | undefined)?.agent;
const agentLabel = (a: string) => AGENT_LABEL[a] ?? a.replace(/-agent$/, '').replace(/-/g, ' ');

function AgentChip({ agent, className }: { agent: string; className?: string }) {
  return <span className={cn('inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-semibold', AGENT_TONE[agent] ?? 'bg-slate-100 text-slate-700', className)}>{agentLabel(agent)}</span>;
}

/** The agent team on this goal: who was briefed, who is working, who finished, and the quality check. */
function TeamStrip({ task }: { task: AgentTask }) {
  const state = new Map<string, 'started' | 'done' | 'failed'>();
  for (const e of task.events) {
    const d = e.data as { agent?: string; team?: 'started' | 'done' | 'failed' } | undefined;
    if (d?.agent && d.team) state.set(d.agent, d.team);
  }
  const check = [...task.events].reverse().map((e) => (e.data as { verification?: { passed: boolean; errors: number; checked: number } } | undefined)?.verification).find(Boolean);
  if (!state.size && !check) return null;
  const running = ACTIVE.includes(task.status);
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
      <span className="text-slate-500">Agent team:</span>
      {[...state].map(([a, st]) => (
        <span key={a} className="inline-flex items-center gap-1">
          <AgentChip agent={a} />
          {st === 'started' ? (running ? <Loader2 className="h-3 w-3 animate-spin text-slate-400" /> : <CircleDot className="h-3 w-3 text-slate-400" />) : st === 'done' ? <CheckCircle2 className="h-3 w-3 text-teal-600" /> : <AlertTriangle className="h-3 w-3 text-red-500" />}
        </span>
      ))}
      {check && (
        <span className={cn('ml-1 rounded px-1.5 py-0.5 font-medium', check.passed ? 'bg-teal-50 text-teal-800' : 'bg-red-50 text-red-700')}>
          {check.passed ? `Quality check passed (${check.checked} checked)` : `Quality check: ${check.errors} to fix`}
        </span>
      )}
    </div>
  );
}

function EventRow({ e, hideAgent }: { e: AgentEvent; hideAgent?: boolean }) {
  const [open, setOpen] = useState(false);
  const Icon = ICON[e.kind] ?? CircleDot;
  const tone =
    e.kind === 'error' ? 'text-red-600' : e.kind === 'artifact' ? 'text-teal-700' : e.kind === 'plan' ? 'text-indigo-600' : e.kind === 'tool_call' ? 'text-amber-600' : 'text-slate-500';
  const expandable = e.kind === 'tool_result' || e.kind === 'tool_call' || e.kind === 'thought';
  const input = e.kind === 'tool_call' ? (e.data as { input?: unknown } | undefined)?.input : undefined;
  const agent = hideAgent ? undefined : agentOf(e);

  return (
    <li className="relative flex gap-3 pb-3">
      <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', tone)} />
      <div className={cn('min-w-0 flex-1 text-sm', agent && 'flex items-start gap-1.5')}>
        {agent && <AgentChip agent={agent} className="mt-0.5" />}
        <div className="min-w-0 flex-1">
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

interface StepGroup { key: string; agent?: string; events: AgentEvent[] }

/** Consecutive steps by the same agent form one foldable block (the lead's own steps too). */
function groupSteps(events: AgentEvent[]): StepGroup[] {
  const groups: StepGroup[] = [];
  for (const e of events) {
    const agent = agentOf(e);
    const last = groups[groups.length - 1];
    if (last && last.agent === agent) last.events.push(e);
    else groups.push({ key: `${groups.length}-${agent ?? 'lead'}`, agent, events: [e] });
  }
  return groups;
}

/** One agent's block of steps: a header with who, how many tools and how it went, then the steps. */
function StepBlock({ g, defaultOpen, live }: { g: StepGroup; defaultOpen: boolean; live: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const tools = g.events.filter((e) => e.kind === 'tool_call').length;
  const team = [...g.events].reverse().map((e) => (e.data as { team?: string } | undefined)?.team).find(Boolean);
  const failed = team === 'failed' || g.events.some((e) => e.kind === 'error');
  const brief = g.events.map((e) => (e.data as { brief?: string } | undefined)?.brief).find(Boolean);
  return (
    <li className="pb-2">
      <button className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs hover:bg-slate-50" onClick={() => setOpen((o) => !o)} title={open ? 'Minimise' : 'Expand'}>
        {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-400" />}
        {g.agent ? <AgentChip agent={g.agent} /> : <span className="inline-flex shrink-0 items-center rounded bg-teal-700 px-1.5 py-0.5 text-[10px] font-semibold text-white">Lead agent</span>}
        <span className="min-w-0 flex-1 truncate text-slate-500">
          {g.events.length} step{g.events.length > 1 ? 's' : ''}{tools ? ` · ${tools} tool${tools > 1 ? 's' : ''}` : ''}
          {brief && !open ? ` · ${brief.replace(/\s+/g, ' ').slice(0, 90)}` : ''}
        </span>
        {live ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-slate-400" /> : failed ? <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-red-500" /> : <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-teal-600" />}
      </button>
      {open && <ol className="ml-2 mt-1 border-l border-slate-100 pl-2">{g.events.map((e, i) => <EventRow key={`${e.at}-${i}`} e={e} hideAgent />)}</ol>}
    </li>
  );
}

/** Every step of a goal, grouped by agent. Minimise or expand the whole list or any agent's block, during and after the run. */
function StepsPanel({ task, running, stopControl }: { task: AgentTask; running: boolean; stopControl?: React.ReactNode }) {
  const steps = task.events.filter((e) => e.kind !== 'status' || running || (e.data as { team?: string } | undefined)?.team);
  const groups = groupSteps(steps);
  const [panel, setPanel] = useState<boolean | null>(null); // null: open while working, folded when done
  const [all, setAll] = useState<{ open: boolean; n: number }>({ open: false, n: 0 });
  const open = panel ?? running;
  const tools = task.events.filter((e) => e.kind === 'tool_call').length;
  const agents = new Set(groups.map((g) => g.agent ?? 'lead')).size;
  if (!steps.length && !running) return null;
  const memberRunning = (g: StepGroup) => running && (g === groups[groups.length - 1] || (g.agent !== undefined && (g.events[g.events.length - 1].data as { team?: string } | undefined)?.team === 'started'));
  return (
    <div className="rounded-lg border border-slate-100 bg-slate-50/40">
      <div className="flex flex-wrap items-center gap-2 px-2 py-1.5 text-xs text-slate-500">
        <button className="flex items-center gap-1 hover:text-slate-800" onClick={() => setPanel(!open)} title={open ? 'Minimise the steps' : 'Show the steps'}>
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          {running && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          <span className="font-medium text-slate-600">{running ? 'WorkBuddy is working' : 'How WorkBuddy did it'}</span>
          <span>· {steps.length} steps · {tools} tool{tools === 1 ? '' : 's'} · {agents} agent{agents === 1 ? '' : 's'}</span>
        </button>
        {!running && <StatusBadge s={task.status} />}
        {open && groups.length > 1 && (
          <span className="flex items-center gap-2">
            <button className="text-teal-700 hover:underline" onClick={() => setAll((a) => ({ open: true, n: a.n + 1 }))}>Expand all</button>
            <button className="text-teal-700 hover:underline" onClick={() => setAll((a) => ({ open: false, n: a.n + 1 }))}>Minimise all</button>
          </span>
        )}
        {stopControl && <span className="ml-auto">{stopControl}</span>}
      </div>
      {open && (
        <ol className="px-1 pb-1">
          {groups.map((g) => (
            <StepBlock key={`${g.key}-${all.n}`} g={g} live={memberRunning(g)} defaultOpen={all.n ? all.open : memberRunning(g) || groups.length === 1} />
          ))}
        </ol>
      )}
    </div>
  );
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
function Turn({ task, onStop, stopping, pending, onNavigate }: { task: AgentTask; onStop: () => void; stopping?: boolean; pending: number; onNavigate?: (p: PageKey) => void }) {
  const running = ACTIVE.includes(task.status);
  const created = task.events.filter((e) => e.kind === 'artifact').length;
  const lastMessage = [...task.events].reverse().find((e) => e.kind === 'message')?.text;
  const answer = task.result && task.result !== 'Done.' ? task.result : lastMessage ?? task.result;

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap [overflow-wrap:anywhere] rounded-2xl rounded-br-sm bg-teal-700 px-4 py-2.5 text-sm text-white">
          {task.prompt}
          {sentFiles(task).length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">{sentFiles(task).map((f, i) => <FileChip key={i} name={f.name} kind={f.kind} light />)}</div>
          )}
        </div>
      </div>
      <div className="flex gap-3">
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-teal-50 text-teal-700"><Bot className="h-4 w-4" /></div>
        <div className="min-w-0 flex-1 space-y-2">
          <TeamStrip task={task} />
          <StepsPanel
            task={task}
            running={running}
            stopControl={running ? <Button variant="outline" size="sm" className="h-6 px-2 text-xs" disabled={stopping} onClick={onStop}>{stopping ? <><Loader2 className="mr-1 h-3 w-3 animate-spin" /> Stopping…</> : <><Square className="mr-1 h-3 w-3" /> Stop</>}</Button> : undefined}
          />
          {running ? (
            <MediaOutputs task={task} />
          ) : (
            <>
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
  const { db, reload, business } = useBizPilot();
  const [prompt, setPrompt] = useState('');
  const [files, setFiles] = useState<ChatFile[]>([]);
  const [reading, setReading] = useState(0);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const addFiles = async (list: FileList | File[]) => {
    const picked = Array.from(list).slice(0, Math.max(0, MAX_FILES - files.length));
    if (list.length > picked.length) toast.error(`Up to ${MAX_FILES} files per message.`);
    setReading((n) => n + picked.length);
    await Promise.all(picked.map(async (f) => {
      try {
        const read = await readChatFile(f, business.id);
        setFiles((fs) => (fs.length >= MAX_FILES ? fs : [...fs, read]));
      } catch (e) {
        toast.error((e as Error).message);
      } finally {
        setReading((n) => n - 1);
      }
    }));
  };
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
  // WorkBuddy runs one goal at a time, maybe in another chat: the owner can still browse, type and attach meanwhile.
  const busy = active ?? db.agentTasks.find((t) => ACTIVE.includes(t.status));

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

  const asked = useRef(false);
  // A chat opened from another page ("BizPilot noticed", the working indicator)
  useEffect(() => {
    const take = () => {
      let id: string | null = null;
      try { id = sessionStorage.getItem('bp.openChat'); sessionStorage.removeItem('bp.openChat'); } catch { /* optional */ }
      if (id) { asked.current = true; void openChat(id); }
    };
    take();
    window.addEventListener('bizpilot:open-chat', take);
    return () => window.removeEventListener('bizpilot:open-chat', take);
  }, [openChat]);

  // After a page refresh, reopen the chat that is still running
  useEffect(() => {
    if (chatId || asked.current) return;
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

  // A goal running in another chat: watch it so sending unlocks as soon as it finishes.
  const elsewhereId = !active && busy ? busy.id : undefined;
  useEffect(() => {
    if (!elsewhereId) return;
    const h = window.setInterval(async () => {
      try {
        const t = await api<AgentTask>(`/api/agent/tasks/${elsewhereId}`);
        if (!ACTIVE.includes(t.status)) { void reload(); void loadChats(); }
      } catch { /* try again next tick */ }
    }, 3000);
    return () => window.clearInterval(h);
  }, [elsewhereId, reload, loadChats]);

  const lastEvents = turns.length ? turns[turns.length - 1].events.length : 0;
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [turns.length, lastEvents]);

  const send = async (text: string) => {
    const goal = text.trim();
    if ((!goal && !files.length) || busy || reading) return;
    setSending(true);
    try {
      const attachments = files.map((f) => ({ name: f.name, kind: f.kind, size: f.size, text: f.text, images: f.images, path: f.path, note: f.note }));
      const t = await post<AgentTask>('/api/agent/tasks', { prompt: goal, conversationId: chatId, attachments: attachments.length ? attachments : undefined });
      setTurns((ts) => [...ts, t]);
      setChatId(t.conversationId || t.id);
      setPrompt('');
      setFiles([]);
      void loadChats();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const [stoppingId, setStoppingId] = useState<string | null>(null);
  const stop = async (id: string) => {
    setStoppingId(id);
    try {
      await post(`/api/agent/tasks/${id}/cancel`);
    } catch (e) {
      setStoppingId(null);
      toast.error((e as Error).message);
    }
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
              <Button className="flex-1 bg-teal-700 text-white hover:bg-teal-800" onClick={() => { asked.current = true; void openChat(null); }}>
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
                <button className="min-w-0 flex-1 px-2 py-1.5 text-left text-xs" onClick={() => { asked.current = true; void openChat(c.id); }}>
                  <div className="line-clamp-2 text-slate-700">{ACTIVE.includes(c.lastStatus) && <Loader2 className="mr-1 inline h-3 w-3 animate-spin text-amber-600" />}{c.title}</div>
                  <div className="mt-0.5 text-[10px] text-slate-400">{fmtDateTime(c.lastAt)} · {c.messages} message{c.messages > 1 ? 's' : ''}</div>
                </button>
                <button title="Delete chat" className="mt-1.5 mr-1 hidden rounded p-1 text-slate-400 hover:text-red-600 group-hover:block" onClick={() => void removeChat(c.id)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card
          className={cn('relative flex min-h-[70vh] min-w-0 flex-col', dragging && 'ring-2 ring-teal-400')}
          onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
          onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
          onDrop={(e) => { if (!e.dataTransfer.files.length) return; e.preventDefault(); setDragging(false); void addFiles(e.dataTransfer.files); }}
        >
          {dragging && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-teal-50/80 text-sm font-medium text-teal-800">
              Drop receipts, quotations, photos, videos or spreadsheets. BizPilot reads them and records everything.
            </div>
          )}
          {!showChats && (
            <div className="flex items-center gap-2 border-b border-slate-100 px-4 pb-3">
              <Button variant="outline" size="sm" onClick={() => setShowChats(true)}>
                <PanelLeftOpen className="mr-1 h-4 w-4" /> Chats
              </Button>
              <Button variant="ghost" size="sm" onClick={() => { asked.current = true; void openChat(null); }}>
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
              turns.map((t) => <Turn key={t.id} task={t} onStop={() => void stop(t.id)} stopping={stoppingId === t.id} pending={pending} onNavigate={onNavigate} />)
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
            {(files.length > 0 || reading > 0) && (
              <div className="flex flex-wrap items-center gap-1.5">
                {files.map((f, i) => <FileChip key={`${f.name}-${i}`} name={f.name} kind={f.kind} preview={f.preview} onRemove={() => setFiles((fs) => fs.filter((_, j) => j !== i))} />)}
                {reading > 0 && <span className="inline-flex items-center gap-1 text-xs text-slate-500"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading {reading} file{reading > 1 ? 's' : ''}…</span>}
              </div>
            )}
            <div className="flex items-end gap-2">
              <input ref={fileInput} type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.target.value = ''; }} />
              <Button variant="outline" size="icon" className="h-10 w-10 shrink-0" title="Attach receipts, quotations, photos, videos, PDFs or spreadsheets" disabled={files.length >= MAX_FILES} onClick={() => fileInput.current?.click()}>
                <Paperclip className="h-4 w-4" />
              </Button>
              <Textarea
                rows={2}
                value={prompt}
                placeholder={turns.length ? 'Reply to WorkBuddy…' : 'e.g. Restock anything that will run out within 10 days and draft the POs for my approval'}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(prompt); } }}
                onPaste={(e) => { const pasted = Array.from(e.clipboardData.files); if (pasted.length) { e.preventDefault(); void addFiles(pasted); } }}
              />
              <Button className="h-10 bg-teal-700 text-white hover:bg-teal-800" disabled={(!prompt.trim() && !files.length) || !!busy || sending || reading > 0} onClick={() => void send(prompt)}>
                {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </Button>
            </div>
            {busy && (
              <p className="flex items-center gap-1.5 text-[11px] text-amber-700">
                <Loader2 className="h-3 w-3 animate-spin" />
                {active ? 'WorkBuddy is working on this chat.' : 'WorkBuddy is finishing a task in another chat.'} Keep typing and attaching; send when it is done.
                {!active && <button className="underline" onClick={() => { asked.current = true; void openChat(busy.conversationId || busy.id); }}>Open it</button>}
              </p>
            )}
            <p className="text-[11px] text-slate-400">Enter to send, Shift+Enter for a new line. Attach or drop receipts, quotations, bills, order screenshots, product photos or videos: BizPilot works out what each one is and records it.</p>
          </div>
        </Card>
      </div>
    </div>
  );
}

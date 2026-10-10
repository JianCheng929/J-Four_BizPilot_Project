import { useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, Loader2, Sparkles, X } from 'lucide-react';
import { useBizPilot } from '@/lib/store';
import { post } from '@/lib/api';
import * as ops from '@/lib/ops';
import { detectSignals, signalChatId, type Signal, type SignalPage } from '@/lib/signals';
import type { AgentTask } from '@/lib/db/types';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ACTIVE, openAgentChat } from './agentChat';

function stateOf(tasks: AgentTask[], sig: Signal) {
  const id = signalChatId(sig.key);
  const mine = tasks.filter((t) => (t.conversationId || t.id) === id);
  if (mine.some((t) => ACTIVE.includes(t.status))) return 'working' as const;
  if (mine.some((t) => t.status === 'completed')) return 'done' as const;
  if (mine.length) return 'failed' as const;
  return 'new' as const;
}

/**
 * "BizPilot noticed": what the agent found in this page's records and what it
 * is doing about it. The server starts the agent on these by itself
 * (server/src/lib/reactor.ts); the button runs one straight away.
 */
export function AgentPanel({ page, className }: { page: SignalPage; className?: string }) {
  const { db, reload, run, can } = useBizPilot();
  const [nowMs] = useState(() => Date.now());
  const [starting, setStarting] = useState<string | null>(null);
  let signals: Signal[] = [];
  try { signals = detectSignals(db, nowMs).filter((s) => s.pages.includes(page)); } catch (e) { console.error('BizPilot noticed:', e); }
  if (!signals.length) return null;
  const self = db.settings.autopilot !== false && db.settings.automationLevel >= 2;
  const busy = db.agentTasks.some((t) => ACTIVE.includes(t.status));

  const start = async (sig: Signal) => {
    setStarting(sig.key);
    try {
      const conversationId = signalChatId(sig.key);
      await post('/api/agent/tasks', { prompt: `${sig.title}. ${sig.evidence}\n\n${sig.prompt}`, conversationId });
      await reload();
      openAgentChat(conversationId);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setStarting(null);
    }
  };

  return (
    <div className={cn('rounded-xl border border-teal-200 bg-teal-50/60 p-4', className)}>
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-teal-700" />
        <div className="text-sm font-semibold text-teal-900">BizPilot noticed</div>
        <div className="text-xs text-teal-800/70">
          {self ? 'I act on these by myself. Anything that spends money, changes prices, publishes or messages customers waits in Approvals.' : 'Autopilot is off, so I wait for you. Press a button and I do the work.'}
        </div>
      </div>
      <div className="mt-3 space-y-2">
        {signals.slice(0, 4).map((sig) => {
          const st = stateOf(db.agentTasks, sig);
          const id = signalChatId(sig.key);
          return (
            <div key={sig.key} className="flex flex-wrap items-start gap-3 rounded-lg bg-white p-3 shadow-sm">
              <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', sig.severity === 'critical' ? 'bg-red-500' : sig.severity === 'warning' ? 'bg-amber-500' : 'bg-sky-500')} />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium">{sig.title}</div>
                <div className="mt-0.5 text-xs text-slate-600">{sig.evidence}</div>
              </div>
              <div className="shrink-0">
                {st === 'working' && (
                  <Button size="sm" variant="outline" onClick={() => openAgentChat(id)}><Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> Working on it</Button>
                )}
                {st === 'done' && (
                  <Button size="sm" variant="outline" onClick={() => openAgentChat(id)}><CheckCircle2 className="mr-1 h-3.5 w-3.5 text-teal-700" /> Done, see what I did</Button>
                )}
                {(st === 'new' || st === 'failed') && (
                  <Button size="sm" className="bg-teal-700 hover:bg-teal-800" disabled={busy || starting !== null} onClick={() => void start(sig)}>
                    {starting === sig.key ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="mr-1 h-3.5 w-3.5" />}
                    {st === 'failed' ? 'Try again' : sig.auto && self ? `${sig.action} now` : sig.action}
                  </Button>
                )}
                {(st === 'new' || st === 'failed') && busy && <div className="mt-0.5 text-right text-[11px] text-slate-400">after the current task</div>}
              </div>
              {can.write && st !== 'working' && (
                <Button
                  size="sm" variant="ghost" className="h-8 w-8 shrink-0 p-0 text-slate-400 hover:text-slate-700"
                  title={st === 'done' ? 'Clear: I have seen this' : 'Dismiss'} aria-label="Dismiss"
                  onClick={() => run((d, a) => ops.dismissSignal(d, sig.key, a), st === 'done' ? 'Cleared' : 'Dismissed for 30 days')}
                ><X className="h-4 w-4" /></Button>
              )}
            </div>
          );
        })}
        {signals.length > 4 && <div className="text-xs text-teal-800/70">and {signals.length - 4} more.</div>}
      </div>
    </div>
  );
}

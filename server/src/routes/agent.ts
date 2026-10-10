import { Router } from 'express';
import { requireUser, ctx } from '../lib/auth.ts';
import { handle, HttpError } from '../lib/http.ts';
import { supabaseAdmin } from '../lib/supabase.ts';
import { fromRow } from '../../../src/lib/db/remote.ts';
import type { AgentTask } from '../../../src/lib/db/types.ts';
import { cancelTask, getLiveTask, startTask } from '../agent/runner.ts';
import { checkEngine, status } from '../agent/workbuddy.ts';

export const agent = Router();

function chatId(v: unknown) {
  const id = String(v ?? '');
  if (!/^[\w-]{1,64}$/.test(id)) throw new HttpError(400, 'Unknown chat.');
  return id;
}

/** Read-only: is BizPilot's built-in WorkBuddy engine online? */
agent.get('/status', requireUser, handle(async (req) => {
  if (req.query.refresh) await checkEngine(true);
  return status();
}));

agent.post('/tasks', requireUser, handle(async (req) => {
  const prompt = String(req.body?.prompt ?? '').trim();
  if (!prompt) throw new HttpError(400, 'Tell WorkBuddy what you want done.');
  if (prompt.length > 4000) throw new HttpError(400, 'Keep the goal under 4000 characters.');
  const conversationId = req.body?.conversationId ? chatId(req.body.conversationId) : null;
  return startTask(ctx(req).business.id, prompt, conversationId);
}));

agent.get('/tasks/:id', requireUser, handle(async (req) => {
  const businessId = ctx(req).business.id;
  const id = String(req.params.id);
  const liveTask = getLiveTask(id, businessId);
  if (liveTask) return liveTask;
  const { data, error } = await supabaseAdmin().from('agent_tasks').select('*').eq('id', id).eq('business_id', businessId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new HttpError(404, 'Task not found.');
  return fromRow<AgentTask>('agentTasks', data as Record<string, unknown>);
}));

agent.post('/tasks/:id/cancel', requireUser, handle(async (req) => {
  if (!cancelTask(String(req.params.id), ctx(req).business.id)) throw new HttpError(400, 'That task is not running.');
  return { ok: true };
}));

/** Chats, newest first: one entry per conversation with its first message as the title. */
agent.get('/conversations', requireUser, handle(async (req) => {
  const { data, error } = await supabaseAdmin()
    .from('agent_tasks')
    .select('id, conversation_id, prompt, status, created_at, updated_at')
    .eq('business_id', ctx(req).business.id)
    .order('created_at', { ascending: true })
    .limit(1000);
  if (error) throw new Error(error.message);
  const chats = new Map<string, { id: string; title: string; messages: number; lastAt: string; lastStatus: string }>();
  for (const r of data ?? []) {
    const id = (r.conversation_id as string | null) || (r.id as string);
    const c = chats.get(id);
    if (c) {
      c.messages++;
      c.lastAt = r.updated_at as string;
      c.lastStatus = r.status as string;
    } else {
      chats.set(id, { id, title: String(r.prompt).slice(0, 120), messages: 1, lastAt: (r.updated_at ?? r.created_at) as string, lastStatus: r.status as string });
    }
  }
  return [...chats.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt)).slice(0, 100);
}));

/** Every message of one chat, oldest first. */
agent.get('/conversations/:id', requireUser, handle(async (req) => {
  const businessId = ctx(req).business.id;
  const id = chatId(req.params.id);
  const { data, error } = await supabaseAdmin()
    .from('agent_tasks')
    .select('*')
    .eq('business_id', businessId)
    .or(`conversation_id.eq.${id},and(conversation_id.is.null,id.eq.${id})`)
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => getLiveTask(String(row.id), businessId) ?? fromRow<AgentTask>('agentTasks', row as Record<string, unknown>));
}));

agent.delete('/conversations/:id', requireUser, handle(async (req) => {
  const businessId = ctx(req).business.id;
  const id = chatId(req.params.id);
  const { error } = await supabaseAdmin()
    .from('agent_tasks')
    .delete()
    .eq('business_id', businessId)
    .not('status', 'in', '(starting,running,waiting_permission)')
    .or(`conversation_id.eq.${id},and(conversation_id.is.null,id.eq.${id})`);
  if (error) throw new Error(error.message);
  return { ok: true };
}));

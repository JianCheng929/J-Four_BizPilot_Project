import { Router } from 'express';
import { requireUser, ctx } from '../lib/auth.ts';
import { handle, HttpError } from '../lib/http.ts';
import { supabaseAdmin } from '../lib/supabase.ts';
import { fromRow } from '../../../src/lib/db/remote.ts';
import type { AgentTask } from '../../../src/lib/db/types.ts';
import { cancelTask, getLiveTask, startTask } from '../agent/runner.ts';
import { checkEngine, status } from '../agent/workbuddy.ts';

export const agent = Router();

/** Read-only: is BizPilot's built-in WorkBuddy engine online? */
agent.get('/status', requireUser, handle(async (req) => {
  if (req.query.refresh) await checkEngine(true);
  return status();
}));

agent.post('/tasks', requireUser, handle(async (req) => {
  const prompt = String(req.body?.prompt ?? '').trim();
  if (!prompt) throw new HttpError(400, 'Tell WorkBuddy what you want done.');
  if (prompt.length > 4000) throw new HttpError(400, 'Keep the goal under 4000 characters.');
  return startTask(ctx(req).business.id, prompt);
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

import { query } from '@tencent-ai/agent-sdk';
import type { AgentEvent, AgentTask } from '../../../src/lib/db/types.ts';
import { newId } from '../../../src/lib/db/defaults.ts';
import { supabaseAdmin } from '../lib/supabase.ts';
import { readSnapshot } from '../lib/workspace.ts';
import { buildBizPilotServer } from './tools.ts';
import { skillsIndex } from './skills.ts';
import { cliPath, environment, rememberAccount, reportRun, restoreLogin, runtimeEnv, sandboxDir, withRuntime } from './workbuddy.ts';

/**
 * Runs one owner goal end-to-end on the WorkBuddy agent runtime with BizPilot's
 * tools, streaming every step into agent_tasks so the Command Centre shows it live.
 */

interface Live {
  task: AgentTask;
  businessId: string;
  history: string;
  abort: AbortController;
  dirty: boolean;
}
const live = new Map<string, Live>();

const WEB_TOOLS = ['WebSearch', 'WebFetch'];

const SYSTEM_PROMPT = (biz: { name: string; mode: string; level: number; limit: number; voice: string; audience: string; banned: string }) => `
You are BizPilot's operations agent for "${biz.name}", a Malaysian SME (${biz.mode} business, currency RM, timezone Asia/Kuala_Lumpur).
You run on WorkBuddy. You change and read this business's real records ONLY through the mcp__bizpilot__* tools.
For outside information (finding suppliers, market prices, competitors, regulations, trends) use WebSearch and WebFetch.

Web research rules:
- Answer the owner's question directly with what you find; do not refuse because the data is not in BizPilot.
- Give each fact its source link. Only state contact numbers, emails, addresses and opening hours that a page you fetched actually shows; if hours are not published, say "not listed" and give the source to check.
- Never present web findings as the business's own records. Offer to save a supplier with create_supplier only if the owner asks.

You are an autonomous AGENT, not a chatbot. Do the work yourself with your tools from start to finish:
- Never answer with "I can do X, would you like me to?". Just do X.
- Don't ask the owner for anything you can find with tools or the web, or cover with a sensible default (state the default you used).
- Ask only when a required fact can't be found anywhere (e.g. the owner's own TIN or bank-side facts), and still finish every other part first.
- When the owner wants to start selling something new ("I want to sell X"), load the product-launch skill and run the whole launch yourself in one go.
- You CAN make real images and videos: generate_image makes an AI image (show it as ![title](url)); make_video turns 3–6 AI scenes into a real video that renders in the owner's app and is saved on the draft. Never say you can't create images or videos.
- Work fast: call independent read tools together, don't narrate each step, keep the final summary short.
- Risky actions (money, prices, publishing, messages to customers/suppliers, e-invoices, courier bookings, stock corrections) go through the approval tools: that is how you ask permission. Everything else (reading, research, adding suppliers/products/tickets/expenses the owner mentions, drafting) you do directly.

How to work:
1. For any goal with more than one step, call share_plan first with a short numbered plan.
2. Gather facts with read tools before acting (get_business_overview is a good start). Never invent numbers, products, suppliers or customers in the business's records: if data is missing, say so and suggest what the owner should add.
3. Execute the plan with tools. If a tool returns ERROR, read it, fix the input or choose another route, and continue.
4. Money, prices, publishing, customer/supplier messages, e-invoices, courier bookings and stock corrections always go through approval tools (draft_purchase_order, request_price_change, draft_content with requestPublish, draft_review_reply, request_customer_email, request_einvoice_submit, request_shipment_booking, request_stock_adjustment, request_invoice_issue). Never claim something was sent, published or paid unless a tool result says so.
5. Automation level is ${biz.level} (1 = suggest only, 2 = draft and ask for approval, 3 = low-risk routine actions may auto-execute). Approval limit RM${biz.limit}.
6. Brand voice: ${biz.voice || 'friendly, clear, professional'}. Audience: ${biz.audience || 'Malaysian customers'}. Never use these claims: ${biz.banned || 'none set'}. Reply to customers in the language they wrote in (English, Malay or Chinese).
7. ${skillsIndex()}
8. Finish with a concise summary for the owner: what you found (with the real figures), what you did (record numbers), and which approvals are waiting for them. Use plain language, no markdown tables.
`.trim();

function push(l: Live, e: Omit<AgentEvent, 'at'>) {
  const text = e.text.length > 4000 ? `${e.text.slice(0, 4000)}…` : e.text;
  l.task.events.push({ ...e, text, at: new Date().toISOString() });
  l.task.updatedAt = new Date().toISOString();
  l.dirty = true;
}

async function flush(l: Live) {
  if (!l.dirty) return;
  l.dirty = false;
  const t = l.task;
  const { error } = await supabaseAdmin()
    .from('agent_tasks')
    .update({ status: t.status, events: t.events, result: t.result, updated_at: t.updatedAt })
    .eq('id', t.id)
    .eq('business_id', l.businessId);
  if (error) console.error('agent_tasks save failed', error.message);
}

const friendly = (name: string) =>
  name === 'WebSearch' ? 'web search' : name === 'WebFetch' ? 'web page reader' : name.replace(/^mcp__bizpilot__/, '').replace(/_/g, ' ');

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c: any) => (c?.type === 'text' ? c.text : '')).join('\n');
  return JSON.stringify(content ?? '');
}

/** Earlier messages of the same chat, so WorkBuddy can follow up on what was said. */
async function chatContext(businessId: string, conversationId: string): Promise<string> {
  const { data, error } = await supabaseAdmin()
    .from('agent_tasks')
    .select('prompt, result, events, status')
    .eq('business_id', businessId)
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(10);
  if (error) throw new Error(error.message);
  const turns = (data ?? []).reverse().map((t: any) => {
    const messages = ((t.events ?? []) as AgentEvent[]).filter((e) => e.kind === 'message').map((e) => e.text);
    const answer = [t.result, ...messages.slice(-2)].filter(Boolean).join('\n').slice(0, 4000);
    return `Owner: ${String(t.prompt).slice(0, 2000)}\nYou (WorkBuddy): ${answer || `(${t.status}, no answer)`}`;
  });
  return turns.join('\n\n').slice(-16000);
}

export function isBusinessBusy(businessId: string) {
  for (const l of live.values()) if (l.businessId === businessId) return true;
  return false;
}

export async function startTask(businessId: string, prompt: string, conversationId?: string | null): Promise<AgentTask> {
  for (const l of live.values()) {
    if (l.businessId === businessId) throw new Error('WorkBuddy is still working on the previous goal. Wait for it or cancel it.');
  }
  const history = conversationId ? await chatContext(businessId, conversationId) : '';
  const now = new Date().toISOString();
  const id = newId();
  const task: AgentTask = {
    id, conversationId: conversationId || id, prompt, mode: 'local', status: 'starting', workbuddyTaskId: null, workbuddyLink: null,
    events: [{ at: now, kind: 'status', text: 'Sending goal to WorkBuddy…' }], result: null, createdAt: now, updatedAt: now,
  };
  const { error } = await supabaseAdmin().from('agent_tasks').insert({
    id: task.id, business_id: businessId, conversation_id: task.conversationId, prompt, mode: task.mode, status: task.status, events: task.events, created_at: now, updated_at: now,
  });
  if (error) throw new Error(error.message);
  const l: Live = { task, businessId, history, abort: new AbortController(), dirty: false };
  live.set(task.id, l);
  void withRuntime(() => run(l));
  return task;
}

async function run(l: Live) {
  const timer = setInterval(() => void flush(l), 1500);
  const { task, businessId } = l;
  try {
    await restoreLogin().catch(() => false); // a goal sent right after a restart
    const db = await readSnapshot(businessId);
    const s = db.settings;
    const { server, toolNames } = buildBizPilotServer(businessId, (e) => push(l, e));
    const q = query({
      prompt: l.history
        ? `This continues an earlier conversation with the owner. Earlier messages, oldest first:\n\n${l.history}\n\n---\nThe owner's new message (answer this; "this", "it" or "yes" refer to the conversation above):\n${task.prompt}`
        : task.prompt,
      options: {
        environment,
        pathToCodebuddyCode: cliPath(),
        env: runtimeEnv(),
        cwd: sandboxDir(),
        model: process.env.WORKBUDDY_MODEL || undefined,
        // Fast by default: act with tools instead of long hidden reasoning.
        thinking: process.env.WORKBUDDY_THINKING === 'on' ? { type: 'adaptive' } : { type: 'disabled' },
        effort: (process.env.WORKBUDDY_EFFORT || 'low') as 'low',
        abortController: l.abort,
        mcpServers: { bizpilot: server },
        tools: WEB_TOOLS, // web research only: no shell or file access on the server
        allowedTools: [...toolNames, ...WEB_TOOLS],
        canUseTool: async (toolName: string, input: Record<string, unknown>) =>
          toolName.startsWith('mcp__bizpilot__') || WEB_TOOLS.includes(toolName)
            ? { behavior: 'allow' as const, updatedInput: input }
            : { behavior: 'deny' as const, message: 'Only BizPilot tools and web research are available.' },
        permissionMode: 'default',
        settingSources: [],
        persistSession: false,
        maxTurns: Number(process.env.WORKBUDDY_MAX_TURNS || 40),
        systemPrompt: {
          append: SYSTEM_PROMPT({ name: s.name, mode: s.mode, level: s.automationLevel, limit: s.approvalLimitAmount, voice: s.brandVoice, audience: s.targetAudience, banned: s.prohibitedClaims }),
        },
      } as any,
    });

    for await (const msg of q as AsyncIterable<any>) {
      switch (msg.type) {
        case 'system':
          if (msg.subtype === 'init') {
            task.status = 'running';
            task.workbuddyTaskId = msg.session_id ?? null;
            push(l, { kind: 'status', text: `WorkBuddy started${msg.model ? ` (${msg.model})` : ''}` });
            q.accountInfo?.().then((a: any) => { if (a?.email) rememberAccount(a.email); }).catch(() => undefined);
            reportRun(true);
          }
          break;
        case 'assistant':
          for (const b of msg.message?.content ?? []) {
            if (b.type === 'text' && b.text?.trim()) push(l, { kind: 'message', text: b.text.trim() });
            else if (b.type === 'thinking' && b.thinking?.trim()) push(l, { kind: 'thought', text: b.thinking.trim() });
            else if (b.type === 'tool_use' && b.name !== 'mcp__bizpilot__share_plan') {
              push(l, { kind: 'tool_call', text: friendly(b.name), data: { id: b.id, tool: b.name.replace(/^mcp__bizpilot__/, ''), input: b.input } });
            }
          }
          if (msg.error) push(l, { kind: 'error', text: String(msg.error) });
          break;
        case 'user':
          if (Array.isArray(msg.message?.content)) {
            for (const b of msg.message.content) {
              if (b.type !== 'tool_result') continue;
              const text = toolResultText(b.content);
              if (text === 'Plan shared.') continue;
              push(l, { kind: b.is_error || text.startsWith('ERROR:') ? 'error' : 'tool_result', text, data: { id: b.tool_use_id } });
            }
          }
          break;
        case 'result':
          if (msg.subtype === 'success' && !msg.is_error) {
            task.status = 'completed';
            task.result = String(msg.result ?? '').trim() || 'Done.';
          } else {
            task.status = 'failed';
            task.result = msg.subtype === 'error_max_turns' ? 'Stopped after reaching the step limit.' : (msg.errors?.join('; ') || 'WorkBuddy stopped with an error.');
            push(l, { kind: 'error', text: task.result! });
          }
          l.dirty = true;
          break;
        case 'error':
          push(l, { kind: 'error', text: String(msg.error) });
          break;
      }
    }
    if (task.status === 'running' || task.status === 'starting') {
      task.status = l.abort.signal.aborted ? 'cancelled' : 'completed';
      task.result ??= l.abort.signal.aborted ? 'Cancelled.' : 'Done.';
    }
  } catch (e) {
    const msg = (e as Error).message || String(e);
    if (l.abort.signal.aborted) {
      task.status = 'cancelled';
      task.result = 'Cancelled by owner.';
    } else {
      task.status = 'failed';
      const login = /auth|login|token|401|unauthori/i.test(msg);
      reportRun(false, msg);
      task.result = login ? 'The AI engine is offline right now (BizPilot\'s WorkBuddy account is not signed in on the server). Please contact the BizPilot administrator.' : `WorkBuddy could not run: ${msg}`;
      push(l, { kind: 'error', text: task.result });
    }
  } finally {
    clearInterval(timer);
    task.updatedAt = new Date().toISOString();
    l.dirty = true;
    await flush(l);
    live.delete(task.id);
  }
}

export function getLiveTask(taskId: string, businessId: string): AgentTask | null {
  const l = live.get(taskId);
  return l && l.businessId === businessId ? l.task : null;
}

export function cancelTask(taskId: string, businessId: string): boolean {
  const l = live.get(taskId);
  if (!l || l.businessId !== businessId) return false;
  push(l, { kind: 'status', text: 'Cancelling…' });
  l.abort.abort();
  return true;
}

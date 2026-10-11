import { UNTRUSTED_RULES, untrusted } from './untrusted.ts';
import { query } from '@tencent-ai/agent-sdk';
import type { AgentEvent, AgentTask } from '../../../src/lib/db/types.ts';
import { newId } from '../../../src/lib/db/defaults.ts';
import { supabaseAdmin } from '../lib/supabase.ts';
import { readSnapshot } from '../lib/workspace.ts';
import { buildBizPilotServer } from './tools.ts';
import { skillsIndex } from './skills.ts';
import { labelOf, teamAgents, teamIndex } from './team.ts';
import { cliPath, environment, rememberAccount, reportRun, restoreLogin, runtimeEnv, sandboxDir, withRuntime } from './workbuddy.ts';

/**
 * Runs one owner goal end-to-end on the WorkBuddy agent runtime with BizPilot's
 * tools, streaming every step into agent_tasks so the Command Centre shows it live.
 */

/** A file the owner attached in the Command Centre, already read in the browser. */
export interface Attachment {
  name: string;
  kind: 'image' | 'pdf' | 'sheet' | 'text' | 'video';
  size: number;
  /** Text read from the file (PDF text, spreadsheet as CSV, text file) */
  text?: string;
  /** JPEG images, base64 without the data: prefix (photo, PDF pages, video frames) */
  images?: string[];
  /** Private storage path of the original (images and PDFs), to keep as a receipt */
  path?: string;
  note?: string;
}

interface Live {
  task: AgentTask;
  attachments: Attachment[];
  businessId: string;
  history: string;
  abort: AbortController;
  dirty: boolean;
  /** Set when this server is shutting down: the run stops but stays open for the next server to pick up. */
  handoff?: boolean;
  /** Steps already done before a restart, for a resumed run. */
  resumeNote?: string;
  /** Asks the running WorkBuddy query to stop (set once it starts). */
  interrupt?: () => void;
}
const live = new Map<string, Live>();

const WEB_TOOLS = ['WebSearch', 'WebFetch'];
/** WorkBuddy's sub-agent tool (named Agent; Task in older runtimes). */
const AGENT_TOOLS = ['Agent', 'Task'];
const multiAgent = () => process.env.WORKBUDDY_TEAM !== 'off';

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
- You run the WHOLE business, not one screen. Every module is yours: products, variants, batches, stock, locations, transfers, stock counts, suppliers, purchase orders, production, sales orders, customers, returns, invoices, quotations, payments, bills, cash, marketing content, campaigns, reviews, tickets, couriers, marketplaces, e-invoices, business settings. There is a tool for each.
- Treat the business as one connected system. After any step, do the follow-on work in the other modules yourself:
  stock received → check it has a price, margin and listing copy, then draft marketing content to sell it;
  stock running low → move spare stock from another location first, else plan production (if it has a recipe), else draft a purchase order within the cash available;
  sale recorded → invoice it if the customer needs one, book shipping for online orders, update reorder plans;
  invoice late → payment reminder; cash low → slow down buying, chase receivables, tell the owner;
  bad review → reply draft and a support ticket; expiring batch → promotion content or hold the stock.
- get_signals lists what needs attention right now; use it whenever you are deciding what to do next.
- Approval rules (blueprint §12). Do directly, no approval: reading, research, reports, drafts (POs, invoices, quotations, content, replies), creating or editing products, suppliers, locations, tickets, expenses and settings the owner told you or you found, moving stock between the business's own locations, starting stock counts, recording facts that a person or a connected system confirmed (goods arrived, customer paid, bill paid), cancelling unpaid orders, notifying the owner.
  Send to Approvals with the approval tools: anything that spends money (purchase orders, production, courier bookings, ad budgets), changes a selling price, publishes content, sends a message to a customer or supplier (emails, reminders, quotations, review replies), issues an invoice or e-invoice, gives a refund, or corrects stock counts. That is how you ask permission.
  Never record a payment, a delivery or a count that nobody confirmed.

How to work:
1. For any goal with more than one step, call share_plan first with a short numbered plan.
2. Gather facts with read tools before acting (get_business_overview is a good start). Never invent numbers, products, suppliers or customers in the business's records: if data is missing, say so and suggest what the owner should add.
3. Execute the plan with tools. If a tool returns ERROR, read it, fix the input or choose another route, and continue.
4. Follow the approval rules above. Never claim something was sent, published or paid unless a tool result says so.
5. Automation level is ${biz.level} (1 = suggest only, 2 = draft and ask for approval, 3 = low-risk routine actions may auto-execute). Approval limit RM${biz.limit}.
6. Brand voice: ${biz.voice || 'friendly, clear, professional'}. Audience: ${biz.audience || 'Malaysian customers'}. Never use these claims: ${biz.banned || 'none set'}. Reply to customers in the language they wrote in (English, Malay or Chinese).
7. ${skillsIndex()}
${multiAgent() ? `
You lead BizPilot's agent team (WorkBuddy sub-agents). Each member is a specialist with its own skills and tools:
${teamIndex()}
How to lead the team:
- A quick question or a single action: do it yourself, don't delegate (speed matters).
- A goal that touches two or more areas (launching a product, restocking and promoting, month-end, a weekly review): call share_plan with each step marked by the agent that owns it, e.g. "1. [research-agent] find suppliers and market prices".
- Run independent steps IN PARALLEL: call the Agent tool several times in ONE message, one per member (subagent_type = the member's name). Use as few waves as possible: every wave costs minutes. Start work that doesn't need earlier results (e.g. marketing images and drafts) in the FIRST wave; run a step later only if it truly needs another step's output.
- Speed matters more than polish: use only the members the goal needs, and tell research-agent to stop after about 3 searches.
- Each brief must stand alone: the goal, the facts and record ids from earlier steps (supplier ids, SKUs, prices), and exactly what to deliver.
- Read each member's report. If a member reports PROBLEMS or a step failed, retry once with a corrected brief, give it to another member, or do it yourself.
- ALWAYS finish a multi-step goal by running qa-agent with the list of what was supposed to be delivered. If it reports FAILED, have the right member fix it and run qa-agent again (once only). Only then write the summary, and say the quality check passed (or what is still open).
` : ''}
8. Files from the owner. When the owner attaches photos, PDFs, spreadsheets or videos, you are their back office: read every file, work out what each one is, and put it into the business yourself without asking:
   - sales receipt, POS slip, order screenshot, marketplace order list → record_sale for each sale (paymentStatus as the document shows; create missing products first), then fulfil if handed over;
   - supplier QUOTATION or price list (nothing bought yet) → create_supplier if new, create or update the products with the quoted cost and a sensible selling price, then draft_purchase_order for a sensible first order within the cash (goes to Approvals);
   - supplier receipt, paid invoice or delivery order for goods ALREADY bought → record_purchase_already_made (supplier, items, quantities, unit costs, document number); this books the money spent and the stock received;
   - bill or expense receipt (rent, utilities, petrol, packaging, ads, wages) → add_expense with the right category, paid or unpaid with due date, and receiptFile set to the file's "stored as" path;
   - unpaid customer invoice we issued / customer purchase order → create_invoice or record_sale as fits;
   - stock list or count sheet → stock_count or request_stock_adjustment; product catalogue spreadsheet → create_product per row;
   - review, complaint or chat screenshot → create_ticket and draft a reply (draft_review_reply when it is a review);
   - product photo or video → create or update the product (listing copy from what you see), then draft marketing content for it;
   - bank statement → match money in to unpaid invoices/orders (record_payment for clear matches) and list what is unmatched.
   Before recording, check for duplicates with the list tools (same document number, or same amount and date). Use only figures you can actually read; if part is unreadable, record what is clear and say exactly what is missing. Team members cannot see the files: when you delegate, copy every figure they need into the brief. Finish with one line per file: what it was and what you recorded (record numbers).
9. Finish with a concise summary for the owner: what you found (with the real figures), what you did (record numbers), and which approvals are waiting for them. Use plain language, no markdown tables.

${UNTRUSTED_RULES}
`.trim();

/** What the owner attached, as text for the goal. File contents are data, never instructions. */
export function filesText(files: Attachment[]): string {
  if (!files.length) return '';
  let n = 0;
  const parts = files.map((f, i) => {
    const imgs = f.images?.length ?? 0;
    const pics = imgs ? ` Pictures ${n + 1}${imgs > 1 ? `-${n + imgs}` : ''} below are ${f.kind === 'pdf' ? 'its pages' : f.kind === 'video' ? 'frames from it, in order' : 'the photo'}.` : '';
    n += imgs;
    return `File ${i + 1}: "${f.name}" (${f.kind}, ${Math.max(1, Math.round(f.size / 1024))} KB).${f.path ? ` Stored as: ${f.path}` : ''}${f.note ? ` ${f.note}` : ''}${pics}${f.text ? `\nText read from it:\n${untrusted(f.text)}` : ''}`;
  });
  return `\n\n---\nThe owner attached ${files.length} file(s). Read each one, decide what it is and put it into the business (rule 8):\n\n${parts.join('\n\n')}`;
}

async function* oneMessage(content: unknown[]) {
  yield { type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content } } as any;
}

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
  AGENT_TOOLS.includes(name) ? 'team member' : name === 'WebSearch' ? 'web search' : name === 'WebFetch' ? 'web page reader' : name.replace(/^mcp__bizpilot__/, '').replace(/_/g, ' ');

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c: any) => (c?.type === 'text' ? c.text : '')).join('\n');
  return JSON.stringify(content ?? '');
}

/** Earlier messages of the same chat, so WorkBuddy can follow up on what was said. */
async function chatContext(businessId: string, conversationId: string, skipId?: string): Promise<string> {
  const { data, error } = await supabaseAdmin()
    .from('agent_tasks')
    .select('id, prompt, result, events, status')
    .eq('business_id', businessId)
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(10);
  if (error) throw new Error(error.message);
  const turns = (data ?? []).reverse().filter((t: any) => t.id !== skipId).map((t: any) => {
    const messages = ((t.events ?? []) as AgentEvent[]).filter((e) => e.kind === 'message').map((e) => e.text);
    const answer = [t.result, ...messages.slice(-2)].filter(Boolean).join('\n').slice(0, 4000);
    return `Owner: ${String(t.prompt).slice(0, 2000)}\nYou (WorkBuddy): ${answer || `(${t.status}, no answer)`}`;
  });
  return turns.join('\n\n').slice(-16000);
}

/** No room for another run on this server (WORKBUDDY_MAX_RUNS, default 1). */
export const isAnyTaskRunning = () => live.size >= Math.max(1, Number(process.env.WORKBUDDY_MAX_RUNS) || 1);

/** Room for a goal BizPilot starts by itself: on a bigger server one place stays free for the owner. */
export const hasRoomForBackground = () => live.size < Math.max(1, (Number(process.env.WORKBUDDY_MAX_RUNS) || 1) - 1);

export function isBusinessBusy(businessId: string) {
  for (const l of live.values()) if (l.businessId === businessId) return true;
  return false;
}

/** Goals BizPilot started by itself (reactor, daily autopilot): they give way to the owner. */
const isBackground = (conversationId?: string | null) => /^(auto|autopilot)-/.test(conversationId ?? '');

/**
 * The owner's goal goes first: background runs are paused (left open, so the resume
 * check continues them once the server is free) instead of making the owner wait.
 */
function pauseBackgroundRuns() {
  if ([...live.values()].filter((x) => !x.handoff).length < maxRuns()) return; // room for both
  for (const l of live.values()) {
    if (!isBackground(l.task.conversationId) || l.handoff) continue;
    l.handoff = true;
    push(l, { kind: 'status', text: 'Paused so the owner\'s goal can go first. This continues by itself afterwards.', data: { handoff: true } });
    l.abort.abort();
    l.interrupt?.();
  }
}

export async function startTask(businessId: string, prompt: string, conversationId?: string | null, attachments: Attachment[] = []): Promise<AgentTask> {
  if (!isBackground(conversationId ?? '')) pauseBackgroundRuns();
  for (const l of live.values()) {
    if (l.businessId === businessId && !l.handoff) throw new Error('WorkBuddy is still working on the previous goal. Wait for it or cancel it.');
  }
  const history = conversationId ? await chatContext(businessId, conversationId) : '';
  const now = new Date().toISOString();
  const id = newId();
  const task: AgentTask = {
    id, conversationId: conversationId || id, prompt, mode: 'local', status: 'starting', workbuddyTaskId: null, workbuddyLink: null,
    events: [
      ...(attachments.length ? [{ at: now, kind: 'status' as const, text: `Received ${attachments.length} file(s): ${attachments.map((a) => a.name).join(', ')}`, data: { attachments: attachments.map(({ name, kind, size, path, note }) => ({ name, kind, size, path, note })) } }] : []),
      { at: now, kind: 'status', text: 'Sending goal to WorkBuddy…' },
    ], result: null, createdAt: now, updatedAt: now,
  };
  const { error } = await supabaseAdmin().from('agent_tasks').insert({
    id: task.id, business_id: businessId, conversation_id: task.conversationId, prompt, mode: task.mode, status: task.status, events: task.events, created_at: now, updated_at: now,
  });
  if (error) throw new Error(error.message);
  const l: Live = { task, attachments, businessId, history, abort: new AbortController(), dirty: false };
  live.set(task.id, l);
  enqueue(l);
  return task;
}

/**
 * How many WorkBuddy runs at once on this server (each run is a ~250 MB process). Render's
 * free plan has 512 MB, so the default is 1; a bigger machine sets WORKBUDDY_MAX_RUNS.
 * Goals beyond that wait in line instead of crashing the server.
 */
const maxRuns = () => Math.max(1, Number(process.env.WORKBUDDY_MAX_RUNS) || 1);
let running = 0;
const waiting: Live[] = [];
function enqueue(l: Live) {
  if (running >= maxRuns()) {
    push(l, { kind: 'status', text: 'Waiting for BizPilot to finish another goal first…' });
    void flush(l);
  }
  waiting.push(l);
  next();
}
function next() {
  while (running < maxRuns() && waiting.length) {
    const l = waiting.shift()!;
    running++;
    void withRuntime(() => run(l)).catch((e) => console.error('agent run', e)).finally(() => { running--; next(); });
  }
}

async function run(l: Live) {
  if (l.abort.signal.aborted) { // stopped while waiting in line
    if (!l.handoff) { l.task.status = 'cancelled'; l.task.result ??= 'Stopped by owner.'; }
    l.dirty = true;
    await flush(l);
    live.delete(l.task.id);
    return;
  }
  let beat = 0;
  const timer = setInterval(() => {
    // Heartbeat: a long web read still shows this run is alive, so no other server takes it over.
    if (++beat % 10 === 0) { l.task.updatedAt = new Date().toISOString(); l.dirty = true; }
    void flush(l);
  }, 1500);
  const { task, businessId } = l;
  try {
    await restoreLogin().catch(() => false); // a goal sent right after a restart
    const db = await readSnapshot(businessId);
    const s = db.settings;
    const { server, toolNames } = buildBizPilotServer(businessId, (e) => push(l, e), task.createdAt);
    const team = multiAgent() ? teamAgents(toolNames, WEB_TOOLS) : undefined;
    const env = runtimeEnv();
    if (team) {
      env.CODEBUDDY_DISABLE_BUILTIN_SUBAGENTS = '1'; // only BizPilot's team, no coding agents
      env.CODEBUDDY_SUBAGENT_TIMEOUT_MS ||= '240000'; // a stuck member hands back to the lead instead of hanging
    }
    /** Lead's Agent tool call id -> member name, to label each member's steps. */
    const members = new Map<string, string>();
    const text = (l.resumeNote ? `${l.resumeNote}\n\n---\nThe owner's goal:\n` : '') + (l.history
      ? `This continues an earlier conversation with the owner. Earlier messages, oldest first:\n\n${l.history}\n\n---\nThe owner's new message (answer this; "this", "it" or "yes" refer to the conversation above):\n${task.prompt}`
      : task.prompt) + filesText(l.attachments);
    const images = l.attachments.flatMap((a) => a.images ?? []);
    const q = query({
      // With pictures, the goal goes in as one message of text plus images (WorkBuddy reads them directly).
      prompt: images.length ? oneMessage([{ type: 'text', text }, ...images.map((data) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } }))]) : text,
      options: {
        environment,
        pathToCodebuddyCode: cliPath(),
        env,
        cwd: sandboxDir(),
        model: process.env.WORKBUDDY_MODEL || undefined,
        // Fast by default: act with tools instead of long hidden reasoning.
        thinking: process.env.WORKBUDDY_THINKING === 'on' ? { type: 'adaptive' } : { type: 'disabled' },
        effort: (process.env.WORKBUDDY_EFFORT || 'low') as 'low',
        abortController: l.abort,
        mcpServers: { bizpilot: server },
        tools: team ? [...WEB_TOOLS, ...AGENT_TOOLS] : WEB_TOOLS, // web research and the team only: no shell or file access on the server
        allowedTools: [...toolNames, ...WEB_TOOLS, ...(team ? AGENT_TOOLS : [])],
        ...(team ? { agents: team } : {}),
        canUseTool: async (toolName: string, input: Record<string, unknown>) =>
          toolName.startsWith('mcp__bizpilot__') || WEB_TOOLS.includes(toolName) || (team && AGENT_TOOLS.includes(toolName))
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

    l.interrupt = () => { void q.interrupt?.().catch(() => undefined); };
    for await (const msg of q as AsyncIterable<any>) {
      if (l.abort.signal.aborted) break; // Stop or shutdown: don't wait for team members to finish
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
        case 'assistant': {
          // Steps inside a team member carry the id of the lead's Agent call that started it.
          const agent = msg.parent_tool_use_id ? members.get(msg.parent_tool_use_id) ?? 'team member' : undefined;
          for (const b of msg.message?.content ?? []) {
            if (b.type === 'text' && b.text?.trim()) push(l, agent ? { kind: 'thought', text: b.text.trim(), data: { agent } } : { kind: 'message', text: b.text.trim() });
            else if (b.type === 'thinking' && b.thinking?.trim()) push(l, { kind: 'thought', text: b.thinking.trim(), data: agent ? { agent } : undefined });
            else if (b.type === 'tool_use' && AGENT_TOOLS.includes(b.name)) {
              const name = String(b.input?.subagent_type ?? 'team member');
              members.set(b.id, name);
              push(l, { kind: 'status', text: `${labelOf(name)} started: ${String(b.input?.description ?? '').slice(0, 200)}`, data: { id: b.id, agent: name, team: 'started', brief: String(b.input?.prompt ?? '').slice(0, 1500) } });
            } else if (b.type === 'tool_use' && b.name !== 'mcp__bizpilot__share_plan') {
              push(l, { kind: 'tool_call', text: friendly(b.name), data: { id: b.id, tool: b.name.replace(/^mcp__bizpilot__/, ''), input: b.input, agent } });
            }
          }
          if (msg.error) push(l, { kind: 'error', text: String(msg.error) });
          break;
        }
        case 'user':
          if (Array.isArray(msg.message?.content)) {
            const agent = msg.parent_tool_use_id ? members.get(msg.parent_tool_use_id) ?? 'team member' : undefined;
            for (const b of msg.message.content) {
              if (b.type !== 'tool_result') continue;
              const text = toolResultText(b.content);
              if (text === 'Plan shared.') continue;
              const member = members.get(b.tool_use_id);
              if (member) {
                // A team member finished: its report goes back to the lead.
                const failed = Boolean(b.is_error) || /^(error|failed)\b/i.test(text.trim());
                push(l, { kind: 'status', text: `${labelOf(member)} ${failed ? 'stopped with a problem' : 'finished'}`, data: { id: b.tool_use_id, agent: member, team: failed ? 'failed' : 'done' } });
                push(l, { kind: failed ? 'error' : 'tool_result', text, data: { id: b.tool_use_id, agent: member, report: true } });
                continue;
              }
              push(l, { kind: b.is_error || text.startsWith('ERROR:') ? 'error' : 'tool_result', text, data: { id: b.tool_use_id, agent } });
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
    if (l.handoff) task.status = 'running';
    else if (task.status === 'running' || task.status === 'starting') {
      task.status = l.abort.signal.aborted ? 'cancelled' : 'completed';
      task.result ??= l.abort.signal.aborted ? 'Cancelled.' : 'Done.';
    }
  } catch (e) {
    const msg = (e as Error).message || String(e);
    if (l.handoff) {
      task.status = 'running'; // the next server continues it
    } else if (l.abort.signal.aborted) {
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

export async function cancelTask(taskId: string, businessId: string): Promise<boolean> {
  const l = live.get(taskId);
  if (l && l.businessId === businessId) {
    push(l, { kind: 'status', text: 'Stopping…' });
    l.interrupt?.();
    l.abort.abort();
    // Team members can take a while to wind down: the owner's Stop counts straight away.
    setTimeout(() => {
      if (live.get(taskId) !== l) return;
      l.task.status = 'cancelled';
      l.task.result = 'Stopped by owner.';
      l.dirty = true;
      void flush(l).finally(() => live.delete(taskId));
    }, 5_000);
    return true;
  }
  // Not on this server (it was cut off by a restart and is waiting to be picked up): close it so it isn't resumed.
  const { data, error } = await supabaseAdmin()
    .from('agent_tasks')
    .update({ status: 'cancelled', result: 'Cancelled by owner.', updated_at: new Date().toISOString() })
    .eq('id', taskId)
    .eq('business_id', businessId)
    .in('status', ['starting', 'running', 'waiting_permission'])
    .select('id');
  if (error) throw new Error(error.message);
  return Boolean(data?.length);
}

/**
 * Server shutting down (a deploy or restart): stop each run and leave it open, so the
 * next server continues it instead of the owner's work being lost.
 */
export async function handOffRuns() {
  const runs = [...live.values()];
  for (const l of runs) {
    l.handoff = true;
    push(l, { kind: 'status', text: 'BizPilot\'s server is restarting. This goal continues by itself in a moment.', data: { handoff: true } });
    l.abort.abort();
  }
  await Promise.all(runs.map((l) => flush(l).catch(() => undefined)));
}

/** An event's extra fields (stored as JSON). */
const dataOf = (e: AgentEvent) => (e.data && typeof e.data === 'object' ? e.data : {}) as Record<string, any>;

const MAX_RESUMES = 2;
const STALE_MS = 90_000;

/** What a cut-off run already did, so the resumed run carries on instead of starting over. */
export function doneSoFar(events: AgentEvent[]): string {
  const lines: string[] = [];
  for (const e of events) {
    if (e.kind === 'tool_call') lines.push(`- ${dataOf(e).agent ? `${dataOf(e).agent}: ` : ''}called ${String(dataOf(e).tool ?? e.text)} ${JSON.stringify(dataOf(e).input ?? {}).slice(0, 300)}`);
    else if (e.kind === 'tool_result' || e.kind === 'error') lines.push(`  result: ${e.text.replace(/\s+/g, ' ').slice(0, 300)}`);
    else if (e.kind === 'message') lines.push(`- you said: ${e.text.replace(/\s+/g, ' ').slice(0, 400)}`);
    else if (e.kind === 'status' && dataOf(e).team === 'done') lines.push(`- ${e.text}`);
  }
  const text = lines.join('\n');
  return text.length > 12_000 ? `…(earlier steps cut)\n${text.slice(-12_000)}` : text;
}

/**
 * Picks up goals that a restart cut off (this server's runs heartbeat every 15 s,
 * so an open goal nobody has touched for 90 s, or one handed off at shutdown, is orphaned).
 * One at a time; a goal is resumed at most twice, then closed with an explanation.
 */
export async function resumeInterruptedTasks() {
  if (isAnyTaskRunning()) return; // the small server runs one WorkBuddy at a time; the next check picks up the rest
  const admin = supabaseAdmin();
  const { data, error } = await admin
    .from('agent_tasks')
    .select('*')
    .in('status', ['starting', 'running', 'waiting_permission'])
    .gte('updated_at', new Date(Date.now() - 6 * 3600_000).toISOString())
    .order('created_at')
    .limit(20);
  if (error) throw new Error(error.message);
  for (const row of data ?? []) {
    const id = String(row.id);
    const businessId = String(row.business_id);
    if (live.has(id) || isBusinessBusy(businessId)) continue;
    const events = (row.events ?? []) as AgentEvent[];
    const handedOff = events.findLastIndex((e) => dataOf(e).handoff) > events.findLastIndex((e) => dataOf(e).resumed);
    if (!handedOff && Date.now() - new Date(String(row.updated_at)).getTime() < STALE_MS) continue; // still alive elsewhere
    const resumes = events.filter((e) => dataOf(e).resumed).length;
    const now = new Date().toISOString();
    if (resumes >= MAX_RESUMES) {
      await admin.from('agent_tasks').update({
        status: 'failed', updated_at: now,
        result: 'Stopped: this goal was interrupted several times. The steps above were saved; send the goal again to finish it.',
      }).eq('id', id).in('status', ['starting', 'running', 'waiting_permission']);
      continue;
    }
    // Claim it: only if no one changed it since we read it (another server, or the owner cancelling).
    const claim = await admin.from('agent_tasks').update({ updated_at: now }).eq('id', id).eq('updated_at', row.updated_at).select('id');
    if (claim.error || !claim.data?.length) continue;

    const task: AgentTask = {
      id, conversationId: String(row.conversation_id ?? id), prompt: String(row.prompt), mode: 'local', status: 'running',
      workbuddyTaskId: null, workbuddyLink: null, events, result: null, createdAt: String(row.created_at), updatedAt: now,
    };
    // Team members cut off mid-job: close them in the team strip.
    const open = new Map<string, string>();
    for (const e of events) {
      const d = dataOf(e) as { id?: string; agent?: string; team?: string };
      if (d.team === 'started' && d.id) open.set(d.id, String(d.agent));
      else if (d.team && d.id) open.delete(d.id);
    }
    const l: Live = { task, attachments: [], businessId, history: '', abort: new AbortController(), dirty: true };
    for (const [mid, agent] of open) push(l, { kind: 'status', text: `${labelOf(agent)} was cut off by the restart`, data: { id: mid, agent, team: 'failed' } });
    push(l, { kind: 'status', text: 'Continuing where BizPilot stopped…', data: { resumed: true } });
    const fileEvent = events.find((e) => Array.isArray(dataOf(e).attachments));
    const files = (fileEvent ? dataOf(fileEvent).attachments : undefined) as { name: string; path?: string }[] | undefined;
    l.history = row.conversation_id && row.conversation_id !== id ? await chatContext(businessId, String(row.conversation_id), id).catch(() => '') : '';
    l.resumeNote = [
      'IMPORTANT: you already started this goal, but you were cut off (BizPilot\'s server restarted, or the owner\'s own goal went first). Continue from where you stopped.',
      'Do NOT redo steps listed below (records they created already exist; check with read tools if unsure) and do not create duplicates.',
      files?.length ? `The owner had attached: ${files.map((f) => `"${f.name}"${f.path ? ` (stored as ${f.path})` : ''}`).join(', ')}. Their contents are no longer available; rely on what the steps below already recorded.` : '',
      `Steps already done:\n${doneSoFar(events) || '(none yet)'}`,
    ].filter(Boolean).join('\n');
    live.set(id, l);
    enqueue(l);
    return;
  }
}

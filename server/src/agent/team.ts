import { getSkill } from './skills.ts';

/**
 * The BizPilot agent team: specialist WorkBuddy sub-agents, each built from
 * BizPilot skills (server/skills) and limited to the tools of its area. The
 * lead agent (runner.ts) breaks the owner's goal down, runs independent parts
 * in parallel through WorkBuddy's Agent tool, and has the quality-check agent
 * verify the result before answering.
 */

export interface TeamMember {
  name: string;
  label: string;
  description: string;
  skills: string[];
  /** BizPilot tools (without the mcp__bizpilot__ prefix) on top of the shared read tools */
  tools: string[];
  web: boolean;
}

/** Every member can read the whole business and tell the owner things. */
const SHARED = [
  'get_business_overview', 'get_business_profile', 'list_products', 'list_suppliers', 'list_purchase_orders', 'list_orders',
  'list_invoices', 'list_quotations', 'list_expenses', 'list_reviews', 'list_tickets', 'list_marketing', 'list_approvals',
  'list_customers', 'list_locations', 'list_returns', 'list_staff_tasks', 'get_signals', 'get_cash_flow', 'get_inventory_health',
  'get_reorder_suggestions', 'get_production_overview', 'get_receivables_payables', 'get_budget_vs_actual', 'get_invoice',
  'get_pick_list', 'sales_report', 'profit_and_loss', 'business_report', 'compare_branches', 'check_consent',
  'check_content_compliance', 'check_buyer_tin', 'load_skill', 'notify_owner',
];

export const TEAM: TeamMember[] = [
  {
    name: 'research-agent', label: 'Research agent', web: true,
    description: 'Web research: real Malaysian suppliers with prices and contacts, Shopee/Lazada market prices, competitors, courier rates, rules. Can save suppliers. Use first when a goal needs outside facts.',
    skills: ['market-research'],
    tools: ['create_supplier', 'update_supplier', 'read_owner_website'],
  },
  {
    name: 'inventory-agent', label: 'Inventory agent', web: true,
    description: 'Products, variants, batches, stock, locations and transfers, stock counts, warehouse bins and staff tasks, suppliers, purchase orders, production and recipes. Use to create or price products, restock, receive goods or fix stock, and to copy products and stock from the owner\'s own website.',
    skills: ['inventory-management', 'business-setup', 'website-import', 'market-research'],
    tools: [
      'create_product', 'update_product', 'create_variants', 'set_batch_tracking', 'hold_stock', 'record_stock_movement', 'request_stock_adjustment',
      'request_price_change', 'create_supplier', 'update_supplier', 'draft_purchase_order', 'receive_purchase_order', 'cancel_purchase_order', 'record_purchase_already_made',
      'set_recipe', 'plan_production', 'buy_production_materials', 'start_production', 'complete_production', 'cancel_production',
      'create_location', 'update_location', 'transfer_stock', 'ship_transfer', 'receive_transfer', 'cancel_transfer', 'stock_count',
      'set_bin', 'create_staff_task', 'update_staff_task', 'read_owner_website',
    ],
  },
  {
    name: 'sales-agent', label: 'Sales & fulfilment agent', web: false,
    description: 'Orders, payments, marketplace sync, pick and pack, courier quotes and bookings, returns, support tickets, customer messages, PDPA consent and data requests, and bringing in orders from the owner\'s own website.',
    skills: ['sales-fulfilment', 'website-import'],
    tools: [
      'record_sale', 'fulfil_order', 'cancel_order', 'record_payment', 'sync_marketplace', 'start_pick_run', 'pack_order', 'quote_shipping',
      'request_shipment_booking', 'record_return', 'resolve_return', 'reject_return', 'create_ticket', 'update_ticket', 'request_customer_email',
      'record_consent', 'customer_data_request', 'create_staff_task', 'update_staff_task', 'read_owner_website', 'import_website_orders',
    ],
  },
  {
    name: 'finance-agent', label: 'Finance agent', web: false,
    description: 'Cash, profit, pricing maths, break-even, expenses and bills, budgets, invoices, quotations, payment reminders, repeating invoices, LHDN MyInvois e-invoices.',
    skills: ['finance-ledger', 'einvoice-prep'],
    tools: [
      'create_invoice', 'request_invoice_issue', 'cancel_invoice', 'create_quotation', 'send_quotation', 'quotation_outcome', 'send_payment_reminder',
      'set_recurring_invoice', 'request_einvoice_submit', 'add_expense', 'pay_bill', 'record_payment', 'set_budget', 'update_business_settings',
    ],
  },
  {
    name: 'marketing-agent', label: 'Marketing agent', web: true,
    description: 'Marketing posts, listing copy, AI images and videos, campaigns, weekly content plans, review replies. Everything is drafted; publishing goes to Approvals.',
    skills: ['marketing-content', 'bizpilot-marketing'],
    tools: [
      'draft_content', 'update_content', 'submit_content', 'generate_image', 'make_video', 'create_campaign', 'update_campaign',
      'draft_review_reply', 'escalate_review', 'update_business_settings',
    ],
  },
  {
    name: 'qa-agent', label: 'Quality check agent', web: false,
    description: 'Checks the team\'s work before the owner sees it: runs verify_work, compares the result with the brief, fixes or cancels wrong drafts, returns PASSED or FAILED. Run it last on every multi-step goal.',
    skills: ['quality-check'],
    tools: ['verify_work', 'update_product', 'update_content', 'cancel_purchase_order', 'cancel_invoice', 'cancel_order'],
  },
];

export const labelOf = (name: string) => TEAM.find((m) => m.name === name)?.label ?? (name ? name.replace(/-/g, ' ') : 'Agent');

const MEMBER_RULES = `
Rules for every BizPilot team member:
- You are part of BizPilot's agent team on WorkBuddy, working for one Malaysian SME (RM, Asia/Kuala_Lumpur). The team lead gave you a brief; do all of it with your tools, without asking questions back.
- Change records ONLY through the mcp__bizpilot__* tools. Never invent numbers, products, suppliers, customers or contacts.
- Do directly: reads, research, drafts, creating or editing products/suppliers/locations/tickets/expenses, internal stock moves, starting counts, recording facts a person or system confirmed.
- Goes to Approvals (the request_*/draft tools do this): spending money, price changes, publishing, messages to customers or suppliers, issuing invoices or e-invoices, refunds, stock corrections. Never record a payment, delivery or count nobody confirmed.
- If a tool returns ERROR, read it, fix the input or take another route, and carry on. If something truly cannot be done, report it under PROBLEMS.
- Work fast: call independent tools together. No narration. Web research: at most 3 searches and 3 page reads, then use what you found.
- Finish with a short report: DONE (with record numbers and real figures), WAITING FOR APPROVAL, PROBLEMS, ASSUMED.`.trim();

/** WorkBuddy sub-agent definitions, limited to tools that exist on this server. */
export function teamAgents(available: string[], webTools: string[]) {
  const have = new Set(available);
  const out: Record<string, { description: string; prompt: string; tools: string[] }> = {};
  for (const mbr of TEAM) {
    const tools = [...new Set([...SHARED, ...mbr.tools])].map((t) => `mcp__bizpilot__${t}`).filter((t) => have.has(t));
    const playbooks = mbr.skills.map((s) => getSkill(s)).filter(Boolean).map((s) => `## Skill: ${s!.name}\n${s!.body}`).join('\n\n');
    out[mbr.name] = {
      description: mbr.description,
      prompt: `You are BizPilot's ${mbr.label}.\n${mbr.description}\n\n${MEMBER_RULES}\n\n${playbooks}`,
      tools: mbr.web ? [...tools, ...webTools] : tools,
    };
  }
  return out;
}

export function teamIndex() {
  return TEAM.map((m) => `- ${m.name}: ${m.description}`).join('\n');
}

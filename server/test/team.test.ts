import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { emptyDB } from '../../src/lib/db/defaults.ts';
import * as ops from '../../src/lib/ops.ts';
import { verifyWork } from '../../src/lib/verify.ts';
import { TEAM, teamAgents } from '../src/agent/team.ts';

const A = 'WorkBuddy agent';

test('every team member is built from real skills and only real tools', () => {
  const declared = [...readFileSync(new URL('../src/agent/tools.ts', import.meta.url), 'utf8').matchAll(/tool\(\s*'([a-z_]+)'/g)].map((m) => `mcp__bizpilot__${m[1]}`);
  const agents = teamAgents(declared, ['WebSearch', 'WebFetch']);
  assert.equal(Object.keys(agents).length, TEAM.length);
  for (const m of TEAM) {
    const def = agents[m.name];
    for (const t of m.tools) assert.ok(def.tools.includes(`mcp__bizpilot__${t}`), `${m.name} is missing ${t}`);
    for (const s of m.skills) assert.ok(def.prompt.includes(`## Skill: ${s}`), `${m.name} is missing skill ${s}`);
    assert.equal(def.tools.includes('WebSearch'), m.web);
  }
  assert.ok(!agents['qa-agent'].tools.some((t) => /draft_purchase_order|record_payment|request_/.test(t)), 'the reviewer cannot spend or send');
});

test('verify_work flags a loss-making product, a wrong PO and placeholder content, and passes good work', () => {
  const db = emptyDB();
  db.settings.openingCash = 500;
  db.settings.prohibitedClaims = 'best in Malaysia';
  const since = new Date(Date.now() - 1000).toISOString();
  const bad = ops.createProduct(db, { name: 'Paddle', sku: 'PAD', price: 50, unitCost: 60 }, A);
  const sup = ops.createSupplier(db, { name: 'Sukan Sdn Bhd' }, A);
  const po = ops.createPurchaseOrder(db, { supplierId: sup.id, lines: [{ productId: bad.id, quantity: 20, unitCost: 60 }] }, A);
  ops.addContentItem(db, { title: 'Launch', platform: 'Facebook', type: 'post', body: 'Get the [product] now, best in Malaysia!', imageUrl: '', scheduledDate: '' }, A);
  const v = verifyWork(db, since, A);
  assert.equal(v.passed, false);
  const problems = v.checks.filter((c) => !c.ok).map((c) => `${c.area}:${c.problem}`).join('\n');
  assert.match(problems, /product:sells at RM50 but costs RM60/);
  assert.match(problems, /purchase order:RM1200 is more than the RM500/);
  assert.match(problems, /supplier:no email/);
  assert.match(problems, /content:/);

  // the team fixes it
  ops.updateProduct(db, bad.id, { price: 99 }, A);
  ops.cancelPurchaseOrder(db, po.id, A);
  for (const c of db.contentItems) c.body = 'Our new pickleball paddle is here. Light, strong and ready for weekend games. Order on Shopee today.';
  const again = verifyWork(db, since, A);
  assert.equal(again.errors, 0, JSON.stringify(again.checks.filter((c) => !c.ok)));
  assert.equal(again.passed, true);
  // work done by people is not the agent's to check
  assert.equal(verifyWork(db, since, 'someone else').checked, 0);
});

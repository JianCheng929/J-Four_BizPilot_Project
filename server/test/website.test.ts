import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describeJson, fetchSitePath, siteOrigin, surveySite } from '../src/lib/siteReader.ts';

// A small self-hosted shop like the ones owners already run.
const shop = createServer((req, res) => {
  const json = (d: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(d)); };
  if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); return res.end('<html><head><title>Ah Huat Snacks</title><script>fetch("/api/orders")</script></head><body><h1>Ah Huat Snacks</h1><p>Free delivery in KL via J&amp;T</p><a href="/shipping">Shipping</a><a href="https://evil.example/x">x</a></body></html>'); }
  if (req.url === '/api/shop') return json({ name: 'Ah Huat Snacks', currency: 'MYR' });
  if (req.url === '/api/products') return json({ products: [{ sku: 'KR-01', name: 'Kerepek Pisang', price: 8.5, image_url: null }, { sku: 'KR-02', name: 'Kuih Bangkit', price: 12 }] });
  if (req.url === '/api/orders') return json([{ id: 'o1', sku: 'KR-01', qty: 3, total: 25.5, channel: 'Shopee' }]);
  if (req.url === '/old') { res.statusCode = 302; res.setHeader('Location', 'https://evil.example/'); return res.end(); }
  res.statusCode = 404; res.end('not found');
});

test('reads a self-hosted shop: pages, data feeds, and only that site', async () => {
  process.env.SITE_READER_ALLOW_PRIVATE = '1';
  await new Promise<void>((ok) => shop.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${(shop.address() as AddressInfo).port}`;
  try {
    const s = await surveySite(base);
    assert.equal(s.title, 'Ah Huat Snacks');
    assert.match(s.homepageText, /Free delivery in KL via J&T/);
    assert.deepEqual(s.links, ['/shipping']);
    assert.deepEqual(Object.keys(s.data).sort(), ['/api/orders', '/api/products', '/api/shop']);
    assert.deepEqual((s.data['/api/products'] as { rows: number; fields: string[] }).rows, 2);
    assert.ok((s.data['/api/products'] as { fields: string[] }).fields.includes('image_url'));
    const orders = await fetchSitePath(base, '/api/orders');
    assert.equal(orders.type, 'json');
    await assert.rejects(fetchSitePath(base, '/old'), /only reads pages on your own website/);
    await assert.rejects(fetchSitePath(base, 'https://evil.example/'), /only reads pages on your own website/);
  } finally {
    shop.close();
    delete process.env.SITE_READER_ALLOW_PRIVATE;
  }
});

test('never reads private or local addresses', async () => {
  await assert.rejects(surveySite('http://127.0.0.1:9'), /public websites/);
  await assert.rejects(surveySite('http://localhost:3000'), /public websites/);
  await assert.rejects(surveySite('http://169.254.169.254'), /public websites/);
  assert.equal(siteOrigin('myshop.com/products?x=1').href, 'https://myshop.com/');
  assert.throws(() => siteOrigin('ftp://x.com'), /http/);
  assert.deepEqual(describeJson({ items: [{ a: 1 }, { a: 2, b: 3 }] }), { rows: 2, fields: ['a', 'b'], examples: [{ a: 1 }, { a: 2, b: 3 }] });
});

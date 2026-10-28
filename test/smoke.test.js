'use strict';
const os = require('node:os'), path = require('node:path'), fs = require('node:fs');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kolt-'));
const test = require('node:test'), assert = require('node:assert/strict');
const { db } = require('../db'), { hashPassword } = require('../auth'), { server } = require('../server');
let base; const jar = {};
const call = async (url, opt = {}, who = 'a') => {
  const r = await fetch(base + url, { redirect: 'manual', ...opt, headers: { ...(jar[who] ? { cookie: jar[who] } : {}), ...opt.headers } });
  const sc = r.headers.get('set-cookie'); if (sc) jar[who] = sc.split(';')[0];
  return r;
};
const form = o => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() });
const jpost = (o) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) });
let csrf, pid, vid;
test.before(async () => {
  db.prepare("INSERT INTO admins(email,pass_hash,role) VALUES('boss@test.ua',?, 'super'),('ed@test.ua',?, 'editor')").run(hashPassword('correct-horse-battery'), hashPassword('another-long-password'));
  await new Promise(r => server.listen(0, r)); base = 'http://localhost:' + server.address().port;
});
test.after(() => server.close());
const tokenOf = async (who) => { const t = await (await call('/admin', {}, who)).text(); return /data-csrf="(\w+)"/.exec(t)?.[1]; };

test('публічні сторінки відкриваються, адмінка закрита', async () => {
  for (const u of ['/', '/catalog', '/cart', '/checkout', '/contacts', '/robots.txt', '/sitemap.xml']) assert.equal((await call(u)).status, 200, u);
  assert.equal((await call('/nope')).status, 404);
  const r = await call('/admin'); assert.equal(r.status, 303); assert.match(r.headers.get('location'), /login/);
  assert.equal((await call('/admin/products/new', form({ name: 'x' }))).status, 303);
});
test('вхід: неправильний пароль відхиляється, правильний працює', async () => {
  assert.equal((await call('/admin/login', form({ email: 'boss@test.ua', password: 'wrong' }))).status, 401);
  assert.equal((await call('/admin/login', form({ email: 'boss@test.ua', password: 'correct-horse-battery' }))).status, 303);
  csrf = await tokenOf('a'); assert.ok(csrf);
});
test('CSRF: POST без токена відхиляється', async () => {
  assert.equal((await call('/admin/products/new', form({ name: 'Хакер' }))).status, 403);
});
test('створення товару: валідація та збереження', async () => {
  const bad = await call('/admin/products/new', form({ _csrf: csrf, name: '', vcount: 1, v0_label: 'біла', v0_price: 'abc', v0_stock: '5' })); assert.equal(bad.status, 422);
  const ok = await call('/admin/products/new', form({ _csrf: csrf, name: 'Тест полотно', sku: 'T-1', published: '1', composition: 'льон', width_cm: '150', vcount: 3, v0_label: 'біле', v0_price: '125,50', v0_stock: '10', v0_unit: 'м', v0_active: '1', v1_label: 'сіре', v1_price: '130', v1_stock: '0', v1_active: '1' }));
  assert.equal(ok.status, 303); pid = Number(/products\/(\d+)/.exec(ok.headers.get('location'))[1]);
  const vs = db.prepare('SELECT * FROM variants WHERE product_id=? ORDER BY id').all(pid); assert.equal(vs.length, 2); assert.equal(vs[0].price_kop, 12550); vid = vs[0].id;
  const dup = await call('/admin/products/new', form({ _csrf: csrf, name: 'Дубль', sku: 'T-1', vcount: 1, v0_label: 'a', v0_price: '1', v0_stock: '1', v0_active: '1' })); assert.equal(dup.status, 422);
});
test('товар з адмінки видно на сайті (каталог, фільтри, картка)', async () => {
  assert.match(await (await call('/catalog')).text(), /Тест полотно/);
  assert.match(await (await call('/catalog?q=T-1&comp=' + encodeURIComponent('льон') + '&instock=1')).text(), /Тест полотно/);
  assert.doesNotMatch(await (await call('/catalog?min=500')).text(), /Тест полотно/);
  const pg = await (await call('/product/test-polotno')).text(); assert.match(pg, /125,50/); assert.match(pg, /сіре — немає/);
});
test('замовлення: ціна з сервера, залишок, ідемпотентність, недоступний товар', async () => {
  const body = idem => ({ name: 'Іван', phone: '+380501112233', city: 'Київ', delivery: 'nova_poshta', address: 'Відділення 5', items: [{ id: vid, qty: 3 }], idem, price: 1 });
  const r = await call('/api/orders', jpost(body('key-12345678'))); assert.equal(r.status, 201); const { number } = await r.json();
  const o = db.prepare('SELECT * FROM orders WHERE number=?').get(number); assert.equal(o.total_kop, 3 * 12550);
  assert.equal(db.prepare('SELECT stock FROM variants WHERE id=?').get(vid).stock, 7);
  const again = await call('/api/orders', jpost(body('key-12345678'))); assert.equal((await again.json()).number, number); assert.equal(db.prepare('SELECT COUNT(*) n FROM orders').get().n, 1);
  assert.equal(db.prepare('SELECT stock FROM variants WHERE id=?').get(vid).stock, 7);
  assert.equal((await call('/api/orders', jpost({ ...body('key-22222222'), items: [{ id: vid, qty: 999 }] }))).status, 409);
  const sold = db.prepare("SELECT id FROM variants WHERE label='сіре'").get().id;
  assert.equal((await call('/api/orders', jpost({ ...body('key-33333333'), items: [{ id: sold, qty: 1 }] }))).status, 409);
  assert.equal((await call('/api/orders', jpost({ ...body('key-44444444'), phone: '1' }))).status, 422);
});
test('адмін: статус замовлення, скасування повертає залишок, історія', async () => {
  const o = db.prepare('SELECT id FROM orders').get();
  assert.match(await (await call('/admin/orders')).text(), /KT-000001/);
  await call(`/admin/orders/${o.id}/status`, form({ _csrf: csrf, status: 'confirmed' })); assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(o.id).status, 'confirmed');
  await call(`/admin/orders/${o.id}/status`, form({ _csrf: csrf, status: 'cancelled' })); assert.equal(db.prepare('SELECT stock FROM variants WHERE id=?').get(vid).stock, 10);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM order_history WHERE order_id=?').get(o.id).n, 3);
  await call(`/admin/orders/${o.id}/status`, form({ _csrf: csrf, status: 'new' })); assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(o.id).status, 'cancelled');
  assert.match(await (await call('/admin')).text(), /Усього замовлень/);
});
test('архівування: товар зникає з магазину, замовлення зберігається', async () => {
  await call('/admin/products/' + pid + '/archive', form({ _csrf: csrf }));
  assert.equal((await call('/product/test-polotno')).status, 404); assert.doesNotMatch(await (await call('/catalog')).text(), /Тест полотно/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM order_items').get().n, 1);
});
test('категорії: цикл заборонено', async () => {
  await call('/admin/categories/new', form({ _csrf: csrf, name: 'Батько', published: '1' })); await call('/admin/categories/new', form({ _csrf: csrf, name: 'Дитина', parent_id: '1', published: '1' }));
  const r = await call('/admin/categories/1', form({ _csrf: csrf, name: 'Батько', parent_id: '2', published: '1' })); assert.match(decodeURIComponent(r.headers.get('location')), /цикл/);
});
test('завантаження: лише зображення, перевірка за вмістом', async () => {
  const up = (buf) => call('/admin/upload/' + pid, { method: 'POST', headers: { 'x-csrf': csrf }, body: buf });
  assert.equal((await up(Buffer.from('<?php echo 1;'))).status, 422);
  assert.equal((await up(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(50)]))).status, 201);
  assert.equal(fs.readdirSync(path.join(process.env.DATA_DIR, 'uploads')).length, 1);
});
test('ролі: редактор не бачить товарів і замовлень, але керує сторінками', async () => {
  await call('/admin/login', form({ email: 'ed@test.ua', password: 'another-long-password' }), 'e'); const t = await tokenOf('e');
  assert.equal((await call('/admin/products', {}, 'e')).status, 403); assert.equal((await call('/admin/orders', {}, 'e')).status, 403);
  assert.equal((await call('/admin/settings', {}, 'e')).status, 403);
  await call('/admin/pages/about', form({ _csrf: t, title: 'Про виробництво', body: 'Текст', published: '1' }), 'e');
  assert.match(await (await call('/page/about')).text(), /Текст/);
});
test('налаштування змінюють публічний сайт; вихід знищує сесію', async () => {
  await call('/admin/settings', form({ _csrf: csrf, company: 'Коломийські тканини', phone: '+380000000000', hero_title: 'Новий заголовок', hero_subtitle: '' }));
  assert.match(await (await call('/')).text(), /Новий заголовок/);
  await call('/admin/logout', form({ _csrf: csrf })); assert.equal((await call('/admin')).status, 303);
});
test('брутфорс входу обмежується', async () => {
  let last; for (let i = 0; i < 7; i++) last = await call('/admin/login', form({ email: 'x@x.ua', password: 'nope' }), 'z');
  assert.equal(last.status, 429);
});

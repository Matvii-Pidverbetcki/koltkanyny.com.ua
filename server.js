'use strict';
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { db, DATA } = require('./db');
const { verifyPassword } = require('./auth');
const PORT = +process.env.PORT || 3000, PROD = process.env.NODE_ENV === 'production';
const BASE = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

// ---------- утиліти ----------
const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const kop = n => (n / 100).toFixed(2).replace('.', ',') + ' ₴';
const parseKop = s => { const m = /^(\d{1,9})(?:[.,](\d{1,2}))?$/.exec(String(s).trim()); return m ? Number(m[1]) * 100 + Number((m[2] || '0').padEnd(2, '0')) : null; };
const when = s => new Date(String(s).replace(' ', 'T') + 'Z').toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });
const tr = { а:'a',б:'b',в:'v',г:'h',ґ:'g',д:'d',е:'e',є:'ie',ж:'zh',з:'z',и:'y',і:'i',ї:'i',й:'i',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'kh',ц:'ts',ч:'ch',ш:'sh',щ:'shch',ь:'',ю:'iu',я:'ia','’':'',"'":'' };
const slugify = s => String(s).toLowerCase().split('').map(c => tr[c] ?? c).join('').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'item';
const uniqueSlug = (table, base, exceptId = 0) => { let s = slugify(base), i = 1; while (db.prepare(`SELECT 1 FROM ${table} WHERE slug=? AND id!=?`).get(s, exceptId)) s = `${slugify(base)}-${++i}`; return s; };
const settings = () => Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(r => [r.key, r.value]));
const STATUS = { new: 'Нове', confirmed: 'Підтверджене', processing: 'Обробляється', shipped: 'Відправлене', done: 'Виконане', cancelled: 'Скасоване' };
const DELIVERY = { nova_poshta: 'Нова пошта', ukrposhta: 'Укрпошта', pickup: 'Самовивіз' };
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const safeEq = (a, b) => { a = Buffer.from(String(a)); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const audit = (c, action, detail = '') => db.prepare('INSERT INTO audit_log(admin_id,action,detail) VALUES(?,?,?)').run(c.admin?.admin_id ?? null, action, String(detail).slice(0, 500));
const tx = fn => { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
const hits = new Map();
const limited = (key, max, ms) => { const now = Date.now(); let r = hits.get(key); if (!r || r.reset < now) r = { n: 0, reset: now + ms }; r.n++; hits.set(key, r); return r.n > max; };
setInterval(() => { const n = Date.now(); for (const [k, v] of hits) if (v.reset < n) hits.delete(k); }, 60000).unref();

// ---------- HTTP ----------
class HttpErr extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const MIME = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function send(res, status, body, type = 'text/html; charset=utf-8', extra = {}) { res.writeHead(status, { 'Content-Type': type, ...extra }); res.end(body); }
const json = (res, status, obj) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8', { 'Cache-Control': 'no-store' });
const redirect = (res, to, extra = {}) => { res.writeHead(303, { Location: to, ...extra }); res.end(); };
function serve(res, root, rel, cache) {
  const f = path.resolve(root, rel);
  if (!f.startsWith(path.resolve(root) + path.sep) || !MIME[path.extname(f)] || !fs.existsSync(f)) return send(res, 404, 'Not found', 'text/plain');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)], 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' }); fs.createReadStream(f).pipe(res);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', d => { n += d.length; if (n > limit) { reject(new HttpErr(413, 'Завеликий запит')); req.destroy(); } else chunks.push(d); });
    req.on('end', () => {
      const raw = Buffer.concat(chunks), t = req.headers['content-type'] || '';
      try {
        if (t.startsWith('application/json')) return resolve({ raw, j: raw.length ? JSON.parse(raw) : {}, f: new URLSearchParams() });
        if (t.startsWith('application/x-www-form-urlencoded')) return resolve({ raw, f: new URLSearchParams(raw.toString()) });
        resolve({ raw, f: new URLSearchParams() });
      } catch { reject(new HttpErr(400, 'Некоректні дані')); }
    });
    req.on('error', reject);
  });
}
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(s => s.trim().split('=')).filter(a => a[0]).map(([k, ...v]) => [k, v.join('=')]));
const cookieAttrs = (age) => `; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${PROD ? '; Secure' : ''}`;

// ---------- шаблони (публічна частина) ----------
function layout(c, { title, desc = '', canon, body, ld }) {
  const s = c.S, pages = db.prepare("SELECT slug,title FROM pages WHERE published=1 AND body!='' ORDER BY rowid").all();
  const pl = slug => pages.find(p => p.slug === slug);
  const nav = [['/catalog', 'Каталог'], ...['about', 'wholesale', 'delivery'].filter(pl).map(k => ['/page/' + k, pl(k).title]), ['/contacts', 'Контакти']];
  const t = `${title} — ${s.company}`, d = desc || s.seo_description || s.hero_subtitle;
  return `<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h(t)}</title><meta name="description" content="${h(d)}">${canon ? `<link rel="canonical" href="${h(BASE + canon)}">` : ''}
<meta property="og:title" content="${h(t)}"><meta property="og:description" content="${h(d)}"><meta property="og:type" content="website"><meta property="og:locale" content="uk_UA">
<link rel="stylesheet" href="/static/style.css">${ld ? `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>` : ''}</head><body>
<a class="skip" href="#main">Перейти до змісту</a>
${s.topbar ? `<div class="topbar">${h(s.topbar)}${s.phone ? ` · <a href="tel:${h(s.phone.replace(/[^\d+]/g, ''))}">${h(s.phone)}</a>` : ''}</div>` : ''}
<header class="head"><div class="wrap bar"><a class="brand" href="/">${h(s.company)}</a>
<button class="burger" aria-expanded="false" aria-controls="nav" data-nav>Меню</button>
<nav id="nav" class="nav" aria-label="Основна навігація">${nav.map(([u, l]) => `<a href="${u}">${h(l)}</a>`).join('')}</nav>
<form class="search" action="/catalog" role="search"><input name="q" type="search" placeholder="Пошук тканин" aria-label="Пошук" value="${h(c.q?.q || '')}"></form>
<a class="cartlink" href="/cart">Кошик <span class="badge" data-cart-count>0</span></a></div></header>
<main id="main">${body}</main>
<footer class="foot"><div class="wrap cols"><div><strong>${h(s.company)}</strong><p>${h(s.address)}</p>${s.phone ? `<p><a href="tel:${h(s.phone.replace(/[^\d+]/g, ''))}">${h(s.phone)}</a></p>` : ''}${s.email ? `<p><a href="mailto:${h(s.email)}">${h(s.email)}</a></p>` : ''}${s.hours ? `<p>${h(s.hours)}</p>` : ''}</div>
<div><strong>Покупцям</strong><a href="/catalog">Каталог</a>${['delivery', 'returns', 'wholesale'].filter(pl).map(k => `<a href="/page/${k}">${h(pl(k).title)}</a>`).join('')}<a href="/contacts">Контакти</a></div>
<div>${pl('privacy') ? `<a href="/page/privacy">${h(pl('privacy').title)}</a>` : ''}${s.social ? s.social.split('\n').filter(u => /^https?:\/\//.test(u.trim())).map(u => `<a href="${h(u.trim())}" rel="noopener">${h(u.trim().replace(/^https?:\/\/(www\.)?/, ''))}</a>`).join('') : ''}</div></div></footer>
<div id="toast" class="toast" role="status" aria-live="polite"></div><script src="/static/app.js" defer></script></body></html>`;
}
const crumbs = items => `<nav class="crumbs wrap" aria-label="Хлібні крихти">${items.map(([u, l]) => u ? `<a href="${u}">${h(l)}</a>` : `<span aria-current="page">${h(l)}</span>`).join(' / ')}</nav>`;
const imgOf = (f, alt) => f ? `<img src="/uploads/${h(f)}" alt="${h(alt)}" loading="lazy">` : `<div class="weave" role="img" aria-label="Фото відсутнє"></div>`;
function card(p) {
  const price = p.minp == null ? '' : p.minp === p.maxp ? kop(p.minp) : `від ${kop(p.minp)}`;
  const meta = [p.composition, p.width_cm ? `${p.width_cm} см` : '', p.density].filter(Boolean).join(' · ');
  const act = p.nvar === 1 && p.stock > 0 ? `<button class="btn small" data-add="${p.onevid}">В кошик</button>` : `<a class="btn small ghost" href="/product/${h(p.slug)}">Обрати</a>`;
  return `<article class="card"><a class="ph" href="/product/${h(p.slug)}">${imgOf(p.img, p.name)}${p.demo ? '<span class="demo">ДЕМО</span>' : ''}</a>
<h3><a href="/product/${h(p.slug)}">${h(p.name)}</a></h3><p class="meta">${h(meta)}</p>
<p class="price">${price}</p><p class="stock ${p.stock > 0 ? 'ok' : 'no'}">${p.stock > 0 ? '✓ В наявності' : '✕ Немає в наявності'}</p>${p.stock > 0 ? act : `<a class="btn small ghost" href="/product/${h(p.slug)}">Детальніше</a>`}</article>`;
}
const PSEL = `p.*, (SELECT MIN(price_kop) FROM variants v WHERE v.product_id=p.id AND v.active=1) minp, (SELECT MAX(price_kop) FROM variants v WHERE v.product_id=p.id AND v.active=1) maxp,
 (SELECT COALESCE(SUM(stock),0) FROM variants v WHERE v.product_id=p.id AND v.active=1) stock, (SELECT COUNT(*) FROM variants v WHERE v.product_id=p.id AND v.active=1) nvar,
 (SELECT id FROM variants v WHERE v.product_id=p.id AND v.active=1 ORDER BY sort,id LIMIT 1) onevid, (SELECT file FROM images i WHERE i.product_id=p.id ORDER BY sort,id LIMIT 1) img`;
const catTree = (onlyPub = true) => { const all = db.prepare(`SELECT * FROM categories ${onlyPub ? 'WHERE published=1' : ''} ORDER BY sort,name`).all(); const out = []; const walk = (pid, d) => all.filter(x => (x.parent_id || 0) === pid).forEach(x => { out.push({ ...x, depth: d }); walk(x.id, d + 1); }); walk(0, 0); return out; };
const descendants = id => { const ids = [id]; for (let i = 0; i < ids.length; i++) db.prepare('SELECT id FROM categories WHERE parent_id=? AND published=1').all(ids[i]).forEach(r => ids.push(r.id)); return ids; };

function home(c) {
  const s = c.S, cats = db.prepare("SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id=c.id AND p.published=1 AND p.archived=0) n FROM categories c WHERE published=1 AND parent_id IS NULL ORDER BY sort,name").all();
  const feat = db.prepare(`SELECT ${PSEL} FROM products p WHERE published=1 AND archived=0 AND featured=1 ORDER BY id DESC LIMIT 8`).all();
  const wh = db.prepare("SELECT 1 FROM pages WHERE slug='wholesale' AND published=1 AND body!=''").get();
  const adv = s.advantages.split('\n').map(x => x.trim()).filter(Boolean);
  return layout(c, { title: 'Тканини від українського виробника', canon: '/', body: `
<section class="hero"><div class="wrap"><h1>${h(s.hero_title)}</h1><p>${h(s.hero_subtitle)}</p>
<p class="cta"><a class="btn" href="/catalog">Переглянути каталог</a> <a class="btn ghost" href="${wh ? '/page/wholesale' : '/contacts'}">Для оптових покупців</a></p></div></section>
${cats.length ? `<section class="wrap sec"><h2>Категорії</h2><div class="cats">${cats.map(x => `<a class="cat" href="/catalog/${h(x.slug)}"><span class="weave"></span><strong>${h(x.name)}</strong><small>${x.n} тов.</small></a>`).join('')}</div></section>` : ''}
${feat.length ? `<section class="wrap sec"><h2>Популярні товари</h2><div class="grid">${feat.map(card).join('')}</div></section>` : ''}
${adv.length ? `<section class="alt"><div class="wrap sec"><h2>Переваги виробника</h2><ul class="adv">${adv.map(a => `<li>${h(a)}</li>`).join('')}</ul></div></section>` : ''}
<section class="wrap sec split"><div><h2>Оптовим покупцям</h2><p>Хочете замовити тканини оптом? Залиште запит — ми зв'яжемося з вами та обговоримо умови.</p></div>
<form class="form" data-lead="wholesale">${leadFields()}</form></section>` });
}
const leadFields = () => `<label>Ім'я<input name="name" required maxlength="100" autocomplete="name"></label><label>Телефон<input name="phone" required type="tel" maxlength="20" autocomplete="tel"></label>
<label>Повідомлення<textarea name="message" rows="3" required maxlength="2000"></textarea></label><button class="btn">Надіслати</button><p class="err" role="alert" data-err></p>`;

function catalog(c, slug) {
  const q = c.q, where = ['p.published=1', 'p.archived=0'], a = [];
  let cat = null;
  const cs = slug || q.cat; if (cs) { cat = db.prepare('SELECT * FROM categories WHERE slug=? AND published=1').get(cs); if (!cat) return null; const ids = descendants(cat.id); where.push(`p.category_id IN (${ids.map(() => '?').join()})`); a.push(...ids); }
  const term = (q.q || '').trim().slice(0, 100); if (term) { where.push("(p.name LIKE ? ESCAPE '\\' OR p.sku LIKE ? ESCAPE '\\' OR p.description LIKE ? ESCAPE '\\')"); const l = '%' + term.replace(/[\\%_]/g, '\\$&') + '%'; a.push(l, l, l); }
  if (q.comp) { where.push('p.composition=?'); a.push(q.comp); }
  if (q.color) { where.push('EXISTS(SELECT 1 FROM variants v WHERE v.product_id=p.id AND v.active=1 AND v.label=?)'); a.push(q.color); }
  if (q.instock) where.push('EXISTS(SELECT 1 FROM variants v WHERE v.product_id=p.id AND v.active=1 AND v.stock>0)');
  const mn = parseKop(q.min || ''), mx = parseKop(q.max || '');
  if (mn != null) { where.push('EXISTS(SELECT 1 FROM variants v WHERE v.product_id=p.id AND v.active=1 AND v.price_kop>=?)'); a.push(mn); }
  if (mx != null) { where.push('EXISTS(SELECT 1 FROM variants v WHERE v.product_id=p.id AND v.active=1 AND v.price_kop<=?)'); a.push(mx); }
  const order = { price_asc: 'minp ASC', price_desc: 'minp DESC', name: 'p.name COLLATE NOCASE' }[q.sort] || 'p.id DESC';
  const W = where.join(' AND '), per = 12, page = Math.max(1, parseInt(q.page) || 1);
  const total = db.prepare(`SELECT COUNT(*) n FROM products p WHERE ${W}`).get(...a).n;
  const rows = db.prepare(`SELECT ${PSEL} FROM products p WHERE ${W} ORDER BY ${order} LIMIT ${per} OFFSET ${(page - 1) * per}`).all(...a);
  const colors = db.prepare("SELECT DISTINCT v.label l FROM variants v JOIN products p ON p.id=v.product_id WHERE v.active=1 AND p.published=1 AND p.archived=0 ORDER BY 1").all().map(r => r.l);
  const comps = db.prepare("SELECT DISTINCT composition l FROM products WHERE published=1 AND archived=0 AND composition!='' ORDER BY 1").all().map(r => r.l);
  const opt = (arr, v) => arr.map(x => `<option ${x === v ? 'selected' : ''}>${h(x)}</option>`).join('');
  const base = cat ? '/catalog/' + cat.slug : '/catalog';
  const qs = p => { const u = new URLSearchParams(); for (const k of ['q', 'comp', 'color', 'instock', 'min', 'max', 'sort']) if (q[k]) u.set(k, q[k]); if (p > 1) u.set('page', p); const s = u.toString(); return base + (s ? '?' + s : ''); };
  const pages = Math.ceil(total / per);
  return layout(c, { title: cat ? cat.name : term ? `Пошук: ${term}` : 'Каталог тканин', desc: cat?.description, canon: base + (page > 1 ? `?page=${page}` : ''), body: `
${crumbs([['/', 'Головна'], cat ? ['/catalog', 'Каталог'] : [null, 'Каталог'], ...(cat ? [[null, cat.name]] : [])])}
<div class="wrap"><h1>${h(cat ? cat.name : 'Каталог')}</h1>${cat?.description ? `<p class="lead">${h(cat.description)}</p>` : ''}
<div class="catalog"><details class="filters" data-filters><summary class="btn ghost small">Фільтри</summary>
<form method="get" action="${base}"><label>Пошук<input name="q" value="${h(term)}"></label>
${colors.length ? `<label>Колір / варіант<select name="color"><option value="">Усі</option>${opt(colors, q.color)}</select></label>` : ''}
${comps.length ? `<label>Склад<select name="comp"><option value="">Усі</option>${opt(comps, q.comp)}</select></label>` : ''}
<div class="two"><label>Ціна від<input name="min" inputmode="decimal" value="${h(q.min || '')}"></label><label>до<input name="max" inputmode="decimal" value="${h(q.max || '')}"></label></div>
<label class="chk"><input type="checkbox" name="instock" value="1" ${q.instock ? 'checked' : ''}> Тільки в наявності</label>
<label>Сортування<select name="sort">${[['', 'Нові спочатку'], ['price_asc', 'Ціна: від низької'], ['price_desc', 'Ціна: від високої'], ['name', 'За назвою']].map(([k, t]) => `<option value="${k}" ${q.sort === k ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
<button class="btn">Застосувати</button> <a href="${base}">Скинути</a></form></details>
<div><p class="count">Знайдено: ${total}</p>${rows.length ? `<div class="grid">${rows.map(card).join('')}</div>` : `<div class="empty"><p>За вашим запитом товарів не знайдено.</p><a class="btn ghost" href="${base}">Скинути фільтри</a></div>`}
${pages > 1 ? `<nav class="pager" aria-label="Сторінки">${Array.from({ length: pages }, (_, i) => i + 1).map(n => n === page ? `<span aria-current="page">${n}</span>` : `<a href="${qs(n)}">${n}</a>`).join('')}</nav>` : ''}</div></div></div>` });
}

function productPage(c, slug) {
  const p = db.prepare(`SELECT ${PSEL} FROM products p WHERE slug=? AND published=1 AND archived=0`).get(slug); if (!p) return null;
  const vs = db.prepare('SELECT * FROM variants WHERE product_id=? AND active=1 ORDER BY sort,id').all(p.id), imgs = db.prepare('SELECT * FROM images WHERE product_id=? ORDER BY sort,id').all(p.id);
  const cat = p.category_id && db.prepare('SELECT * FROM categories WHERE id=?').get(p.category_id);
  const sim = p.category_id ? db.prepare(`SELECT ${PSEL} FROM products p WHERE category_id=? AND id!=? AND published=1 AND archived=0 ORDER BY id DESC LIMIT 4`).all(p.category_id, p.id) : [];
  const first = vs.find(v => v.stock > 0) || vs[0];
  const specs = [['Артикул', p.sku], ['Склад', p.composition], ['Ширина', p.width_cm ? p.width_cm + ' см' : ''], ['Щільність / товщина', p.density]].filter(r => r[1]);
  const ld = { '@context': 'https://schema.org', '@type': 'Product', name: p.name, sku: p.sku || undefined, description: p.description || undefined, image: imgs.map(i => `${BASE}/uploads/${i.file}`),
    offers: vs.length ? { '@type': 'AggregateOffer', priceCurrency: 'UAH', lowPrice: (p.minp / 100).toFixed(2), highPrice: (p.maxp / 100).toFixed(2), offerCount: vs.length, availability: p.stock > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock' } : undefined };
  return layout(c, { title: p.name, desc: p.description.slice(0, 160) || [p.composition, p.density].filter(Boolean).join(', '), canon: '/product/' + p.slug, ld, body: `
${crumbs([['/', 'Головна'], ['/catalog', 'Каталог'], ...(cat ? [['/catalog/' + cat.slug, cat.name]] : []), [null, p.name]])}
<div class="wrap pdp"><div class="gal">${imgs.length ? `<div class="main-img"><img id="mainimg" src="/uploads/${h(imgs[0].file)}" alt="${h(p.name)}"></div><div class="thumbs">${imgs.map((i, n) => `<button type="button" data-thumb="/uploads/${h(i.file)}" aria-label="Фото ${n + 1}"><img src="/uploads/${h(i.file)}" alt="" loading="lazy"></button>`).join('')}</div>` : '<div class="main-img"><div class="weave" role="img" aria-label="Фото відсутнє"></div></div>'}</div>
<div class="info"><h1>${h(p.name)}</h1>${p.demo ? '<p class="demo-note">ДЕМО-товар: тестові дані, не реальна продукція.</p>' : ''}
<p class="price big" data-price>${first ? kop(first.price_kop) : ''}</p>
${vs.length ? `<fieldset class="variants"><legend>Колір / варіант</legend>${vs.map(v => `<label class="vopt ${v.stock <= 0 ? 'off' : ''}"><input type="radio" name="variant" value="${v.id}" data-price="${v.price_kop}" data-stock="${v.stock}" data-unit="${h(v.unit)}" ${v === first ? 'checked' : ''} ${v.stock <= 0 ? 'disabled' : ''}><span>${h(v.label)}${v.stock <= 0 ? ' — немає' : ''}</span></label>`).join('')}</fieldset>
<p class="stock" data-stock-line></p><div class="buy"><label>Кількість <span data-unit>${h(first?.unit || 'м')}</span><input type="number" min="1" value="1" step="1" inputmode="numeric" data-qty></label>
<button class="btn" data-add-pdp ${p.stock > 0 ? '' : 'disabled'}>Додати до кошика</button></div><p><a class="btn ghost" href="/cart">Перейти до кошика</a></p>` : '<p>Варіанти ще не додано.</p>'}
<table class="specs">${specs.map(([k, v]) => `<tr><th>${k}</th><td>${h(v)}</td></tr>`).join('')}</table>
${p.description ? `<div class="desc">${h(p.description).replace(/\n/g, '<br>')}</div>` : ''}
<p class="note"><a href="/page/delivery">Умови доставки й оплати</a></p></div></div>
${sim.length ? `<section class="wrap sec"><h2>Схожі товари</h2><div class="grid">${sim.map(card).join('')}</div></section>` : ''}` });
}

// ---------- API: кошик і замовлення ----------
function cartLines(items) {
  const out = [];
  for (const it of items) {
    const v = db.prepare('SELECT v.*, p.name pname, p.slug, p.published, p.archived, (SELECT file FROM images i WHERE i.product_id=p.id ORDER BY sort,id LIMIT 1) img FROM variants v JOIN products p ON p.id=v.product_id WHERE v.id=?').get(it.id);
    const ok = v && v.active && v.published && !v.archived;
    out.push({ id: it.id, ok: !!ok, name: ok ? v.pname : '', label: ok ? v.label : '', unit: ok ? v.unit : '', slug: ok ? v.slug : '', img: ok ? v.img : null, price_kop: ok ? v.price_kop : 0, stock: ok ? v.stock : 0, qty: it.qty, line_kop: ok ? v.price_kop * it.qty : 0 });
  }
  return out;
}
const validItems = arr => Array.isArray(arr) && arr.length > 0 && arr.length <= 50 && arr.every(i => Number.isInteger(i?.id) && Number.isInteger(i?.qty) && i.qty >= 1 && i.qty <= 100000);
function createOrder(b, ip) {
  const errors = {}, s = x => String(x ?? '').trim();
  const name = s(b.name), phone = s(b.phone), email = s(b.email), city = s(b.city), delivery = s(b.delivery), address = s(b.address), comment = s(b.comment), key = s(b.idem);
  if (name.length < 2 || name.length > 100) errors.name = 'Вкажіть ім\'я';
  if (!/^\+?[\d\s()-]{9,18}$/.test(phone)) errors.phone = 'Вкажіть коректний телефон';
  if (email && !/^\S+@\S+\.\S+$/.test(email)) errors.email = 'Некоректний email';
  if (city.length < 2 || city.length > 100) errors.city = 'Вкажіть місто';
  if (!DELIVERY[delivery]) errors.delivery = 'Оберіть спосіб доставки';
  if (delivery !== 'pickup' && (address.length < 3 || address.length > 300)) errors.address = 'Вкажіть відділення або адресу';
  if (comment.length > 1000) errors.comment = 'Занадто довгий коментар';
  if (!/^[\w-]{8,64}$/.test(key)) errors.idem = 'Некоректний запит';
  if (!validItems(b.items)) errors.items = 'Кошик порожній або некоректний';
  if (Object.keys(errors).length) return { status: 422, body: { errors } };
  return tx(() => {
    const ex = db.prepare('SELECT number FROM orders WHERE idem_key=?').get(key); if (ex) return { status: 200, body: { number: ex.number, repeated: true } };
    const merged = new Map(); for (const i of b.items) merged.set(i.id, (merged.get(i.id) || 0) + i.qty);
    const lines = cartLines([...merged].map(([id, qty]) => ({ id, qty }))), problems = [];
    for (const l of lines) { if (!l.ok) problems.push({ id: l.id, msg: 'Товар більше недоступний' }); else if (l.stock < l.qty) problems.push({ id: l.id, msg: `${l.name} (${l.label}): доступно лише ${l.stock} ${l.unit}`, stock: l.stock }); }
    if (problems.length) return { status: 409, body: { error: 'Склад або ціни змінилися. Перевірте кошик.', problems, cart: lines } };
    const total = lines.reduce((t, l) => t + l.line_kop, 0);
    const r = db.prepare('INSERT INTO orders(idem_key,name,phone,email,city,delivery,address,comment,total_kop) VALUES(?,?,?,?,?,?,?,?,?)').run(key, name, phone, email, city, delivery, delivery === 'pickup' ? '' : address, comment, total);
    const id = Number(r.lastInsertRowid), number = `KT-${String(id).padStart(6, '0')}`;
    db.prepare('UPDATE orders SET number=? WHERE id=?').run(number, id);
    for (const l of lines) { db.prepare('INSERT INTO order_items(order_id,variant_id,product_name,variant_label,unit,unit_price_kop,qty) VALUES(?,?,?,?,?,?,?)').run(id, l.id, l.name, l.label, l.unit, l.price_kop, l.qty); db.prepare('UPDATE variants SET stock=stock-? WHERE id=?').run(l.qty, l.id); }
    db.prepare("INSERT INTO order_history(order_id,status) VALUES(?, 'new')").run(id);
    return { status: 201, body: { number } };
  });
}
function cartPage(c, checkout) {
  const deliv = Object.entries(DELIVERY).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  return layout(c, { title: checkout ? 'Оформлення замовлення' : 'Кошик', body: `<div class="wrap sec"><h1>${checkout ? 'Оформлення замовлення' : 'Кошик'}</h1>
<div class="${checkout ? 'split top' : ''}"><div id="cart" data-cart data-mode="${checkout ? 'checkout' : 'cart'}"><p>Завантаження…</p></div>
${checkout ? `<form id="checkout" class="form" novalidate><h2>Контактні дані</h2>
<label>Ім'я<input name="name" required maxlength="100" autocomplete="name"><small class="err" data-for="name"></small></label>
<label>Телефон<input name="phone" required type="tel" maxlength="20" autocomplete="tel"><small class="err" data-for="phone"></small></label>
<label>Email (необов'язково)<input name="email" type="email" maxlength="120" autocomplete="email"><small class="err" data-for="email"></small></label>
<label>Місто<input name="city" required maxlength="100" autocomplete="address-level2"><small class="err" data-for="city"></small></label>
<label>Спосіб доставки<select name="delivery">${deliv}</select><small class="err" data-for="delivery"></small></label>
<label data-addr>Відділення / адреса<input name="address" maxlength="300"><small class="err" data-for="address"></small></label>
<label>Коментар<textarea name="comment" rows="3" maxlength="1000"></textarea></label>
<p class="note">Вартість доставки визначає перевізник. Онлайн-оплата поки не підключена: з вами зв'яжуться для підтвердження та оплати.</p>
<button class="btn" data-submit>Підтвердити замовлення</button><p class="err" role="alert" data-err></p></form>` : ''}</div></div>` });
}

// ---------- адмін-панель ----------
const ROLES = { super: ['catalog', 'orders', 'content', 'settings'], manager: ['catalog', 'orders'], editor: ['content'] };
const ROLE_NAMES = { super: 'Super Admin', manager: 'Manager', editor: 'Content Editor' };
const fld = (l, n, v = '', a = '') => `<label>${l}<input name="${n}" value="${h(v)}" ${a}></label>`;
const area = (l, n, v = '', r = 5) => `<label>${l}<textarea name="${n}" rows="${r}">${h(v)}</textarea></label>`;
const chk = (l, n, on) => `<label class="chk"><input type="checkbox" name="${n}" value="1" ${on ? 'checked' : ''}> ${l}</label>`;
const sel = (l, n, opts, v) => `<label>${l}<select name="${n}">${opts.map(([k, t]) => `<option value="${h(k)}" ${String(k) === String(v ?? '') ? 'selected' : ''}>${h(t)}</option>`).join('')}</select></label>`;
const badge = st => `<span class="st st-${st}">${STATUS[st]}</span>`;
function adminLayout(c, title, body, flash) {
  const a = c.admin, can = ar => ROLES[a.role].includes(ar);
  return `<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${h(title)} — Адмін</title>
<link rel="stylesheet" href="/static/style.css"></head><body class="admin" data-csrf="${h(a.csrf)}"><header class="ahead"><strong>Адмін-панель</strong><nav>
<a href="/admin">Огляд</a>${can('orders') ? '<a href="/admin/orders">Замовлення</a><a href="/admin/messages">Звернення</a>' : ''}${can('catalog') ? '<a href="/admin/products">Товари</a><a href="/admin/categories">Категорії</a>' : ''}${can('content') ? '<a href="/admin/pages">Сторінки</a>' : ''}${can('settings') ? '<a href="/admin/settings">Налаштування</a>' : ''}<a href="/" target="_blank">Сайт ↗</a></nav>
<form method="post" action="/admin/logout"><input type="hidden" name="_csrf" value="${h(a.csrf)}"><span>${h(a.email)} · ${ROLE_NAMES[a.role]}</span> <button class="btn small ghost">Вийти</button></form></header>
<main class="awrap">${flash ? `<p class="flash ${flash.err ? 'bad' : 'good'}" role="status">${h(flash.msg)}</p>` : ''}<h1>${h(title)}</h1>${body}</main><script src="/static/app.js" defer></script></body></html>`;
}
const csrfField = c => `<input type="hidden" name="_csrf" value="${h(c.admin.csrf)}">`;
const table = (head, rows, empty) => rows.length ? `<div class="tw"><table class="tbl"><thead><tr>${head.map(x => `<th>${x}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>` : `<p class="empty">${empty}</p>`;
const flashOf = q => q.ok ? { msg: q.ok } : q.err ? { msg: q.err, err: 1 } : null;
const back = (res, to, kind, msg) => redirect(res, `${to}${to.includes('?') ? '&' : '?'}${kind}=${encodeURIComponent(msg)}`);

function dashboard(c) {
  const n = (sql, ...a) => db.prepare(sql).get(...a).n, recent = db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 5').all();
  const low = db.prepare("SELECT p.id,p.name,v.label,v.stock,v.unit FROM variants v JOIN products p ON p.id=v.product_id WHERE v.active=1 AND p.archived=0 AND v.stock<=5 ORDER BY v.stock LIMIT 10").all();
  const box = (l, v) => `<div class="stat"><span>${l}</span><strong>${v}</strong></div>`;
  return adminLayout(c, 'Огляд', `<div class="stats">${box('Усього замовлень', n('SELECT COUNT(*) n FROM orders'))}${box('Нові', n("SELECT COUNT(*) n FROM orders WHERE status='new'"))}${box('В роботі', n("SELECT COUNT(*) n FROM orders WHERE status IN('confirmed','processing')"))}
${box('Сума за 30 днів (без скасованих)', kop(n("SELECT COALESCE(SUM(total_kop),0) n FROM orders WHERE status!='cancelled' AND created_at>=datetime('now','-30 days')")))}${box('Товарів (не в архіві)', n('SELECT COUNT(*) n FROM products WHERE archived=0'))}</div>
<h2>Останні замовлення</h2>${table(['№', 'Дата', 'Покупець', 'Сума', 'Статус'], recent.map(o => `<tr><td><a href="/admin/orders/${o.id}">${o.number}</a></td><td>${when(o.created_at)}</td><td>${h(o.name)}</td><td>${kop(o.total_kop)}</td><td>${badge(o.status)}</td></tr>`), 'Замовлень поки немає.')}
<h2>Низькі залишки (≤ 5)</h2>${table(['Товар', 'Варіант', 'Залишок'], low.map(l => `<tr><td><a href="/admin/products/${l.id}">${h(l.name)}</a></td><td>${h(l.label)}</td><td>${l.stock} ${h(l.unit)}</td></tr>`), 'Немає позицій з низьким залишком.')}`, flashOf(c.q));
}
function productsList(c) {
  const q = (c.q.q || '').trim(), arch = c.q.arch === '1';
  const rows = db.prepare(`SELECT ${PSEL}, (SELECT name FROM categories WHERE id=p.category_id) cname FROM products p WHERE archived=? ${q ? "AND (name LIKE ? OR sku LIKE ?)" : ''} ORDER BY id DESC LIMIT 200`).all(...[arch ? 1 : 0, ...(q ? [`%${q}%`, `%${q}%`] : [])]);
  return adminLayout(c, arch ? 'Архів товарів' : 'Товари', `<p><a class="btn" href="/admin/products/new">+ Новий товар</a> <a class="btn ghost" href="/admin/products${arch ? '' : '?arch=1'}">${arch ? 'До активних' : 'Архів'}</a></p>
<form class="inline" method="get"><input name="q" placeholder="Пошук за назвою або артикулом" value="${h(q)}">${arch ? '<input type="hidden" name="arch" value="1">' : ''}<button class="btn small">Знайти</button></form>
${table(['Назва', 'Артикул', 'Категорія', 'Ціна', 'Залишок', 'Статус'], rows.map(p => `<tr><td><a href="/admin/products/${p.id}">${h(p.name)}</a>${p.demo ? ' <span class="demo">ДЕМО</span>' : ''}</td><td>${h(p.sku || '')}</td><td>${h(p.cname || '—')}</td><td>${p.minp == null ? '—' : p.minp === p.maxp ? kop(p.minp) : `${kop(p.minp)} – ${kop(p.maxp)}`}</td><td>${p.stock}</td><td>${p.archived ? 'Архів' : p.published ? 'Опубліковано' : 'Приховано'}</td></tr>`), 'Товарів не знайдено.')}`, flashOf(c.q));
}
function productForm(c, p, vs, errs = []) {
  const imgs = p.id ? db.prepare('SELECT * FROM images WHERE product_id=? ORDER BY sort,id').all(p.id) : [];
  const catOpts = [['', '— без категорії —'], ...catTree(false).map(x => [x.id, '\u00A0\u00A0'.repeat(x.depth) + x.name])];
  const rows = [...vs, { id: '', label: '', price: '', stock: '', unit: 'м', active: 1 }, { id: '', label: '', price: '', stock: '', unit: 'м', active: 1 }];
  return adminLayout(c, p.id ? `Товар: ${p.name}` : 'Новий товар', `${errs.length ? `<ul class="flash bad" role="alert">${errs.map(e => `<li>${h(e)}</li>`).join('')}</ul>` : ''}
<form method="post" action="/admin/products/${p.id || 'new'}" class="aform">${csrfField(c)}<fieldset><legend>Основне</legend>${fld('Назва *', 'name', p.name, 'required maxlength="200"')}${fld('Артикул (SKU)', 'sku', p.sku || '', 'maxlength="60"')}${sel('Категорія', 'category_id', catOpts, p.category_id)}${area('Опис', 'description', p.description, 6)}</fieldset>
<fieldset><legend>Характеристики</legend>${fld('Склад', 'composition', p.composition)}${fld('Ширина, см', 'width_cm', p.width_cm || '', 'inputmode="numeric"')}${fld('Щільність / товщина', 'density', p.density)}</fieldset>
<fieldset><legend>Варіанти (колір / товщина / склад), ціна та залишок</legend><div class="tw"><table class="tbl"><thead><tr><th>Назва варіанта</th><th>Ціна, ₴</th><th>Залишок</th><th>Од.</th><th>Активний</th></tr></thead><tbody>
${rows.map((v, i) => `<tr><td><input type="hidden" name="v${i}_id" value="${v.id}"><input name="v${i}_label" value="${h(v.label)}" maxlength="80" aria-label="Назва варіанта"></td><td><input name="v${i}_price" value="${h(v.price)}" inputmode="decimal" size="8" aria-label="Ціна"></td><td><input name="v${i}_stock" value="${h(v.stock)}" inputmode="numeric" size="6" aria-label="Залишок"></td><td><input name="v${i}_unit" value="${h(v.unit)}" size="4" aria-label="Одиниця"></td><td><input type="checkbox" name="v${i}_active" value="1" ${v.active ? 'checked' : ''} aria-label="Активний"></td></tr>`).join('')}</tbody></table></div><input type="hidden" name="vcount" value="${rows.length}"><small>Порожні рядки без назви ігноруються. Неактивний варіант зникає з магазину.</small></fieldset>
<fieldset><legend>Публікація</legend>${chk('Опубліковано на сайті', 'published', p.published)}${chk('Показувати в «Популярних» на головній', 'featured', p.featured)}</fieldset><button class="btn">Зберегти</button> <a href="/admin/products">Скасувати</a></form>
${p.id ? `<h2>Фотографії</h2><div class="imgs">${imgs.map(i => `<figure><img src="/uploads/${h(i.file)}" alt=""><figcaption><form method="post" action="/admin/images/${i.id}/move">${csrfField(c)}<button name="dir" value="up" class="btn small ghost" title="Ближче до початку">←</button></form>${imgs[0] === i ? '<b>головне</b>' : ''}<form method="post" action="/admin/images/${i.id}/delete" data-confirm="Видалити фото?">${csrfField(c)}<button class="btn small danger">Видалити</button></form></figcaption></figure>`).join('') || '<p class="empty">Фото ще немає.</p>'}</div>
<label>Додати фото (JPEG, PNG, WebP, до 5 МБ)<input type="file" accept="image/jpeg,image/png,image/webp" data-upload="${p.id}"></label><p class="err" data-uperr role="alert"></p>
<form method="post" action="/admin/products/${p.id}/archive" data-confirm="${p.archived ? 'Відновити товар?' : 'Архівувати товар? Він зникне з магазину, історія замовлень збережеться.'}">${csrfField(c)}<button class="btn ${p.archived ? '' : 'danger'}">${p.archived ? 'Відновити з архіву' : 'Архівувати товар'}</button></form>` : '<p class="note">Фотографії можна додати після першого збереження.</p>'}`, null);
}
function saveProduct(c, id, f) {
  const errs = [], s = k => (f.get(k) || '').trim();
  const p = { id, name: s('name'), sku: s('sku') || null, category_id: s('category_id') ? Number(s('category_id')) : null, description: s('description'), composition: s('composition'), width_cm: s('width_cm') ? Number(s('width_cm')) : null, density: s('density'), published: f.get('published') ? 1 : 0, featured: f.get('featured') ? 1 : 0 };
  if (!p.name || p.name.length > 200) errs.push('Вкажіть назву (до 200 символів).');
  if (p.width_cm != null && (!Number.isInteger(p.width_cm) || p.width_cm < 1 || p.width_cm > 1000)) errs.push('Ширина має бути цілим числом, см.');
  if (p.category_id && !db.prepare('SELECT 1 FROM categories WHERE id=?').get(p.category_id)) errs.push('Невідома категорія.');
  const vs = [], n = Math.min(40, parseInt(f.get('vcount')) || 0);
  for (let i = 0; i < n; i++) {
    const v = { id: Number(f.get(`v${i}_id`)) || 0, label: (f.get(`v${i}_label`) || '').trim(), price: (f.get(`v${i}_price`) || '').trim(), stock: (f.get(`v${i}_stock`) || '').trim(), unit: (f.get(`v${i}_unit`) || 'м').trim() || 'м', active: f.get(`v${i}_active`) ? 1 : 0 };
    if (!v.label && !v.id) continue;
    if (!v.label) { errs.push(`Рядок ${i + 1}: вкажіть назву варіанта.`); continue; }
    if (parseKop(v.price) == null) errs.push(`«${v.label}»: некоректна ціна (приклад: 125,50).`);
    if (!/^\d{1,7}$/.test(v.stock || '0')) errs.push(`«${v.label}»: залишок має бути цілим числом ≥ 0.`);
    vs.push(v);
  }
  if (p.published && !vs.some(v => v.active)) errs.push('Для публікації потрібен щонайменше один активний варіант.');
  if (errs.length) return { errs, p, vs };
  try {
    tx(() => {
      if (id) { db.prepare('UPDATE products SET name=?,sku=?,category_id=?,description=?,composition=?,width_cm=?,density=?,published=?,featured=? WHERE id=?').run(p.name, p.sku, p.category_id, p.description, p.composition, p.width_cm, p.density, p.published, p.featured, id); }
      else { const r = db.prepare('INSERT INTO products(slug,name,sku,category_id,description,composition,width_cm,density,published,featured) VALUES(?,?,?,?,?,?,?,?,?,?)').run(uniqueSlug('products', p.name), p.name, p.sku, p.category_id, p.description, p.composition, p.width_cm, p.density, p.published, p.featured); id = Number(r.lastInsertRowid); }
      vs.forEach((v, i) => {
        const pk = parseKop(v.price), st = Number(v.stock || 0);
        if (v.id && db.prepare('SELECT 1 FROM variants WHERE id=? AND product_id=?').get(v.id, id)) db.prepare('UPDATE variants SET label=?,price_kop=?,stock=?,unit=?,active=?,sort=? WHERE id=?').run(v.label, pk, st, v.unit, v.active, i, v.id);
        else db.prepare('INSERT INTO variants(product_id,label,price_kop,stock,unit,active,sort) VALUES(?,?,?,?,?,?,?)').run(id, v.label, pk, st, v.unit, v.active, i);
      });
    });
  } catch (e) { if (/UNIQUE/.test(e.message)) return { errs: ['Артикул вже використовується іншим товаром.'], p, vs }; throw e; }
  audit(c, 'product.save', `#${id} ${p.name}`);
  return { id };
}
const formVariants = vs => vs.map(v => ({ ...v, price: v.price_kop != null ? (v.price_kop / 100).toFixed(2).replace('.', ',') : v.price }));

function categoriesPage(c, edit) {
  const tree = catTree(false), e = edit && db.prepare('SELECT * FROM categories WHERE id=?').get(edit);
  const opts = [['', '— верхній рівень —'], ...tree.filter(x => !e || x.id !== e.id).map(x => [x.id, '\u00A0\u00A0'.repeat(x.depth) + x.name])];
  return adminLayout(c, 'Категорії', `${table(['Назва', 'Slug', 'Порядок', 'Статус', ''], tree.map(x => `<tr><td>${'—'.repeat(x.depth)} ${h(x.name)}</td><td>${h(x.slug)}</td><td>${x.sort}</td><td>${x.published ? 'Опубліковано' : 'Приховано'}</td><td><a href="/admin/categories?edit=${x.id}">Редагувати</a> <form class="inline" method="post" action="/admin/categories/${x.id}/delete" data-confirm="Видалити категорію?">${csrfField(c)}<button class="btn small danger">Видалити</button></form></td></tr>`), 'Категорій ще немає.')}
<h2>${e ? 'Редагувати категорію' : 'Нова категорія'}</h2><form method="post" action="/admin/categories/${e ? e.id : 'new'}" class="aform">${csrfField(c)}${fld('Назва *', 'name', e?.name, 'required maxlength="100"')}${sel('Батьківська категорія', 'parent_id', opts, e?.parent_id)}${area('Опис', 'description', e?.description, 3)}${fld('Порядок', 'sort', e?.sort ?? 0, 'inputmode="numeric"')}${chk('Опубліковано', 'published', e ? e.published : 1)}<button class="btn">Зберегти</button> ${e ? '<a href="/admin/categories">Скасувати</a>' : ''}</form>`, flashOf(c.q));
}
function saveCategory(c, id, f) {
  const name = (f.get('name') || '').trim(), parent = f.get('parent_id') ? Number(f.get('parent_id')) : null;
  if (!name || name.length > 100) return 'Вкажіть назву.';
  if (parent && !db.prepare('SELECT 1 FROM categories WHERE id=?').get(parent)) return 'Невідома батьківська категорія.';
  if (id) for (let x = parent, i = 0; x && i < 50; i++) { if (x === id) return 'Категорія не може бути вкладена сама в себе (цикл).'; x = db.prepare('SELECT parent_id FROM categories WHERE id=?').get(x)?.parent_id; }
  const sort = parseInt(f.get('sort')) || 0, d = (f.get('description') || '').trim(), pub = f.get('published') ? 1 : 0;
  if (id) db.prepare('UPDATE categories SET name=?,parent_id=?,description=?,sort=?,published=? WHERE id=?').run(name, parent, d, sort, pub, id);
  else db.prepare('INSERT INTO categories(slug,name,parent_id,description,sort,published) VALUES(?,?,?,?,?,?)').run(uniqueSlug('categories', name), name, parent, d, sort, pub);
  audit(c, 'category.save', name); return null;
}
function ordersList(c) {
  const q = c.q, w = [], a = [];
  if (STATUS[q.status]) { w.push('status=?'); a.push(q.status); } if (q.n) { w.push('(number LIKE ? OR phone LIKE ? OR name LIKE ?)'); a.push(...Array(3).fill(`%${q.n.trim()}%`)); }
  if (/^\d{4}-\d\d-\d\d$/.test(q.from || '')) { w.push('date(created_at)>=?'); a.push(q.from); } if (/^\d{4}-\d\d-\d\d$/.test(q.to || '')) { w.push('date(created_at)<=?'); a.push(q.to); }
  const rows = db.prepare(`SELECT * FROM orders ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY id DESC LIMIT 200`).all(...a);
  return adminLayout(c, 'Замовлення', `<form class="inline" method="get"><input name="n" placeholder="№, ім'я або телефон" value="${h(q.n || '')}">${sel('', 'status', [['', 'Усі статуси'], ...Object.entries(STATUS)], q.status)}<input type="date" name="from" value="${h(q.from || '')}" aria-label="Від"><input type="date" name="to" value="${h(q.to || '')}" aria-label="До"><button class="btn small">Фільтрувати</button></form>
${table(['№', 'Дата', 'Покупець', 'Телефон', 'Доставка', 'Сума', 'Статус'], rows.map(o => `<tr><td><a href="/admin/orders/${o.id}">${o.number}</a></td><td>${when(o.created_at)}</td><td>${h(o.name)}</td><td>${h(o.phone)}</td><td>${DELIVERY[o.delivery]}</td><td>${kop(o.total_kop)}</td><td>${badge(o.status)}</td></tr>`), 'Замовлень не знайдено.')}`, flashOf(q));
}
function orderPage(c, id) {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(id); if (!o) return null;
  const items = db.prepare('SELECT * FROM order_items WHERE order_id=?').all(id), hist = db.prepare('SELECT * FROM order_history WHERE order_id=? ORDER BY id').all(id);
  return adminLayout(c, `Замовлення ${o.number}`, `<p>${badge(o.status)} · ${when(o.created_at)}</p><div class="split top"><div><h2>Покупець</h2><p>${h(o.name)}<br><a href="tel:${h(o.phone)}">${h(o.phone)}</a>${o.email ? `<br>${h(o.email)}` : ''}</p><p>${h(o.city)}, ${DELIVERY[o.delivery]}${o.address ? `<br>${h(o.address)}` : ''}</p>${o.comment ? `<p><em>${h(o.comment)}</em></p>` : ''}</div>
<div><h2>Статус</h2>${o.status === 'cancelled' ? '<p>Замовлення скасовано (остаточно).</p>' : `<form method="post" action="/admin/orders/${id}/status" class="aform">${csrfField(c)}${sel('Новий статус', 'status', Object.entries(STATUS), o.status)}<button class="btn">Змінити</button></form><p class="note">Скасування повертає товари на склад.</p>`}
<form method="post" action="/admin/orders/${id}/note" class="aform">${csrfField(c)}${area('Внутрішня нотатка', 'note', o.note, 3)}<button class="btn small">Зберегти нотатку</button></form></div></div>
<h2>Склад (ціни на момент замовлення)</h2>${table(['Товар', 'Варіант', 'Ціна', 'К-сть', 'Сума'], items.map(i => `<tr><td>${h(i.product_name)}</td><td>${h(i.variant_label)}</td><td>${kop(i.unit_price_kop)}</td><td>${i.qty} ${h(i.unit)}</td><td>${kop(i.unit_price_kop * i.qty)}</td></tr>`), '')}<p><strong>Разом: ${kop(o.total_kop)}</strong></p>
<h2>Історія статусів</h2><ul>${hist.map(x => `<li>${when(x.at)} — ${STATUS[x.status]}</li>`).join('')}</ul>`, flashOf(c.q));
}
function setStatus(c, id, st) {
  if (!STATUS[st]) return 'Невідомий статус.';
  return tx(() => {
    const o = db.prepare('SELECT status FROM orders WHERE id=?').get(id); if (!o) return 'Замовлення не знайдено.';
    if (o.status === 'cancelled') return 'Скасоване замовлення змінювати не можна.'; if (o.status === st) return null;
    if (st === 'cancelled') for (const i of db.prepare('SELECT variant_id,qty FROM order_items WHERE order_id=?').all(id)) db.prepare('UPDATE variants SET stock=stock+? WHERE id=?').run(i.qty, i.variant_id);
    db.prepare('UPDATE orders SET status=? WHERE id=?').run(st, id); db.prepare('INSERT INTO order_history(order_id,status,admin_id) VALUES(?,?,?)').run(id, st, c.admin.admin_id);
    audit(c, 'order.status', `#${id} → ${st}`); return null;
  });
}
function pagesAdmin(c, slug) {
  const all = db.prepare('SELECT * FROM pages ORDER BY rowid').all(), e = slug && all.find(p => p.slug === slug);
  return adminLayout(c, 'Інформаційні сторінки', `${table(['Сторінка', 'Статус', ''], all.map(p => `<tr><td>${h(p.title)}</td><td>${p.published && p.body ? 'Опубліковано' : 'Не опубліковано'}</td><td><a href="/admin/pages?edit=${p.slug}">Редагувати</a></td></tr>`), '')}
${e ? `<h2>${h(e.title)}</h2><form method="post" action="/admin/pages/${e.slug}" class="aform">${csrfField(c)}${fld('Заголовок', 'title', e.title, 'required maxlength="150"')}${area('Текст (абзаци розділяйте порожнім рядком)', 'body', e.body, 14)}${chk('Опублікувати (потрібен непорожній текст)', 'published', e.published)}<button class="btn">Зберегти</button></form>` : '<p class="note">Оберіть сторінку для редагування. Непубліковані сторінки не показуються в меню й футері.</p>'}`, flashOf(c.q));
}
const SETTING_FIELDS = [['company', 'Назва компанії'], ['topbar', 'Верхня смуга (короткий текст, напр. про доставку)'], ['phone', 'Телефон'], ['email', 'Email'], ['address', 'Адреса'], ['hours', 'Графік роботи'], ['hero_title', 'Заголовок головної (hero)'], ['seo_description', 'Основний SEO-опис сайту']];
function settingsPage(c) {
  const s = settings();
  return adminLayout(c, 'Налаштування сайту', `<form method="post" action="/admin/settings" class="aform">${csrfField(c)}${SETTING_FIELDS.map(([k, l]) => fld(l, k, s[k], 'maxlength="300"')).join('')}${area('Підзаголовок головної', 'hero_subtitle', s.hero_subtitle, 2)}${area('Переваги виробника (кожна з нового рядка; лише підтверджені факти)', 'advantages', s.advantages, 5)}${area('Соцмережі (посилання, кожне з нового рядка)', 'social', s.social, 3)}<button class="btn">Зберегти</button></form>`, flashOf(c.q));
}
function messagesPage(c) {
  const rows = db.prepare('SELECT * FROM messages ORDER BY id DESC LIMIT 200').all();
  return adminLayout(c, 'Звернення', table(['Дата', 'Тип', 'Ім\'я', 'Контакт', 'Повідомлення'], rows.map(m => `<tr><td>${when(m.created_at)}</td><td>${m.kind === 'wholesale' ? 'Опт' : 'Контакти'}</td><td>${h(m.name)}</td><td>${h(m.phone)} ${h(m.email)}</td><td>${h(m.message)}</td></tr>`), 'Звернень поки немає.'));
}
const IMG_SIG = [['ffd8ff', '.jpg'], ['89504e47', '.png']];
function imageExt(buf) { const hx = buf.subarray(0, 12).toString('hex'); for (const [s, e] of IMG_SIG) if (hx.startsWith(s)) return e; return buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP' ? '.webp' : null; }

// ---------- маршрутизація ----------
const notFound = (c) => send(c.res, 404, layout(c, { title: 'Сторінку не знайдено', body: '<div class="wrap sec"><h1>Сторінку не знайдено</h1><p><a class="btn" href="/catalog">До каталогу</a></p></div>' }));
async function handle(req, res) {
  let p; const url = new URL(req.url, 'http://x');
  try { p = decodeURIComponent(url.pathname); } catch { return send(res, 400, 'Bad request', 'text/plain'); }
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  const m = req.method;
  if (m === 'GET' && p.startsWith('/static/')) return serve(res, path.join(__dirname, 'public'), p.slice(8), 'public, max-age=3600');
  if (m === 'GET' && p.startsWith('/uploads/')) return serve(res, path.join(DATA, 'uploads'), p.slice(9), 'public, max-age=86400');
  if (!['GET', 'POST', 'HEAD'].includes(m)) return send(res, 405, 'Method not allowed', 'text/plain');
  const ip = process.env.TRUST_PROXY === '1' ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress : req.socket.remoteAddress;
  const c = { req, res, q: Object.fromEntries(url.searchParams), S: settings(), ip, admin: null };
  const origin = req.headers.origin; if (m === 'POST' && origin && new URL(origin).host !== req.headers.host) return send(res, 403, 'Forbidden', 'text/plain');
  const isAdmin = p === '/admin' || p.startsWith('/admin/');
  const b = m === 'POST' ? await readBody(req, p.startsWith('/admin/upload/') ? 6e6 : 1e6) : null;
  let mt; const is = (meth, re) => (m === meth || (meth === 'GET' && m === 'HEAD')) && (mt = re.exec(p));

  if (isAdmin) {
    res.setHeader('X-Robots-Tag', 'noindex'); res.setHeader('Cache-Control', 'no-store');
    if (is('GET', /^\/admin\/login$/)) return send(res, 200, loginPage(c.q.err));
    if (is('POST', /^\/admin\/login$/)) {
      if (limited('login:' + ip, 5, 15 * 60e3)) return send(res, 429, loginPage('Забагато спроб. Спробуйте за 15 хвилин.'));
      const a = db.prepare('SELECT * FROM admins WHERE email=?').get((b.f.get('email') || '').trim().toLowerCase());
      const ok = verifyPassword(b.f.get('password') || '', a?.pass_hash);
      if (!a || !ok) return send(res, 401, loginPage('Невірний email або пароль.'));
      const token = crypto.randomBytes(32).toString('hex'); db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
      db.prepare('INSERT INTO sessions(token,admin_id,csrf,expires) VALUES(?,?,?,?)').run(sha(token), a.id, crypto.randomBytes(24).toString('hex'), Date.now() + 8 * 3600e3);
      c.admin = { admin_id: a.id }; audit(c, 'login', a.email);
      return redirect(res, '/admin', { 'Set-Cookie': `sid=${token}${cookieAttrs(8 * 3600)}` });
    }
    const tok = cookies(req).sid;
    const sess = tok && db.prepare('SELECT s.csrf, s.admin_id, a.email, a.role FROM sessions s JOIN admins a ON a.id=s.admin_id WHERE s.token=? AND s.expires>?').get(sha(tok), Date.now());
    if (!sess) return m === 'POST' && p.startsWith('/admin/upload/') ? json(res, 401, { error: 'Сесія завершена' }) : redirect(res, '/admin/login');
    c.admin = { ...sess };
    if (m === 'POST' && !safeEq(b.f.get('_csrf') || req.headers['x-csrf'] || '', sess.csrf)) return send(res, 403, 'Недійсний CSRF-токен', 'text/plain');
    const area_ = /^\/admin\/(products|categories|images|upload)/.test(p) ? 'catalog' : /^\/admin\/(orders|messages)/.test(p) ? 'orders' : /^\/admin\/pages/.test(p) ? 'content' : /^\/admin\/settings/.test(p) ? 'settings' : null;
    if (area_ && !ROLES[sess.role].includes(area_)) return send(res, 403, adminLayout(c, 'Немає доступу', '<p>У вашої ролі немає прав на цей розділ.</p>'));
    if (is('POST', /^\/admin\/logout$/)) { db.prepare('DELETE FROM sessions WHERE token=?').run(sha(tok)); return redirect(res, '/admin/login', { 'Set-Cookie': `sid=${cookieAttrs(0)}` }); }
    const H = (html) => send(res, 200, html);
    if (is('GET', /^\/admin$/)) return H(dashboard(c));
    if (is('GET', /^\/admin\/products$/)) return H(productsList(c));
    if (is('GET', /^\/admin\/products\/new$/)) return H(productForm(c, { name: '', description: '', composition: '', density: '', published: 0, featured: 0 }, []));
    if (is('POST', /^\/admin\/products\/(new|\d+)$/)) {
      const id = mt[1] === 'new' ? 0 : Number(mt[1]); const r = saveProduct(c, id, b.f);
      if (r.errs) return send(res, 422, productForm(c, { ...(id ? db.prepare('SELECT * FROM products WHERE id=?').get(id) : {}), ...r.p }, formVariants(r.vs), r.errs));
      return back(res, `/admin/products/${r.id}`, 'ok', 'Збережено');
    }
    if (is('GET', /^\/admin\/products\/(\d+)$/)) {
      const pr = db.prepare('SELECT * FROM products WHERE id=?').get(mt[1]); if (!pr) return notFound(c);
      const html = productForm(c, pr, formVariants(db.prepare('SELECT * FROM variants WHERE product_id=? ORDER BY sort,id').all(pr.id)));
      return H(c.q.ok ? html.replace('<main class="awrap">', `<main class="awrap"><p class="flash good" role="status">${h(c.q.ok)}</p>`) : html);
    }
    if (is('POST', /^\/admin\/products\/(\d+)\/archive$/)) { const pr = db.prepare('SELECT archived FROM products WHERE id=?').get(mt[1]); if (!pr) return notFound(c); db.prepare('UPDATE products SET archived=?, published=CASE WHEN ?=1 THEN 0 ELSE published END WHERE id=?').run(pr.archived ? 0 : 1, pr.archived ? 0 : 1, mt[1]); audit(c, 'product.archive', mt[1]); return back(res, '/admin/products', 'ok', pr.archived ? 'Товар відновлено' : 'Товар архівовано'); }
    if (is('POST', /^\/admin\/upload\/(\d+)$/)) {
      if (!db.prepare('SELECT 1 FROM products WHERE id=?').get(mt[1])) return json(res, 404, { error: 'Товар не знайдено' });
      if (!b.raw.length || b.raw.length > 5 * 1024 * 1024) return json(res, 422, { error: 'Розмір файлу має бути до 5 МБ' });
      const ext = imageExt(b.raw); if (!ext) return json(res, 422, { error: 'Дозволені лише JPEG, PNG або WebP' });
      const file = crypto.randomBytes(16).toString('hex') + ext; fs.writeFileSync(path.join(DATA, 'uploads', file), b.raw, { flag: 'wx' });
      db.prepare('INSERT INTO images(product_id,file,sort) VALUES(?,?,(SELECT COALESCE(MAX(sort),0)+1 FROM images WHERE product_id=?))').run(mt[1], file, mt[1]); audit(c, 'image.upload', file); return json(res, 201, { file });
    }
    if (is('POST', /^\/admin\/images\/(\d+)\/delete$/)) { const im = db.prepare('SELECT * FROM images WHERE id=?').get(mt[1]); if (!im) return notFound(c); db.prepare('DELETE FROM images WHERE id=?').run(im.id); fs.rmSync(path.join(DATA, 'uploads', path.basename(im.file)), { force: true }); return redirect(res, `/admin/products/${im.product_id}`); }
    if (is('POST', /^\/admin\/images\/(\d+)\/move$/)) { const im = db.prepare('SELECT * FROM images WHERE id=?').get(mt[1]); if (!im) return notFound(c); const prev = db.prepare('SELECT * FROM images WHERE product_id=? AND (sort<? OR (sort=? AND id<?)) ORDER BY sort DESC,id DESC LIMIT 1').get(im.product_id, im.sort, im.sort, im.id); if (prev) tx(() => { db.prepare('UPDATE images SET sort=? WHERE id=?').run(prev.sort === im.sort ? prev.sort - 1 : prev.sort, im.id); if (prev.sort !== im.sort) db.prepare('UPDATE images SET sort=? WHERE id=?').run(im.sort, prev.id); }); return redirect(res, `/admin/products/${im.product_id}`); }
    if (is('GET', /^\/admin\/categories$/)) return H(categoriesPage(c, Number(c.q.edit) || 0));
    if (is('POST', /^\/admin\/categories\/(new|\d+)\/?$/)) { const err = saveCategory(c, mt[1] === 'new' ? 0 : Number(mt[1]), b.f); return err ? back(res, '/admin/categories', 'err', err) : back(res, '/admin/categories', 'ok', 'Збережено'); }
    if (is('POST', /^\/admin\/categories\/(\d+)\/delete$/)) {
      const id = Number(mt[1]); if (db.prepare('SELECT 1 FROM categories WHERE parent_id=?').get(id)) return back(res, '/admin/categories', 'err', 'Спочатку видаліть або перемістіть вкладені категорії.');
      if (db.prepare('SELECT 1 FROM products WHERE category_id=?').get(id)) return back(res, '/admin/categories', 'err', 'У категорії є товари (у т.ч. архівні). Перемістіть їх.');
      db.prepare('DELETE FROM categories WHERE id=?').run(id); audit(c, 'category.delete', id); return back(res, '/admin/categories', 'ok', 'Категорію видалено');
    }
    if (is('GET', /^\/admin\/orders$/)) return H(ordersList(c));
    if (is('GET', /^\/admin\/orders\/(\d+)$/)) { const html = orderPage(c, Number(mt[1])); return html ? H(html) : notFound(c); }
    if (is('POST', /^\/admin\/orders\/(\d+)\/status$/)) { const err = setStatus(c, Number(mt[1]), b.f.get('status')); return back(res, `/admin/orders/${mt[1]}`, err ? 'err' : 'ok', err || 'Статус оновлено'); }
    if (is('POST', /^\/admin\/orders\/(\d+)\/note$/)) { db.prepare('UPDATE orders SET note=? WHERE id=?').run((b.f.get('note') || '').slice(0, 2000), mt[1]); return back(res, `/admin/orders/${mt[1]}`, 'ok', 'Нотатку збережено'); }
    if (is('GET', /^\/admin\/messages$/)) return H(messagesPage(c));
    if (is('GET', /^\/admin\/pages$/)) return H(pagesAdmin(c, c.q.edit));
    if (is('POST', /^\/admin\/pages\/(\w+)$/)) {
      const body = (b.f.get('body') || '').trim(), title = (b.f.get('title') || '').trim().slice(0, 150);
      if (!title || !db.prepare('SELECT 1 FROM pages WHERE slug=?').get(mt[1])) return back(res, '/admin/pages', 'err', 'Некоректні дані.');
      db.prepare('UPDATE pages SET title=?, body=?, published=? WHERE slug=?').run(title, body, b.f.get('published') && body ? 1 : 0, mt[1]); audit(c, 'page.save', mt[1]); return back(res, '/admin/pages', 'ok', 'Сторінку збережено');
    }
    if (is('GET', /^\/admin\/settings$/)) return H(settingsPage(c));
    if (is('POST', /^\/admin\/settings$/)) {
      const keys = [...SETTING_FIELDS.map(x => x[0]), 'hero_subtitle', 'advantages', 'social'];
      tx(() => keys.forEach(k => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, (b.f.get(k) || '').trim().slice(0, 2000)))); audit(c, 'settings.save'); return back(res, '/admin/settings', 'ok', 'Налаштування збережено');
    }
    return notFound(c);
  }

  // --- публічні маршрути ---
  if (is('GET', /^\/$/)) return send(res, 200, home(c));
  if (is('GET', /^\/catalog$/)) return send(res, 200, catalog(c, null));
  if (is('GET', /^\/catalog\/([\w-]+)$/)) { const html = catalog(c, mt[1]); return html ? send(res, 200, html) : notFound(c); }
  if (is('GET', /^\/product\/([\w-]+)$/)) { const html = productPage(c, mt[1]); return html ? send(res, 200, html) : notFound(c); }
  if (is('GET', /^\/cart$/)) return send(res, 200, cartPage(c, false), undefined, { 'Cache-Control': 'no-store' });
  if (is('GET', /^\/checkout$/)) return send(res, 200, cartPage(c, true), undefined, { 'Cache-Control': 'no-store' });
  if (is('GET', /^\/order-success$/)) return send(res, 200, layout(c, { title: 'Замовлення прийнято', body: `<div class="wrap sec"><h1>Дякуємо! Замовлення прийнято</h1><p>Номер вашого замовлення: <strong>${h((c.q.n || '').replace(/[^\w-]/g, '').slice(0, 20))}</strong></p><p>Ми зв'яжемося з вами для підтвердження.</p><a class="btn" href="/catalog">Продовжити покупки</a></div>` }));
  if (is('GET', /^\/page\/(\w+)$/)) { const pg = db.prepare("SELECT * FROM pages WHERE slug=? AND published=1 AND body!=''").get(mt[1]); if (!pg) return notFound(c); return send(res, 200, layout(c, { title: pg.title, canon: '/page/' + pg.slug, body: `${crumbs([['/', 'Головна'], [null, pg.title]])}<article class="wrap prose"><h1>${h(pg.title)}</h1>${pg.body.split(/\n{2,}/).map(x => `<p>${h(x).replace(/\n/g, '<br>')}</p>`).join('')}</article>` })); }
  if (is('GET', /^\/contacts$/)) { const s = c.S; return send(res, 200, layout(c, { title: 'Контакти', canon: '/contacts', body: `${crumbs([['/', 'Головна'], [null, 'Контакти']])}<div class="wrap sec split"><div><h1>Контакти</h1>${[['Телефон', s.phone], ['Email', s.email], ['Адреса', s.address], ['Графік роботи', s.hours]].filter(x => x[1]).map(([k, v]) => `<p><strong>${k}:</strong> ${h(v)}</p>`).join('') || '<p>Контактні дані ще не додано в адмін-панелі.</p>'}</div><form class="form" data-lead="contact"><h2>Напишіть нам</h2>${leadFields()}</form></div>` })); }
  if (is('GET', /^\/robots\.txt$/)) return send(res, 200, `User-agent: *\nDisallow: /admin\nDisallow: /cart\nDisallow: /checkout\nSitemap: ${BASE}/sitemap.xml\n`, 'text/plain; charset=utf-8');
  if (is('GET', /^\/sitemap\.xml$/)) {
    const u = ['/', '/catalog', '/contacts', ...db.prepare("SELECT slug FROM categories WHERE published=1").all().map(x => '/catalog/' + x.slug), ...db.prepare("SELECT slug FROM products WHERE published=1 AND archived=0").all().map(x => '/product/' + x.slug), ...db.prepare("SELECT slug FROM pages WHERE published=1 AND body!=''").all().map(x => '/page/' + x.slug)];
    return send(res, 200, `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${u.map(x => `<url><loc>${h(BASE + x)}</loc></url>`).join('')}</urlset>`, 'application/xml; charset=utf-8');
  }
  if (is('POST', /^\/api\/cart$/)) { if (!b.j || !Array.isArray(b.j.items) || b.j.items.length > 50 || !b.j.items.every(i => Number.isInteger(i?.id) && Number.isInteger(i?.qty) && i.qty > 0)) return json(res, 400, { error: 'Некоректний кошик' }); return json(res, 200, { items: cartLines(b.j.items) }); }
  if (is('POST', /^\/api\/orders$/)) { if (limited('order:' + ip, 10, 10 * 60e3)) return json(res, 429, { error: 'Забагато спроб. Спробуйте пізніше.' }); const r = createOrder(b.j || {}, ip); return json(res, r.status, r.body); }
  if (is('POST', /^\/api\/lead$/)) {
    if (limited('lead:' + ip, 5, 10 * 60e3)) return json(res, 429, { error: 'Забагато спроб. Спробуйте пізніше.' });
    const j = b.j || {}, name = String(j.name || '').trim(), phone = String(j.phone || '').trim(), msg = String(j.message || '').trim(), kind = j.kind === 'wholesale' ? 'wholesale' : 'contact';
    if (name.length < 2 || name.length > 100 || !/^\+?[\d\s()-]{9,18}$/.test(phone) || msg.length < 2 || msg.length > 2000) return json(res, 422, { error: 'Перевірте ім\'я, телефон і повідомлення.' });
    db.prepare('INSERT INTO messages(kind,name,phone,message) VALUES(?,?,?,?)').run(kind, name, phone, msg); return json(res, 201, { ok: true });
  }
  return notFound(c);
}
function loginPage(err) {
  return `<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Вхід — Адмін</title><link rel="stylesheet" href="/static/style.css"></head><body class="admin"><main class="login"><h1>Вхід в адмін-панель</h1>${err ? `<p class="flash bad" role="alert">${h(err)}</p>` : ''}
<form method="post" action="/admin/login" class="aform"><label>Email<input name="email" type="email" required autocomplete="username"></label><label>Пароль<input name="password" type="password" required autocomplete="current-password"></label><button class="btn">Увійти</button></form></main></body></html>`;
}
const server = http.createServer((req, res) => handle(req, res).catch(e => {
  if (e instanceof HttpErr) return send(res, e.status, e.message, 'text/plain; charset=utf-8');
  console.error(e); if (!res.headersSent) send(res, 500, '<h1>Помилка сервера</h1><p>Спробуйте пізніше.</p>');
}));
module.exports = { server };
if (require.main === module) server.listen(PORT, () => console.log(`Сайт: http://localhost:${PORT}  Адмінка: http://localhost:${PORT}/admin`));

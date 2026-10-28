'use strict';
(() => {
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const kop = n => (n / 100).toFixed(2).replace('.', ',') + ' ₴';
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const load = () => { try { const o = JSON.parse(localStorage.getItem('cart') || '{}'); return o && typeof o === 'object' ? o : {}; } catch { return {}; } };
  const save = c => { localStorage.setItem('cart', JSON.stringify(c)); count(); };
  const count = () => { const n = Object.values(load()).reduce((a, b) => a + b, 0); $$('[data-cart-count]').forEach(e => e.textContent = n); };
  let tt; const toast = (m) => { const t = $('#toast'); if (!t) return; t.textContent = m; t.classList.add('on'); clearTimeout(tt); tt = setTimeout(() => t.classList.remove('on'), 2500); };
  const add = (id, qty, max) => { const c = load(), cur = c[id] || 0, want = Math.min(cur + qty, max || 100000); if (max != null && cur >= max) return toast('Більше немає в наявності'); c[id] = want; save(c); toast(want < cur + qty ? `Додано (максимум ${max})` : 'Додано до кошика'); };
  count();
  $('[data-nav]')?.addEventListener('click', e => { const n = $('#nav'), o = n.classList.toggle('open'); e.currentTarget.setAttribute('aria-expanded', o); });
  const f = $('[data-filters]'); if (f && matchMedia('(min-width:900px)').matches) f.open = true;
  document.addEventListener('click', e => {
    const a = e.target.closest('[data-add]'); if (a) add(Number(a.dataset.add), 1);
    const t = e.target.closest('[data-thumb]'); if (t) $('#mainimg').src = t.dataset.thumb;
  });
  document.addEventListener('submit', e => { const m = e.target.dataset.confirm; if (m && !confirm(m)) e.preventDefault(); });
  // сторінка товару
  const pdp = $('[data-add-pdp]');
  if (pdp) {
    const radios = $$('input[name=variant]'), qty = $('[data-qty]');
    const cur = () => radios.find(r => r.checked), upd = () => { const r = cur(); if (!r) return; $('[data-price]').textContent = kop(+r.dataset.price); $('[data-unit]').textContent = r.dataset.unit; qty.max = r.dataset.stock; $('[data-stock-line]').textContent = `В наявності: ${r.dataset.stock} ${r.dataset.unit}`; };
    radios.forEach(r => r.addEventListener('change', upd)); upd();
    pdp.addEventListener('click', () => { const r = cur(); if (!r) return toast('Оберіть доступний варіант'); const q = parseInt(qty.value); if (!(q >= 1)) return toast('Вкажіть кількість'); add(Number(r.value), q, Number(r.dataset.stock)); });
  }
  // форми звернень
  $$('[data-lead]').forEach(fm => fm.addEventListener('submit', async e => {
    e.preventDefault(); const btn = $('button', fm), er = $('[data-err]', fm); btn.disabled = true; er.textContent = '';
    try { const r = await fetch('/api/lead', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...Object.fromEntries(new FormData(fm)), kind: fm.dataset.lead }) }); const j = await r.json(); if (!r.ok) throw new Error(j.error || 'Помилка'); fm.reset(); toast('Дякуємо! Ми зв\'яжемося з вами.'); } catch (x) { er.textContent = x.message; } finally { btn.disabled = false; }
  }));
  // кошик / оформлення
  const box = $('[data-cart]');
  if (box) {
    const checkout = box.dataset.mode === 'checkout'; let lines = [];
    const draw = () => {
      const c = load(); if (!lines.length) { box.innerHTML = '<div class="empty"><p>Кошик порожній.</p><a class="btn" href="/catalog">Перейти до каталогу</a></div>'; $('#checkout')?.setAttribute('hidden', ''); return; }
      $('#checkout')?.removeAttribute('hidden');
      const total = lines.reduce((t, l) => t + (l.ok ? l.line_kop : 0), 0);
      box.innerHTML = lines.map(l => `<div class="cl"><div class="ph">${l.img ? `<img src="/uploads/${esc(l.img)}" alt="">` : '<div class="weave"></div>'}</div>
<div>${l.ok ? `<a href="/product/${esc(l.slug)}"><strong>${esc(l.name)}</strong></a><br><small>${esc(l.label)} · ${kop(l.price_kop)}/${esc(l.unit)}</small>${l.qty > l.stock ? `<br><small class="err">Доступно лише ${l.stock}</small>` : ''}` : '<strong class="err">Товар більше недоступний</strong>'}</div>
<div>${l.ok && !checkout ? `<input type="number" min="1" max="${l.stock}" value="${l.qty}" data-q="${l.id}" aria-label="Кількість"> ` : `${l.qty} ${esc(l.unit)} `}<strong>${kop(l.line_kop)}</strong> ${checkout ? '' : `<button class="btn small ghost" data-rm="${l.id}">Видалити</button>`}</div></div>`).join('')
        + `<p class="price big">Разом: ${kop(total)}</p>${checkout ? '<p><a href="/cart">← Змінити кошик</a></p>' : '<p><a class="btn" href="/checkout">Оформити замовлення</a> <a class="btn ghost" href="/catalog">Продовжити покупки</a></p>'}`;
    };
    const refresh = async () => {
      const c = load(), items = Object.entries(c).map(([id, qty]) => ({ id: +id, qty }));
      if (!items.length) { lines = []; return draw(); }
      try { const r = await fetch('/api/cart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) }); lines = (await r.json()).items || []; } catch { box.innerHTML = '<p class="err">Не вдалося завантажити кошик. Спробуйте ще раз.</p>'; return; }
      let ch = false; for (const l of lines) { if (!l.ok) continue; if (l.stock > 0 && c[l.id] > l.stock && !checkout) { c[l.id] = l.stock; l.qty = l.stock; l.line_kop = l.price_kop * l.stock; ch = true; } }
      if (ch) { save(c); toast('Кількість зменшено до доступної'); } draw();
    };
    box.addEventListener('change', e => { const q = e.target.dataset.q; if (!q) return; const c = load(), v = Math.max(1, parseInt(e.target.value) || 1); c[q] = v; save(c); refresh(); });
    box.addEventListener('click', e => { const r = e.target.dataset.rm; if (!r) return; const c = load(); delete c[r]; save(c); refresh(); });
    refresh();
    const fm = $('#checkout');
    if (fm) {
      const toggle = () => $('[data-addr]').hidden = fm.delivery.value === 'pickup'; fm.delivery.addEventListener('change', toggle); toggle();
      fm.addEventListener('submit', async e => {
        e.preventDefault(); const btn = $('[data-submit]'), g = $('[data-err]'); if (btn.disabled) return; btn.disabled = true; g.textContent = ''; $$('[data-for]', fm).forEach(x => x.textContent = '');
        const key = sessionStorage.getItem('idem') || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)); sessionStorage.setItem('idem', key);
        const items = Object.entries(load()).map(([id, qty]) => ({ id: +id, qty }));
        try {
          const r = await fetch('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...Object.fromEntries(new FormData(fm)), items, idem: key }) }); const j = await r.json();
          if (r.ok) { localStorage.removeItem('cart'); sessionStorage.removeItem('idem'); location.href = '/order-success?n=' + encodeURIComponent(j.number); return; }
          if (j.errors) { for (const [k, m] of Object.entries(j.errors)) { const el = $(`[data-for="${k}"]`, fm); if (el) el.textContent = m; else g.textContent = m; } }
          else { g.textContent = j.error || 'Помилка'; if (j.problems) { sessionStorage.removeItem('idem'); g.textContent += ' ' + j.problems.map(p => p.msg).join('; '); lines = j.cart || lines; draw(); } }
        } catch { g.textContent = 'Немає зв\'язку із сервером. Спробуйте ще раз.'; } finally { btn.disabled = false; }
      });
    }
  }
  // адмін: завантаження фото
  $$('[data-upload]').forEach(inp => inp.addEventListener('change', async () => {
    const file = inp.files[0], er = $('[data-uperr]'); if (!file) return; er.textContent = '';
    if (file.size > 5 * 1024 * 1024) { er.textContent = 'Файл більше 5 МБ'; return; }
    const r = await fetch('/admin/upload/' + inp.dataset.upload, { method: 'POST', headers: { 'X-CSRF': document.body.dataset.csrf, 'Content-Type': 'application/octet-stream' }, body: file });
    if (r.ok) location.reload(); else { try { er.textContent = (await r.json()).error; } catch { er.textContent = 'Помилка завантаження'; } }
  }));
})();

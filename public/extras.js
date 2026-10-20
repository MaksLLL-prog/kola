/* Kolo extras: рисование шапки профиля, контекстное меню (ПКМ / долгое нажатие), свайп для ответа.
   Грузится до app.js; общие функции (toast, I, ...) берутся из app.js в момент вызова. */

// ---------- контекстное меню ----------
let ctxEl = null;
function closeCtx() { document.querySelector('.ctx-back')?.remove(); ctxEl?.remove(); ctxEl = null; }
function ctxMenu(items, x, y) {
  closeCtx();
  items = items.filter(Boolean);
  if (!items.length) return;
  const el = document.createElement('div');
  el.className = 'ctx'; el.setAttribute('role', 'menu');
  el.innerHTML = items.map((it, i) => `<button type="button" role="menuitem" class="${it.danger ? 'danger' : ''}" data-i="${i}">${it.icon || ''}<span>${it.label}</span></button>`).join('');
  const sheet = matchMedia('(max-width: 900px)').matches;
  if (sheet) { el.classList.add('sheet-ctx'); const back = document.createElement('div'); back.className = 'ctx-back'; back.onclick = closeCtx; document.body.appendChild(back); }
  document.body.appendChild(el);
  if (!sheet) { // у курсора, но не за краем экрана
    const r = el.getBoundingClientRect();
    el.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px';
    el.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
  }
  el.onclick = (e) => { const b = e.target.closest('[data-i]'); if (!b) return; const it = items[+b.dataset.i]; closeCtx(); it.fn(); };
  ctxEl = el;
  navigator.vibrate?.(8);
}
addEventListener('keydown', (e) => e.key === 'Escape' && closeCtx());
addEventListener('scroll', () => closeCtx(), true);
document.addEventListener('pointerdown', (e) => { if (ctxEl && !e.target.closest('.ctx')) closeCtx(); }, true);

// провайдеры пунктов меню: kind -> (element) => items. Экраны регистрируют свои, роутер их очищает.
const ctxHooks = {};
function ctxFor(target, x, y) {
  const el = target.closest('[data-ctx]');
  if (!el) return false;
  const items = ctxHooks[el.dataset.ctx]?.(el);
  if (!items || !items.filter(Boolean).length) return false;
  ctxMenu(items, x, y); return true;
}
document.addEventListener('contextmenu', (e) => {
  if (e.target.closest('a[href], input, textarea')) return;
  if (ctxFor(e.target, e.clientX, e.clientY)) e.preventDefault();
});
// долгое нажатие (на iOS contextmenu не приходит)
let lp = null, lpFired = false;
document.addEventListener('touchstart', (e) => {
  lpFired = false;
  if (e.touches.length !== 1 || e.target.closest('a[href], input, textarea, button')) return;
  const t = e.touches[0], target = e.target;
  lp = { x: t.clientX, y: t.clientY, timer: setTimeout(() => { if (ctxFor(target, lp.x, lp.y)) lpFired = true; }, 480) };
}, { passive: true });
document.addEventListener('touchmove', (e) => { if (!lp) return; const t = e.touches[0]; if (Math.abs(t.clientX - lp.x) > 8 || Math.abs(t.clientY - lp.y) > 8) { clearTimeout(lp.timer); lp = null; } }, { passive: true });
document.addEventListener('touchend', (e) => { if (lp) clearTimeout(lp.timer); lp = null; if (lpFired) { e.preventDefault(); setTimeout(() => (lpFired = false), 350); } });
document.addEventListener('click', (e) => { if (lpFired) { e.preventDefault(); e.stopPropagation(); } }, true);

// ---------- свайп вправо для ответа ----------
function swipeReply(container, selector, onReply) {
  let st = null;
  const reset = (el) => { el.style.transition = 'transform .2s'; el.style.transform = ''; el.classList.remove('swipe-ready'); setTimeout(() => (el.style.transition = ''), 220); };
  container.addEventListener('touchstart', (e) => {
    const el = e.target.closest(selector);
    if (!el || e.touches.length !== 1 || e.target.closest('a, button, input, textarea, img[data-zoom]')) return void (st = null);
    st = { el, x: e.touches[0].clientX, y: e.touches[0].clientY, lock: null, fired: false };
  }, { passive: true });
  container.addEventListener('touchmove', (e) => {
    if (!st) return;
    const dx = e.touches[0].clientX - st.x, dy = e.touches[0].clientY - st.y;
    if (!st.lock) { if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return; st.lock = Math.abs(dx) > Math.abs(dy) * 1.4 && dx > 0 ? 'x' : 'y'; if (st.lock === 'y') { st = null; return; } }
    const d = Math.min(72, dx * .6);
    st.el.style.transform = `translateX(${Math.max(0, d)}px)`;
    const ready = d > 44; st.el.classList.toggle('swipe-ready', ready);
    if (ready && !st.fired) { st.fired = true; navigator.vibrate?.(10); }
  }, { passive: true });
  const end = () => { if (!st) return; const el = st.el, fire = st.fired && el.classList.contains('swipe-ready'); st = null; reset(el); if (fire) onReply(el); };
  container.addEventListener('touchend', end); container.addEventListener('touchcancel', end);
}

// ---------- редактор шапки: рисование прямо в приложении ----------
const DRAW_BG = [
  ['Ночь', ['#0b0f1a', '#1b1030']], ['Закат', ['#2a0f3d', '#d6456f']], ['Океан', ['#06202e', '#0c6b8a']],
  ['Лес', ['#07140f', '#1f6b45']], ['Бумага', ['#f4efe6', '#e6dcc9']], ['Уголь', ['#0a0a0a', '#0a0a0a']],
];
const DRAW_COLORS = ['#ffffff', '#b791f2', '#782cbf', '#ff5c7a', '#f2b134', '#34d399', '#3f8ae0', '#111111'];
const W = 1200, H = 400;

function drawEditor(existingUrl) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'drawdlg';
    d.innerHTML = `<div class="dwrap">
      <div class="dtop"><b>Нарисуйте шапку</b><span class="muted">Рисуйте пальцем, мышью или пером</span></div>
      <div class="dstage"><canvas class="dbg" width="${W}" height="${H}"></canvas><canvas class="dfg" width="${W}" height="${H}"></canvas></div>
      <div class="dtools">
        <div class="dgrp" data-g="tool"><button type="button" class="on" data-v="pen">Кисть</button><button type="button" data-v="neon">Неон</button><button type="button" data-v="marker">Маркер</button><button type="button" data-v="eraser">Ластик</button></div>
        <div class="dgrp" data-g="sym"><button type="button" class="on" data-v="0">Без симметрии</button><button type="button" data-v="2">Зеркало</button><button type="button" data-v="6">Калейдоскоп</button></div>
      </div>
      <div class="dtools">
        <div class="dcolors">${DRAW_COLORS.map((c, i) => `<button type="button" class="sw ${i ? '' : 'on'}" style="--c:${c}" data-c="${c}" aria-label="Цвет ${c}"></button>`).join('')}<label class="sw custom" title="Свой цвет"><input type="color" value="#b791f2"></label></div>
        <label class="dsize">Толщина<input type="range" min="2" max="40" value="8"></label>
      </div>
      <div class="dtools"><div class="dbgs">${DRAW_BG.map(([n, g], i) => `<button type="button" class="${i ? '' : 'on'}" data-i="${i}" style="background:linear-gradient(135deg,${g[0]},${g[1]})" title="${n}" aria-label="Фон: ${n}"></button>`).join('')}</div></div>
      <div class="dact"><button type="button" class="btn line sm" id="dundo">Отменить</button><button type="button" class="btn line sm" id="dclear">Очистить</button><span style="flex:1"></span><button type="button" class="btn line" id="dcancel">Закрыть</button><button type="button" class="btn" id="ddone">Готово</button></div></div>`;
    document.body.appendChild(d); d.showModal();
    const bg = d.querySelector('.dbg'), fg = d.querySelector('.dfg'), bctx = bg.getContext('2d'), ctx = fg.getContext('2d');
    let tool = 'pen', sym = 0, color = DRAW_COLORS[0], size = 8, bgi = 0, hist = [], changed = false;
    const paintBg = () => { const [c1, c2] = DRAW_BG[bgi][1]; const g = bctx.createLinearGradient(0, 0, W, H); g.addColorStop(0, c1); g.addColorStop(1, c2); bctx.fillStyle = g; bctx.fillRect(0, 0, W, H); };
    paintBg();
    if (existingUrl) { const im = new Image(); im.onload = () => ctx.drawImage(im, 0, 0, W, H); im.src = existingUrl; }
    const snap = () => { hist.push(ctx.getImageData(0, 0, W, H)); if (hist.length > 25) hist.shift(); };
    const group = (name, fn) => d.querySelector(`[data-g="${name}"]`).addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; b.parentNode.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); fn(b.dataset.v); });
    group('tool', (v) => (tool = v)); group('sym', (v) => (sym = +v));
    d.querySelector('.dcolors').addEventListener('click', (e) => { const b = e.target.closest('.sw[data-c]'); if (!b) return; color = b.dataset.c; d.querySelectorAll('.dcolors .sw').forEach((x) => x.classList.toggle('on', x === b)); if (tool === 'eraser') selTool('pen'); });
    const custom = d.querySelector('.custom input');
    custom.oninput = () => { color = custom.value; d.querySelectorAll('.dcolors .sw').forEach((x) => x.classList.remove('on')); custom.parentNode.classList.add('on'); if (tool === 'eraser') selTool('pen'); };
    const selTool = (v) => { tool = v; d.querySelectorAll('[data-g="tool"] button').forEach((x) => x.classList.toggle('on', x.dataset.v === v)); };
    d.querySelector('.dsize input').oninput = (e) => (size = +e.target.value);
    d.querySelector('.dbgs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; bgi = +b.dataset.i; d.querySelectorAll('.dbgs button').forEach((x) => x.classList.toggle('on', x === b)); paintBg(); changed = true; });

    // рисование
    const pos = (e) => { const r = fg.getBoundingClientRect(); return { x: (e.clientX - r.left) * W / r.width, y: (e.clientY - r.top) * H / r.height, p: e.pointerType === 'pen' && e.pressure ? .35 + e.pressure : 1 }; };
    const copies = () => { // набор преобразований для симметрии
      if (sym === 2) return [[0, 1], [0, -1]];
      if (sym === 6) { const a = []; for (let k = 0; k < 6; k++) { a.push([k * Math.PI / 3, 1]); a.push([k * Math.PI / 3, -1]); } return a; }
      return [[0, 1]];
    };
    const stroke = (a, b, c, w) => { // квадратичная кривая через середины отрезков — линия получается плавной
      const m1 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, m2 = { x: (b.x + c.x) / 2, y: (b.y + c.y) / 2 };
      for (const [rot, flip] of copies()) {
        ctx.save();
        if (sym === 2) { if (flip === -1) { ctx.translate(W, 0); ctx.scale(-1, 1); } }
        else if (sym === 6) { ctx.translate(W / 2, H / 2); ctx.rotate(rot); ctx.scale(flip, 1); ctx.translate(-W / 2, -H / 2); }
        ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = w;
        if (tool === 'eraser') { ctx.globalCompositeOperation = 'destination-out'; ctx.strokeStyle = '#000'; }
        else { ctx.globalCompositeOperation = 'source-over'; ctx.strokeStyle = color; ctx.globalAlpha = tool === 'marker' ? .35 : 1; if (tool === 'neon') { ctx.shadowColor = color; ctx.shadowBlur = w * 2.2; } }
        ctx.beginPath(); ctx.moveTo(m1.x, m1.y); ctx.quadraticCurveTo(b.x, b.y, m2.x, m2.y); ctx.stroke();
        if (tool === 'neon') { ctx.shadowBlur = 0; ctx.strokeStyle = '#fff'; ctx.globalAlpha = .85; ctx.lineWidth = Math.max(1, w * .3); ctx.stroke(); }
        ctx.restore();
      }
    };
    let pts = null;
    fg.addEventListener('pointerdown', (e) => { e.preventDefault(); fg.setPointerCapture(e.pointerId); snap(); const p = pos(e); pts = [p, p, p]; stroke(p, p, p, (tool === 'marker' ? size * 2 : size) * p.p); changed = true; });
    fg.addEventListener('pointermove', (e) => {
      if (!pts) return;
      for (const ev of (e.getCoalescedEvents?.() || [e])) { const p = pos(ev); pts = [pts[1], pts[2], p]; stroke(pts[0], pts[1], pts[2], (tool === 'marker' ? size * 2 : size) * p.p); }
    });
    const up = () => { pts = null; }; fg.addEventListener('pointerup', up); fg.addEventListener('pointercancel', up);
    d.querySelector('#dundo').onclick = () => { const h = hist.pop(); if (h) ctx.putImageData(h, 0, 0); };
    d.querySelector('#dclear').onclick = () => { snap(); ctx.clearRect(0, 0, W, H); changed = true; };

    let done = false;
    const finish = (blob) => { if (done) return; done = true; d.close(); d.remove(); resolve(blob); };
    d.querySelector('#dcancel').onclick = () => { if (changed && !confirm('Закрыть без сохранения?')) return; finish(null); };
    d.addEventListener('cancel', (e) => { e.preventDefault(); d.querySelector('#dcancel').click(); });
    d.querySelector('#ddone').onclick = () => {
      const out = document.createElement('canvas'); out.width = W; out.height = H;
      const o = out.getContext('2d'); o.drawImage(bg, 0, 0); o.drawImage(fg, 0, 0);
      out.toBlob((b) => (b && b.size <= 5 * 1024 * 1024 ? finish(new File([b], 'cover.png', { type: 'image/png' })) : toast('Рисунок слишком большой')), 'image/png');
    };
  });
}

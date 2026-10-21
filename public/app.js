'use strict';
const app = document.getElementById('app');
let me = null;
let unread = 0, unreadMsgs = 0, pending = 0, feedScope = null, stream = null, streamTimer = null;
let lastBeat = 0, pollMsg = 0, pollNote = 0, pollHook = null, polling = false, pollTimer = null, pollLogged = false;
let view = 0; // номер текущего экрана: запоздавший ответ от уже закрытого экрана ничего не рисует
let io = null, msgHook = null, readHook = null, noteHook = null; // io — бесконечная прокрутка; хуки — живые события на открытом экране
const feedCache = {}; // последняя загруженная лента: при возврате на экран показываем сразу, а свежее подгружаем следом

// тема: тёмная по умолчанию, светлая — по выбору (хранится в браузере)
const getTheme = () => { try { return localStorage.getItem('kolo_theme') || 'system'; } catch { return 'system'; } };
const effTheme = () => { const t = getTheme(); return t === 'system' || !['dark', 'black', 'light'].includes(t) ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : t; };
const applyTheme = () => { const t = effTheme(); document.documentElement.dataset.theme = t; document.querySelector('meta[name=theme-color]')?.setAttribute('content', t === 'light' ? '#F4F5F8' : t === 'black' ? '#000000' : '#080C10'); };
applyTheme();
matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => { if (getTheme() === 'system') applyTheme(); });
function toggleTheme() { const t = effTheme() === 'light' ? 'dark' : 'light'; try { localStorage.setItem('kolo_theme', t); } catch {} applyTheme(); const b = document.getElementById('themebtn2'); if (b) b.lastChild.textContent = t === 'light' ? 'Тёмная тема' : 'Светлая тема'; }

// ---------- утилиты ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const linkify = (t) => esc(t)
  .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>')
  .replace(/(^|\s)#([\p{L}\d_]+)/gu, (m, sp, tag) => `${sp}<a href="#/tag/${encodeURIComponent(tag.toLowerCase())}">#${tag}</a>`)
  .replace(/(^|\s)@([A-Za-z0-9_]{3,20})/g, (m, sp, n) => `${sp}<a href="#/u/${n}">@${n}</a>`);
const hue = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
const rtf = new Intl.RelativeTimeFormat('ru', { numeric: 'auto', style: 'short' });
function ago(iso) {
  const sec = Math.round((new Date(iso) - Date.now()) / 1000), a = Math.abs(sec);
  if (a < 45) return 'сейчас';
  if (a < 3600) return rtf.format(Math.round(sec / 60), 'minute');
  if (a < 86400) return rtf.format(Math.round(sec / 3600), 'hour');
  if (a < 604800) return rtf.format(Math.round(sec / 86400), 'day');
  return new Date(iso).toLocaleDateString('ru', { day: 'numeric', month: 'short' });
}
function seenText(u) { // «в сети» / «был(а) в сети сегодня в 14:05»
  if (u.online) return 'в сети';
  if (!u.last_seen) return 'не в сети';
  const d = new Date(u.last_seen), now = new Date(), mins = Math.round((now - d) / 60000);
  const t = d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' }), same = (x, y) => x.toDateString() === y.toDateString();
  const verb = u.gender === 'f' ? 'была' : u.gender === 'm' ? 'был' : 'был(а)';
  const when = mins < 60 ? `${Math.max(mins, 1)} мин. назад` : same(d, now) ? `сегодня в ${t}` : same(d, new Date(now - 864e5)) ? `вчера в ${t}` : `${d.toLocaleDateString('ru', { day: 'numeric', month: 'long' })} в ${t}`;
  return `${verb} в сети ${when}`;
}
const clipImage = (e) => { const cd = e.clipboardData; if (!cd) return null; const f = [...(cd.files || [])].find((x) => x.type.startsWith('image/')); if (f) return f; for (const it of cd.items || []) if (it.kind === 'file' && it.type.startsWith('image/')) return it.getAsFile(); return null; };
const dropImage = (e) => [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith('image/') || /\.(gif|png|jpe?g|webp)$/i.test(x.name)) || null;
const ic = (d, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;
const I = {
  home: ic('<path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>'),
  search: ic('<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>'),
  user: ic('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/>'),
  userPlus: ic('<circle cx="10" cy="8" r="4"/><path d="M3 21c0-4.4 3.1-7 7-7s7 2.6 7 7M19 8v6M16 11h6"/>'),
  heart: ic('<path d="M12 21s-8-4.9-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 10c0 6.1-8 11-8 11z"/>'),
  comment: ic('<path d="M21 12a8 8 0 0 1-11.8 7L3 20.5l1.5-5.2A8 8 0 1 1 21 12z"/>'),
  trash: ic('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
  image: ic('<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="1.8"/><path d="M21 16l-5-5-9 9"/>'),
  out: ic('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>'),
  bell: ic('<path d="M6 9a6 6 0 0 1 12 0c0 6 2.5 8 2.5 8h-17S6 15 6 9zM10 21h4"/>'),
  bookmark: ic('<path d="M6 3h12v18l-6-4.5L6 21z"/>'),
  repost: ic('<path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/>'),
  mail: ic('<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 7l9 6 9-6"/>'),
  flame: ic('<path d="M12 22c4 0 7-2.7 7-6.5 0-3-2-5-3.5-6.5C15 7.5 15 6 14 3c-3 2-6 5-6 9.5 0-1-.8-2-1.5-2.5C5.500 11.500 5 13 5 15.500 5 19.300 8 22 12 22z"/>'),
  back: ic('<path d="M19 12H5M11 6l-6 6 6 6"/>', 'stroke-width="2.2"'),
  x: ic('<path d="M6 6l12 12M18 6L6 18"/>', 'stroke-width="2.5"'),
  plus: ic('<path d="M12 5v14M5 12h14"/>', 'stroke-width="2.6"'),
  send: ic('<path d="M22 2L11 13M22 2l-7 20-4-9-9-4z"/>'),
  pin: ic('<path d="M9 3h6l-1 6 3 3v2H7v-2l3-3zM12 14v7"/>'),
  more: ic('<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>'),
  link: ic('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
  reply: ic('<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 6 6v3"/>'),
  gear: ic('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  clip: ic('<path d="M21 11.5l-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l7.8-7.8"/>'),
  edit: ic('<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
  at: ic('<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>'),
  sun: ic('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  moon: ic('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'),
  check: ic('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 'stroke-width="2.4"'),
  checks: ic('<path d="M1.5 12.5l4.5 4.5L15.5 7M11 16.5l1.500 1.500L22 7"/>', 'stroke-width="2.2"'),
  lock: ic('<rect x="4" y="11" width="16" height="10" rx="3"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
  alert: ic('<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.01"/>'),
  compose: ic('<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
};
const LOGO = '<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="11" fill="none" stroke="var(--accent)" stroke-width="6"/></svg>';
const pl = (n, one, few, many) => { const a = Math.abs(n) % 100, b = a % 10; return a > 10 && a < 20 ? many : b === 1 ? one : b > 1 && b < 5 ? few : many; };
const timeOf = (iso) => new Date(iso).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
const dayDiff = (iso) => { const d = new Date(iso), t = new Date(); return Math.round((new Date(t.getFullYear(), t.getMonth(), t.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 864e5); };
function dayOf(iso) { const diff = dayDiff(iso); return diff === 0 ? 'Сегодня' : diff === 1 ? 'Вчера' : new Date(iso).toLocaleDateString('ru', { day: 'numeric', month: 'long' }); }
function convTime(iso) {
  const d = dayDiff(iso);
  return d === 0 ? timeOf(iso) : d === 1 ? 'Вчера' : d < 7 ? new Date(iso).toLocaleDateString('ru', { weekday: 'short' }) : new Date(iso).toLocaleDateString('ru', { day: 'numeric', month: 'short' });
}
let toastT;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2600);
}
const avatar = (u, cls = '') => `<span class="av ${cls}" style="--h:${hue(u.username)}">${u.avatar ? `<img src="${esc(u.avatar)}" alt="" decoding="async">` : `<span aria-hidden="true">${esc((u.name || u.username)[0].toUpperCase())}</span>`}</span>`;

async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  const tk = localStorage.getItem('kolo_token');
  if (tk) headers.Authorization = 'Bearer ' + tk;
  if (body && !(body instanceof FormData)) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
  let r;
  try { r = await fetch('/api' + path, { method, headers, body }); }
  catch { throw new Error('Нет соединения. Проверьте интернет'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401 && tk) { localStorage.removeItem('kolo_token'); me = null; location.hash = '#/login'; }
    throw new Error(data.error || 'Что-то пошло не так. Попробуйте ещё раз');
  }
  return data;
}

// Фото перед отправкой уменьшаем на устройстве: на телефоне снимок весит 5–10 МБ, а нужно ~300 КБ. Быстрее загрузка, нет лимита 5 МБ.
async function prepImage(file, max = 1600) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || (file.size < 250 * 1024)) return file;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    if (k === 1 && file.size < 1.2 * 1024 * 1024) return file;
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
    return blob && blob.size < file.size ? new File([blob], 'photo.jpg', { type: 'image/jpeg' }) : file;
  } catch { return file; }
}
async function pickedImage(file) { // проверка и подготовка выбранной картинки; null — отказ (уже показан тост)
  if (!file) return null;
  const type = file.type || (/\.gif$/i.test(file.name || '') ? 'image/gif' : ''); // некоторые телефоны не сообщают тип GIF
  if (!/^image\//.test(type)) { toast('Нужна картинка: JPG, PNG, WebP или GIF'); return null; }
  const f = await prepImage(file), gif = type === 'image/gif';
  if (f.size > (gif ? 15 : 5) * 1024 * 1024) { toast(gif ? 'GIF больше 15 МБ' : 'Файл больше 5 МБ'); return null; }
  return f;
}

async function copyText(t) {
  try { await navigator.clipboard.writeText(t); } catch { const e = document.createElement('textarea'); e.value = t; document.body.appendChild(e); e.select(); try { document.execCommand('copy'); } catch {} e.remove(); }
  toast('Скопировано');
}
const LIFE_L = { family: 'Семья и дети', career: 'Карьера и деньги', growth: 'Саморазвитие', creativity: 'Творчество', fun: 'Развлечения и отдых', travel: 'Путешествия', knowledge: 'Знания и опыт', health: 'Здоровье и спорт' };
const PEOPLE_L = { kindness: 'Доброта', humor: 'Чувство юмора', mind: 'Ум и креативность', honesty: 'Честность', courage: 'Смелость', beauty: 'Красота', loyalty: 'Верность' };
const REL_L = { searching: 'В активном поиске', single: 'Не в отношениях', dating: 'Встречается', inlove: 'Влюблён(а)', engaged: 'Помолвлен(а)', married: 'В браке', complicated: 'Всё сложно' };
const REL_PARTNER = ['dating', 'inlove', 'engaged', 'married', 'complicated'];
const relLabel = (r, g) => ({ single: g === 'm' ? 'Не женат' : g === 'f' ? 'Не замужем' : 'Не в отношениях', inlove: g === 'm' ? 'Влюблён' : g === 'f' ? 'Влюблена' : 'Влюблён(а)', engaged: g === 'm' ? 'Помолвлен' : g === 'f' ? 'Помолвлена' : 'Помолвлен(а)', married: g === 'm' ? 'Женат' : g === 'f' ? 'Замужем' : 'В браке' }[r] || REL_L[r] || '');

ctxHooks.post = (el) => {
  const id = el.dataset.id, txt = el.querySelector('.ptext')?.textContent, pinned = +me.pinned_post === +id;
  return [
    txt && { label: 'Копировать текст', fn: () => copyText(txt) },
    { label: 'Копировать ссылку', fn: () => copyText(location.origin + '/#/post/' + id) },
    { label: pinned ? 'Открепить из профиля' : 'Закрепить в профиле', icon: I.pin, fn: async () => { try { const r = await api(`/posts/${id}/pin`, { method: 'POST' }); me.pinned_post = r.pinned ? +id : null; toast(r.pinned ? 'Закреплено в вашем профиле' : 'Откреплено'); if (location.hash.startsWith('#/u/')) route(); } catch (err) { toast(err.message); } } },
    { label: 'В закладки', fn: () => el.querySelector('[data-bm]')?.click() },
    el.querySelector('.ph .del') && { label: 'Удалить', icon: I.trash, danger: true, fn: () => el.querySelector('.ph .del').click() },
  ];
};
async function loadMe() { me = await api('/me'); unread = me.unread || 0; unreadMsgs = me.unread_messages || 0; pollMsg = me.last_msg || 0; pollNote = me.last_note || 0; return me; }

// ---------- каркас: строится один раз, дальше меняется только содержимое ----------
function ensureShell() {
  if (document.getElementById('main')) return;
  const a = (k, h, label, icon, cls = '') => `<a data-k="${k}" href="${h}" class="${cls}"><b class="ni">${icon}</b><span>${label}</span></a>`;
  app.innerHTML = `<header class="topbar"><div class="topin">
      <a class="tlogo" href="#/">${LOGO}<span>Kolo</span></a>
      <form class="tsearch" id="tsearch" role="search">${I.search}<input name="q" type="search" placeholder="Поиск" aria-label="Поиск" autocomplete="off"></form>
      <a class="tuser" href="#/u/${esc(me.username)}" title="Моя страница">${avatar(me, 'xs')}<span>${esc(me.name || me.username)}</span></a></div></header>
    <div class="shell">
    <nav class="nav" aria-label="Основное меню">
      ${a('home', '#/', 'Лента', I.home)}${a('popular', '#/popular', 'Популярное', I.flame, 'dsk')}${a('search', '#/search', 'Поиск', I.search)}
      <a data-k="new" href="#/new" class="plus" aria-label="Новая запись">${I.plus}</a>
      <a data-k="msgs" href="#/messages"><b class="ni">${I.mail}</b><span>Сообщения</span><i class="badge" id="mbadge" hidden></i></a>
      ${a('bm', '#/bookmarks', 'Закладки', I.bookmark, 'dsk')}
      <a data-k="notes" href="#/notifications" class="dsk"><b class="ni">${I.bell}</b><span>Уведомления</span><i class="badge" id="badge" hidden></i></a>
      <a data-k="me" href="#/u/${esc(me.username)}"><b class="ni">${I.user}</b><span>Профиль</span></a>
      <div class="navfoot dsk"><a href="#/new">Новая запись</a><button type="button" id="themebtn2"><span hidden></span>${effTheme() === 'light' ? 'Тёмная тема' : 'Светлая тема'}</button><button type="button" id="logout">Выйти</button></div>
    </nav>
    <div class="col">
      <header class="head" id="head"></header>
      <main class="main" id="main"></main>
    </div>
    <aside class="side" id="side"></aside></div>`;
  document.getElementById('logout').onclick = logout;
  document.getElementById('themebtn2').onclick = toggleTheme;
  document.getElementById('tsearch').onsubmit = (e) => { e.preventDefault(); const q = e.target.q.value.trim(); if (q) { location.hash = '#/search/' + encodeURIComponent(q); e.target.q.blur(); } };
  renderSide();
}
function logout() {
  stopStream(); localStorage.removeItem('kolo_token'); me = null; unread = unreadMsgs = 0; document.title = 'Kolo';
  if (location.hash === '#/login') route(); else location.hash = '#/login';
}

// page({ key, title, back, right, mode }): подсветка меню, шапка; возвращает <main>
// mode: 'chat' — чат на весь экран; 'focus' — без нижней панели (создание поста, пост, комментарии)
function page(o) {
  ensureShell();
  document.body.dataset.mode = o.mode || '';
  document.querySelectorAll('.nav [data-k]').forEach((el) => {
    const on = el.dataset.k === o.key;
    el.classList.toggle('on', on);
    on ? el.setAttribute('aria-current', 'page') : el.removeAttribute('aria-current');
  });
  document.getElementById('head').innerHTML = `${o.back ? `<button class="icon hback" id="hback" aria-label="Назад">${I.back}</button>` : ''}
    <div class="ht">${o.title || ''}</div>
    <div class="hr">${o.right || ''}<a class="icon hbell" href="#/notifications" aria-label="Уведомления">${I.bell}<i class="badge" id="hbadge" hidden></i></a></div>`;
  const back = document.getElementById('hback');
  if (back) back.onclick = () => (history.length > 1 ? history.back() : (location.hash = o.backTo || '#/'));
  paintBadge();
  const main = document.getElementById('main');
  main.className = 'main' + (o.mode ? ' m-' + o.mode : '');
  return main;
}
const titleOf = (t) => `<h1>${t}</h1>`;
const logoTitle = `<a class="mlogo" href="#/">${LOGO}<span>Kolo</span></a><h1 class="dskt">Лента</h1>`;

// правая колонка (компьютер): поиск, кого читать, тренды. Данные кэшируем — переходы между экранами их не перезагружают
let sideData = null, sideAt = 0;
function sideHTML() {
  const s = sideData || { list: [], tags: [] };
  const sug = s.list.length ? `<section class="card sidebox"><h2>Рекомендуемые</h2>${s.list.map(sugHTML).join('')}</section>` : '';
  const tags = s.tags.length ? `<section class="card sidebox"><h2>Темы дня</h2>${s.tags.slice(0, 5).map((t) => `<a class="trend" href="#/tag/${encodeURIComponent(t.tag)}"><b>#${esc(t.tag)}</b><span>${t.n} ${pl(t.n, 'пост', 'поста', 'постов')}</span></a>`).join('')}<a class="trend more" href="#/popular">Показать ещё</a></section>` : '';
  return `${sug}${tags}`;
}
function renderSide() {
  const side = document.getElementById('side'); if (!side) return;
  side.innerHTML = sideHTML();
  if (sideData && Date.now() - sideAt < 60000) return;
  Promise.all([api('/suggestions'), api('/trending').catch(() => ({ tags: [] }))]).then(([list, tr]) => {
    sideData = { list, tags: tr.tags }; sideAt = Date.now(); renderSide();
  }).catch(() => {});
}
const sugHTML = (u) => `<div class="sug"><a href="#/u/${esc(u.username)}">${avatar(u, 'sm')}</a>
  <a class="who" href="#/u/${esc(u.username)}"><b>${esc(u.name || u.username)}</b><span>@${esc(u.username)}</span></a>
  <button class="btn sm line" data-follow="${esc(u.username)}">Читать</button></div>`;

// ---------- посты ----------
function postHTML(p) {
  const rp = p.reposted_by ? `<div class="rp muted">${I.repost}<span>${p.reposted_by === me.username ? 'Вы сделали репост' : `Репост от <a href="#/u/${esc(p.reposted_by)}">${esc(p.reposted_by_name || p.reposted_by)}</a>`}</span></div>` : '';
  return `<article class="card post" data-id="${p.id}" data-ctx="post">${rp}
    <header class="ph"><a class="pav" href="#/u/${esc(p.username)}" tabindex="-1" aria-hidden="true">${avatar(p)}</a>
      <div class="pmeta"><a class="pname" href="#/u/${esc(p.username)}">${nameHTML(p)}</a>
        <div class="psub"><span class="pun">@${esc(p.username)}</span><a class="ptime" href="#/post/${p.id}" title="${esc(new Date(p.created_at).toLocaleString('ru'))}">${ago(p.created_at)}</a></div></div>
      <button class="icon more" data-more aria-label="Ещё">${I.more}</button>
      ${p.username === me.username ? `<button class="icon del" data-del="${p.id}" aria-label="Удалить запись">${I.trash}</button>` : ''}</header>
    <div class="pbody">
      ${p.text ? `<p class="ptext">${linkify(p.text)}</p>` : ''}
      ${p.image ? `<img class="pimg" data-zoom src="${esc(p.image)}" alt="Изображение к записи" loading="lazy" decoding="async">` : ''}
    </div>
    <footer>
      <button class="act like ${p.liked ? 'on' : ''}" data-like="${p.id}" aria-pressed="${p.liked}" aria-label="Нравится">${I.heart}<span>${p.likes || ''}</span></button>
      <a class="act" href="#/post/${p.id}" aria-label="Комментарии">${I.comment}<span>${p.comments || ''}</span></a>
      <button class="act rep ${p.reposted ? 'on' : ''}" data-repost="${p.id}" aria-pressed="${!!p.reposted}" aria-label="Рассказать друзьям">${I.repost}<span>${p.reposts || ''}</span></button>
      <button class="act bm grow ${p.bookmarked ? 'on' : ''}" data-bm="${p.id}" aria-pressed="${!!p.bookmarked}" aria-label="В закладки">${I.bookmark}</button>
    </footer></article>`;
}
const skel = (n = 3) => Array.from({ length: n }, () => '<div class="card post skel" aria-hidden="true"><div class="ph"><span class="av"></span><div class="pmeta"><i class="l1"></i></div></div><div class="pbody"><i class="l2"></i><i class="l3"></i></div></div>').join('');
const feedList = (posts, emptyHTML) => posts.length ? posts.map(postHTML).join('') : emptyHTML;
const emptyBox = (title, text = '', extra = '') => `<div class="card empty"><b>${title}</b>${text}${extra}</div>`;
const errBox = (e) => emptyBox(esc(e.message), '', '<a class="btn" href="#/">В ленту</a>');

// Композер: общий для ленты и страницы «Новый пост». Возвращает функцию «Опубликовать».
function composerHTML(withSubmit = true) {
  return `<form class="card composer" id="composer">${avatar(me)}
    <div class="col">
      <textarea name="text" rows="2" maxlength="500" placeholder="Что у вас нового?" aria-label="Текст поста"></textarea>
      <div class="preview" id="preview" hidden><img alt="Предпросмотр"><button type="button" class="icon" id="unpick" aria-label="Убрать картинку">${I.x}</button></div>
      <div class="row">
        <label class="icon" title="Добавить фото" aria-label="Добавить фото" style="cursor:pointer">${I.image}<input type="file" accept="image/*" id="pick" hidden></label>
        <span class="grow"></span>
        <span class="count" id="count">0 / 500</span><i class="ring" id="ring" aria-hidden="true"></i>
        ${withSubmit ? '<button class="btn" type="submit">Опубликовать</button>' : ''}
      </div></div></form>`;
}
function bindComposer(onPost) {
  const f = document.getElementById('composer'), ta = f.text, pick = document.getElementById('pick'), prev = document.getElementById('preview');
  let file = null;
  ta.addEventListener('input', () => {
    ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px';
    const c = document.getElementById('count'); c.textContent = `${ta.value.length} / 500`; c.classList.toggle('over', ta.value.length > 480); c.classList.toggle('show', ta.value.length > 400); document.getElementById('ring')?.style.setProperty('--p', ta.value.length / 500);
  });
  const setFile = (x) => {
    file = x; prev.hidden = !x;
    if (x) prev.querySelector('img').src = URL.createObjectURL(x); else pick.value = '';
  };
  pick.onchange = async () => { const x = await pickedImage(pick.files[0]); if (x) setFile(x); else pick.value = ''; };
  ta.addEventListener('paste', async (e) => { const it = clipImage(e); if (it) { e.preventDefault(); const x = await pickedImage(it); if (x) setFile(x); } });
  document.getElementById('unpick').onclick = () => setFile(null);
  f.addEventListener('dragover', (e) => e.preventDefault());
  f.addEventListener('drop', async (e) => { const it = dropImage(e); if (!it) return; e.preventDefault(); const x = await pickedImage(it); if (x) setFile(x); });
  f.onsubmit = async (e) => {
    e.preventDefault();
    if (!ta.value.trim() && !file) return toast('Напишите текст или добавьте фото');
    const btns = document.querySelectorAll('[data-publish], #composer .btn'); btns.forEach((b) => (b.disabled = true));
    const fd = new FormData(); fd.append('text', ta.value);
    if (file) fd.append('image', file);
    try {
      const p = await api('/posts', { method: 'POST', body: fd });
      f.reset(); setFile(null); ta.style.height = 'auto'; document.getElementById('count').textContent = '0 / 500';
      onPost(p); toast('Опубликовано');
    } catch (err) { toast(err.message); }
    btns.forEach((b) => (b.disabled = false));
  };
  return () => f.requestSubmit();
}

// бесконечная прокрутка: когда «хвост» списка подъезжает к экрану, подгружаем следующую порцию.
// next(loaded, lastBatch) возвращает следующую порцию постов (по курсору cur или смещению)
function infinite(box, first, next) {
  if (!box.isConnected) return;
  io?.disconnect(); io = null;
  box.querySelector('.sentinel')?.remove();
  if (first.length < 20) return;
  let loaded = first.length, last = first, busy = false;
  const s = document.createElement('div'); s.className = 'sentinel'; s.textContent = 'Загрузка…'; box.appendChild(s);
  const load = async () => {
    if (busy) return; busy = true; s.textContent = 'Загрузка…';
    try {
      const batch = await next(loaded, last);
      s.insertAdjacentHTML('beforebegin', batch.map(postHTML).join(''));
      loaded += batch.length; last = batch;
      if (batch.length < 20) { observer.disconnect(); s.remove(); }
      else { observer.unobserve(s); observer.observe(s); } // если хвост всё ещё на экране — продолжаем
    } catch (e) {
      s.innerHTML = '<button class="btn line">Не удалось загрузить. Повторить</button>';
      s.firstChild.onclick = load;
    }
    busy = false;
  };
  const observer = new IntersectionObserver((en) => { if (en[0].isIntersecting) load(); }, { rootMargin: '700px' });
  observer.observe(s); io = observer;
}
const lastCur = (batch) => batch[batch.length - 1].cur;

// сегментированные вкладки-ссылки
const seg = (items, cur) => `<nav class="seg" role="tablist">${items.map(([k, h, t]) => `<a href="${h}" role="tab" class="${k === cur ? 'on' : ''}" aria-selected="${k === cur}">${t}</a>`).join('')}</nav>`;

// ---------- экраны ----------
function authView() {
  app.innerHTML = `<div class="authwrap"><div class="authglow"></div><form class="sheet authbox" id="auth">
    <div class="authlogo">${LOGO}<span>Kolo</span></div><h1>С возвращением</h1><p>Войдите, чтобы вернуться в свой круг.</p>
    <label class="field"><span>Имя пользователя</span><input name="username" required maxlength="20" autocomplete="username" autocapitalize="none" placeholder="например, anna"></label>
    <label class="field"><span>Пароль</span><span class="pw"><input name="password" type="password" required autocomplete="current-password" placeholder="Ваш пароль"><button type="button" class="link" id="pwshow">Показать</button></span></label>
    <p class="err" id="err" role="alert"></p>
    <button class="btn" type="submit">Войти</button>
    <div class="switch">Нет аккаунта? <a href="#/register">Создать</a></div>
    <div class="authfoot">Kolo — твой круг общения</div></form></div>`;
  document.getElementById('pwshow').onclick = (e) => { const i = document.querySelector('#auth [name=password]'), show = i.type === 'password'; i.type = show ? 'text' : 'password'; e.target.textContent = show ? 'Скрыть' : 'Показать'; };
  document.getElementById('auth').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const { token } = await api('/login', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      localStorage.setItem('kolo_token', token); await loadMe(); location.hash = '#/'; route();
    } catch (err) { document.getElementById('err').textContent = err.message; }
  };
}

// регистрация в три шага: 1 — логин и пароль (создаёт аккаунт), 2 — профиль, 3 — на кого подписаться.
// Пока онбординг не завершён, роутер возвращает человека на нужный шаг (флаг onboarded на сервере).
function wizardShell(step, inner) {
  const titles = ['Аккаунт', 'Профиль', 'Подписки'];
  app.innerHTML = `<div class="authwrap"><div class="authglow"></div><div class="sheet authbox wiz">
    <div class="authlogo">${LOGO}<span>Kolo</span></div><ol class="steps" aria-label="Шаги регистрации">${titles.map((t, i) => `<li class="${i + 1 < step ? 'done' : i + 1 === step ? 'cur' : ''}" ${i + 1 === step ? 'aria-current="step"' : ''}><i>${i + 1 < step ? '✓' : i + 1}</i><span>${t}</span></li>`).join('')}</ol>
    ${inner}</div></div>`;
}

function pwLevel(p) {
  const classes = [/[a-zа-яё]/, /[A-ZА-ЯЁ]/, /\d/, /[^A-Za-zА-Яа-яЁё\d]/].filter((r) => r.test(p)).length;
  if (p.length < 8) return 0;
  if (p.length >= 12 && classes >= 3) return 3;
  return (p.length >= 10 && classes >= 2) || classes >= 3 ? 2 : 1;
}

function registerView() {
  wizardShell(1, `<h1>Создайте аккаунт</h1><p>Сначала логин и пароль, остальное — на следующих шагах.</p>
    <form id="step1" novalidate>
      <label class="field"><span>Имя пользователя</span>
        <input name="username" required maxlength="20" autocomplete="username" autocapitalize="none" spellcheck="false" aria-describedby="uhint">
        <small class="hint" id="uhint">3–20 символов: латиница, цифры и _</small></label>
      <label class="field"><span>Пароль</span>
        <div class="pw"><input name="password" type="password" required autocomplete="new-password" aria-describedby="phint"><button type="button" class="link" id="showpw">Показать</button></div>
        <div class="meter" id="meter" data-level="0"><i></i><i></i><i></i></div>
        <small class="hint" id="phint">Не короче 8 символов</small></label>
      <p class="err" id="err" role="alert"></p>
      <button class="btn" type="submit">Далее</button></form>
    <div class="switch">Уже есть аккаунт? <a href="#/login">Войти</a></div>`);
  const f = document.getElementById('step1'), uhint = document.getElementById('uhint'), phint = document.getElementById('phint');
  const setHint = (el, cls, text) => { el.className = 'hint ' + cls; el.textContent = text; };
  let timer, seq = 0, nameOk = false;
  f.username.addEventListener('input', () => {
    clearTimeout(timer); nameOk = false;
    const v = f.username.value.trim();
    if (!v) return setHint(uhint, '', '3–20 символов: латиница, цифры и _');
    if (!/^[A-Za-z0-9_]{3,20}$/.test(v)) return setHint(uhint, 'bad', v.length < 3 ? 'Слишком короткое — минимум 3 символа' : 'Только латиница, цифры и _');
    setHint(uhint, '', 'Проверяем…');
    const my = ++seq;
    timer = setTimeout(async () => {
      try {
        const r = await api('/username-available?u=' + encodeURIComponent(v));
        if (my !== seq) return;
        nameOk = r.available; setHint(uhint, r.available ? 'ok' : 'bad', r.available ? 'Имя свободно' : 'Это имя уже занято');
      } catch { if (my === seq) setHint(uhint, '', ''); }
    }, 350);
  });
  const LV = ['Не короче 8 символов', 'Слабый: добавьте цифры, заглавные или длину', 'Нормальный', 'Надёжный'];
  f.password.addEventListener('input', () => {
    const l = pwLevel(f.password.value);
    document.getElementById('meter').dataset.level = f.password.value ? l : 0;
    setHint(phint, f.password.value && l ? (l === 1 ? 'bad' : 'ok') : '', f.password.value ? (l ? LV[l] : 'Слишком короткий: нужно минимум 8 символов') : LV[0]);
  });
  document.getElementById('showpw').onclick = (e) => {
    const show = f.password.type === 'password'; f.password.type = show ? 'text' : 'password'; e.target.textContent = show ? 'Скрыть' : 'Показать';
  };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const err = document.getElementById('err'), btn = f.querySelector('.btn'); err.textContent = '';
    const body = { username: f.username.value.trim(), password: f.password.value };
    if (!/^[A-Za-z0-9_]{3,20}$/.test(body.username)) return (err.textContent = 'Имя пользователя: 3–20 символов, латиница, цифры и _', f.username.focus());
    if (body.password.length < 8) return (err.textContent = 'Пароль должен быть не короче 8 символов', f.password.focus());
    btn.disabled = true;
    try {
      const { token } = await api('/register', { method: 'POST', body });
      localStorage.setItem('kolo_token', token); await loadMe(); location.hash = '#/welcome/2'; route();
    } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
  };
}

async function welcomeView(step) {
  const finish = async () => {
    try { await api('/me/onboarded', { method: 'POST' }); me.onboarded = true; location.hash = '#/'; route(); }
    catch (e) { toast(e.message); }
  };
  if (step === 2) {
    wizardShell(2, `<h1>Расскажите о себе</h1><p>Всё это можно изменить позже в профиле.</p>
      <form id="step2">
        <div class="avpick"><span id="avprev">${avatar(me, 'xl')}</span>
          <label class="btn line sm">Выбрать фото<input type="file" name="avatar" accept="image/jpeg,image/png,image/webp,image/gif" hidden></label></div>
        <label class="field"><span>Имя</span><input name="name" maxlength="40" autocomplete="name" placeholder="${esc(me.username)}" value="${esc(me.name === me.username ? '' : me.name)}"></label>
        <label class="field"><span>О себе <small class="muted" id="bcount">0 / 160</small></span><textarea name="bio" rows="3" maxlength="160" placeholder="Пара слов о себе"></textarea></label>
        <button class="btn" type="submit">Далее</button>
        <button class="btn line skip" type="button" id="skip">Пропустить</button></form>`);
    const f = document.getElementById('step2'), file = f.avatar;
    f.bio.addEventListener('input', () => { document.getElementById('bcount').textContent = `${f.bio.value.length} / 160`; });
    file.onchange = () => {
      const x = file.files[0]; if (!x) return;
      if (x.size > 5 * 1024 * 1024) { file.value = ''; return toast('Файл больше 5 МБ'); }
      document.querySelector('#avprev .av').innerHTML = `<img src="${URL.createObjectURL(x)}" alt="">`;
    };
    document.getElementById('skip').onclick = () => { location.hash = '#/welcome/3'; };
    f.onsubmit = async (e) => {
      e.preventDefault();
      const btn = f.querySelector('button[type=submit]'); btn.disabled = true;
      const fd = new FormData(f); if (!fd.get('avatar').size) fd.delete('avatar');
      try { me = await api('/me', { method: 'PUT', body: fd }); location.hash = '#/welcome/3'; }
      catch (err) { toast(err.message); btn.disabled = false; }
    };
    return;
  }
  wizardShell(3, `<h1>Кого читать?</h1><p>Посты тех, на кого вы подпишетесь, появятся в вашей ленте.</p>
    <div id="people" class="people"><div class="empty">Загрузка…</div></div>
    <button class="btn" id="done">Начать</button>`);
  document.getElementById('done').onclick = finish;
  try {
    const list = await api('/suggestions?limit=8');
    if (!document.getElementById('people')) return;
    document.getElementById('people').innerHTML = list.length ? list.map(sugHTML).join('')
      : '<div class="empty"><b>Пока некого предложить</b>Вы здесь одним из первых — люди появятся позже.</div>';
  } catch (e) { toast(e.message); }
}

async function feedView(scope) {
  const v = view;
  const main = page({ key: 'home', title: logoTitle });
  const empty = emptyBox(scope === 'all' ? 'Здесь пока тихо' : 'В подписках пусто', scope === 'all' ? 'Напишите первый пост.' : 'Подпишитесь на кого-нибудь — их посты появятся здесь.');
  const cached = feedCache[scope];
  main.innerHTML = `${composerHTML()}${seg([['all', '#/', 'Все'], ['following', '#/following', 'Подписки'], ['popular', '#/popular', 'Популярное']], scope)}
    <button class="banner" id="banner" hidden></button><div class="list" id="feed">${cached ? feedList(cached, empty) : skel(3)}</div>`;
  feedScope = scope; pending = 0;
  document.getElementById('banner').onclick = () => route();
  const feed = document.getElementById('feed');
  const q = (before) => api(`/feed?scope=${scope}${before ? '&before=' + before : ''}`);
  bindComposer((p) => { delete feedCache.all; delete feedCache.following; feed.querySelector('.empty')?.remove(); feed.insertAdjacentHTML('afterbegin', postHTML(p)); });
  const posts = await q().catch((e) => (toast(e.message), cached || []));
  if (v !== view) return;
  const sig = (l) => JSON.stringify((l || []).map((p) => [p.id, p.likes, p.comments, p.reposts, p.liked, p.reposted_by]));
  if (!cached || sig(cached) !== sig(posts)) feed.innerHTML = feedList(posts, empty);
  feedCache[scope] = posts;
  infinite(feed, posts, (n, last) => q(lastCur(last)));
}

function newPostView() {
  const main = page({ key: 'new', title: titleOf('Новый пост'), back: true, mode: 'focus', right: '<button class="btn sm" id="pubtop" data-publish>Опубликовать</button>' });
  main.innerHTML = composerHTML(false);
  const submit = bindComposer(() => { delete feedCache.all; delete feedCache.following; location.hash = '#/'; });
  document.getElementById('pubtop').onclick = submit;
  document.querySelector('#composer textarea').focus();
}

async function profileView(username) {
  const v = view, own = username.toLowerCase() === me.username.toLowerCase();
  const main = page({ key: own ? 'me' : '', title: titleOf(own ? 'Профиль' : '&nbsp;'), back: !own, mode: own ? 'prof' : '' });
  main.innerHTML = `<div class="card pcard"><div class="pcbar"><span class="av xl" style="--h:${hue(username)}"></span></div></div><div class="list">${skel(2)}</div>`;
  let data;
  try { data = await api('/users/' + encodeURIComponent(username)); }
  catch (e) { return void (v === view && (main.innerHTML = errBox(e))); }
  if (v !== view) return;
  const u = data.user, pinned = data.pinned, ph = data.photos || { count: 0, items: [] };
  if (u.restricted) {
    document.querySelector('#head .ht').innerHTML = titleOf(nameHTML(u));
    main.innerHTML = `<section class="card pcard"><div class="pcbar"><span class="pcav">${avatar(u, 'xl')}</span></div>
      <div class="pcinfo"><h2>${nameHTML(u)}</h2><div class="muted pcsub">@${esc(u.username)}</div></div>
      <div class="restr">${I.lock}<b>Страница скрыта</b><span class="muted">${u.rule === 'friends' ? 'Её видят только друзья — взаимные подписчики.' : 'Автор ограничил доступ к странице.'}</span></div>
      <div class="pcbar"><div class="pcbtns"><button class="btn ${u.isFollowing ? 'line' : ''}" data-follow="${esc(u.username)}" id="fbtn">${u.isFollowing ? 'Вы читаете' : 'Читать'}</button>${u.canDM ? `<a class="btn line" href="#/messages/${esc(u.username)}">Написать</a>` : ''}</div></div></section>`;
    return;
  }
  document.title = baseTitle = `${u.name || u.username} — Kolo`;
  if (!own) document.querySelector('#head .ht').innerHTML = titleOf(nameHTML(u));
  const st = (n, label, id = '') => `<div><b${id ? ` id="${id}"` : ''}>${n}</b><span>${label}</span></div>`;
  const cover = u.cover
    ? `<div class="pcover"><img src="${esc(u.cover)}" alt="Шапка профиля" data-zoom decoding="async">${own ? `<button type="button" class="btn sm line pcedit" id="drawcover">${I.edit}Рисовать</button>` : ''}</div>`
    : own ? `<button type="button" class="pcover cta" id="drawcover">${I.edit}<b>Нарисуйте свою шапку</b><span>Кисть, неон, симметрия — прямо здесь</span></button>` : '';
  const partner = !u.partner ? '' : u.partner.username
    ? `<a class="pchip" href="#/u/${esc(u.partner.username)}">${avatar(u.partner, 'xs')}<span>${esc(u.partner.name || u.partner.username)}</span></a>`
    : `<span class="pchip off" title="Этого человека нет в Kolo">@${esc(u.partner.name)}</span>`;
  const rows = [], add = (k, val) => val && rows.push(`<div><dt>${k}</dt><dd>${val}</dd></div>`);
  add('Семейное положение', u.relationship && `<span>${relLabel(u.relationship, u.gender)}</span>${partner}`);
  add('Сайт', u.website && `<a href="${esc(u.website)}" target="_blank" rel="noopener noreferrer nofollow">${esc(u.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''))}</a>`);
  add('Telegram', u.telegram && `<a href="https://t.me/${esc(u.telegram)}" target="_blank" rel="noopener noreferrer">@${esc(u.telegram)}</a>`);
  add('Главное в жизни', LIFE_L[u.life_main]);
  add('Главное в людях', PEOPLE_L[u.people_main]);
  const tags = (u.interests || '').split(',').filter(Boolean);
  add('Интересы', tags.length && tags.map((t) => `<a class="tagchip" href="#/search/${encodeURIComponent(t)}">#${esc(t)}</a>`).join(''));
  const photos = ph.count || own ? `<section class="card pphotos"><div class="pph-head"><a href="#/photos/${esc(u.username)}"><b>Фотографии</b> <span class="muted">${ph.count || ''}</span></a>${own ? '<button type="button" class="link" id="addphoto">Добавить фотографию</button>' : ''}</div>${ph.count ? `<div class="pph-grid">${ph.items.map((p) => `<img data-zoom src="${esc(p.image)}" alt="Фото" loading="lazy" decoding="async">`).join('')}</div>` : '<div class="pph-empty muted">Фотографии из ваших записей появятся здесь</div>'}</section>` : '';
  const list = pinned ? data.posts.filter((p) => p.id !== pinned.id) : data.posts;
  main.innerHTML = `<section class="card pcard">${cover}
    <div class="pcbar ${cover ? 'hascover' : ''}"><span class="pcav">${avatar(u, 'xl')}${u.online ? '<i class="live" title="в сети"></i>' : ''}</span>
      <div class="pcbtns">${own ? `<button class="btn line" id="edit">Редактировать</button><a class="btn line" href="#/settings">${I.gear}Настройки</a>` : `<button class="btn ${u.isFollowing ? 'line' : ''}" data-follow="${esc(u.username)}" id="fbtn">${u.isFollowing ? 'Вы читаете' : 'Читать'}</button>${u.canDM ? `<a class="btn line" href="#/messages/${esc(u.username)}">Написать</a>` : '<button class="btn line" disabled title="Автор ограничил личные сообщения">Сообщения закрыты</button>'}`}</div></div>
    <div class="pcinfo"><h2>${nameHTML(u)}</h2><div class="muted pcsub">@${esc(u.username)} · <span class="seen ${u.online ? 'on' : ''}">${seenText(u)}</span></div>
      ${u.bio ? `<p class="bio">${linkify(u.bio)}</p>` : ''}</div>
    ${rows.length ? `<details class="pdet"><summary><span class="pdo">Подробная информация</span><span class="pdc">Скрыть</span><i class="chev">›</i></summary><dl class="pfacts">${rows.join('')}</dl></details>` : ''}
    <div class="stats">${st(u.posts, pl(u.posts, 'запись', 'записи', 'записей'))}${st(u.followers, pl(u.followers, 'читатель', 'читателя', 'читателей'), 'fcount')}${st(u.following ?? '—', 'в подписках')}</div></section>
    ${photos}${own ? composerHTML() : ''}
    <div class="list" id="feed">${pinned ? `<div class="pinned"><div class="pinlab">${I.pin}<span>Закреплённая запись</span></div>${postHTML(pinned)}</div>` : ''}${feedList(list, pinned ? '' : emptyBox('Постов пока нет', own ? 'Опубликуйте первый — прямо здесь, на своей странице.' : ''))}</div>`;
  const feed = document.getElementById('feed');
  infinite(feed, data.posts, (n, last) => api(`/users/${encodeURIComponent(username)}?before=${lastCur(last)}`).then((d) => d.posts));
  if (own) {
    document.getElementById('edit').onclick = () => editDialog();
    document.getElementById('addphoto')?.addEventListener('click', () => document.getElementById('pick')?.click());
    bindComposer((p) => { delete feedCache.all; delete feedCache.following; feed.querySelector('.empty')?.remove(); const pin = feed.querySelector('.pinned'); pin ? pin.insertAdjacentHTML('afterend', postHTML(p)) : feed.insertAdjacentHTML('afterbegin', postHTML(p)); if (p.image) route(); });
    document.getElementById('drawcover')?.addEventListener('click', async () => {
      const f = await drawEditor(u.cover); if (!f) return;
      const fd = new FormData(); fd.append('name', me.name); fd.append('bio', me.bio); fd.append('cover', f);
      try { me = await api('/me', { method: 'PUT', body: fd }); toast('Шапка сохранена'); route(); } catch (err) { toast(err.message); }
    });
  }
}

// ---------- настройки ----------
const PV_OPTS = [['all', 'Все'], ['friends', 'Только друзья'], ['none', 'Никто']];
const THEMES = [['system', 'Как в системе'], ['dark', 'Тёмная'], ['black', 'Deep Black'], ['light', 'Светлая']];
const VBADGE = `<svg class="vb" viewBox="0 0 24 24" aria-label="Подтверждённый профиль" role="img"><title>Подтверждённый профиль</title><path fill="currentColor" d="M12 1.8l2.6 1.9 3.2-.1 1 3 2.6 1.9-1 3 1 3-2.6 1.9-1 3-3.2-.1L12 22.2l-2.6-1.9-3.2.1-1-3-2.6-1.9 1-3-1-3 2.6-1.9 1-3 3.2.1z"/><path fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M8 12.3l2.7 2.7L16.2 9.5"/></svg>`;
const nameHTML = (u) => esc(u.name || u.username) + (u.verified ? VBADGE : '');
const getFont = () => { try { return Math.min(130, Math.max(85, +localStorage.getItem('kolo_fs') || 100)); } catch { return 100; } };
const applyFont = () => document.documentElement.style.setProperty('--fs', getFont() / 100);
applyFont();

function askPassword({ title, text, ok, danger }) { // окно «введите пароль»; возвращает пароль или null
  return new Promise((resolve) => {
    const d = document.createElement('dialog'); d.className = 'sheetdlg';
    d.innerHTML = `<form method="dialog" id="pwf"><h2>${esc(title)}</h2><p class="muted pdlg">${esc(text)}</p>
      <div class="pdlgf"><label class="field"><span>Пароль</span><input name="password" type="password" autocomplete="current-password" required></label></div>
      <div class="actions"><button type="button" class="btn line" id="pwx">Отмена</button><button class="btn ${danger ? 'dng' : ''}" type="submit">${esc(ok)}</button></div></form>`;
    document.body.appendChild(d); d.showModal();
    let out = null;
    d.querySelector('#pwx').onclick = () => d.close();
    d.querySelector('#pwf').onsubmit = (e) => { e.preventDefault(); out = d.querySelector('input').value; d.close(); };
    d.addEventListener('close', () => { d.remove(); resolve(out); });
  });
}
const switchRow = (k, label, desc, on, dis = false) => `<label class="srow ${dis ? 'dis' : ''}"><span class="stxt"><b>${label}</b>${desc ? `<small>${desc}</small>` : ''}</span><span class="tgl"><input type="checkbox" data-k="${k}" ${on ? 'checked' : ''} ${dis ? 'disabled' : ''}><i></i></span></label>`;
const selectRow = (k, label, cur) => `<label class="srow"><span class="stxt"><b>${label}</b></span><select class="sel" data-k="${k}">${PV_OPTS.map(([v, t]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${t}</option>`).join('')}</select></label>`;

async function settingsView(sub) {
  const v = view, SUBS = { account: 'Аккаунт', privacy: 'Приватность', notifications: 'Уведомления', appearance: 'Внешний вид' };
  sub = SUBS[sub] ? sub : '';
  const main = page({ key: 'me', title: titleOf(sub ? SUBS[sub] : 'Настройки'), back: true, backTo: sub ? '#/settings' : '#/u/' + me.username });
  if (!sub) {
    const row = (href, icon, label, hint) => `<a href="${href}" class="mrow2">${icon}<span>${label}${hint ? `<small>${hint}</small>` : ''}</span><i class="chev">›</i></a>`;
    main.innerHTML = `<section class="card menu">${row('#/settings/account', I.user, 'Аккаунт', 'Имя, почта, пароль, верификация')}${row('#/settings/privacy', I.lock, 'Приватность', 'Кто видит страницу и пишет вам')}${row('#/settings/notifications', I.bell, 'Уведомления', 'Push, звуки, типы событий')}${row('#/settings/appearance', I.sun, 'Внешний вид', 'Тема, размер шрифта, кэш')}</section>
      <section class="card menu">${row('#/bookmarks', I.bookmark, 'Закладки')}<button type="button" class="mrow2 danger" id="logout3">${I.out}<span>Выйти</span></button></section>`;
    document.getElementById('logout3').onclick = logout;
    return;
  }
  if (sub === 'appearance') return appearanceSettings(main);
  main.innerHTML = '<div class="empty">Загрузка…</div>';
  let st;
  try { st = await api('/settings'); } catch (e) { return void (v === view && (main.innerHTML = errBox(e))); }
  if (v !== view) return;
  const save = async (patch, revert) => { try { Object.assign(me, patch); await api('/settings', { method: 'PUT', body: patch }); toast('Сохранено'); } catch (err) { toast(err.message); revert?.(); } };
  if (sub === 'privacy') {
    main.innerHTML = `<p class="muted shint">Друзья — это люди, на которых вы подписаны и которые подписаны на вас.</p>
      <section class="card sgroup">${selectRow('pv_profile', 'Кто видит мою страницу и подробную информацию', st.pv_profile)}${selectRow('pv_dm', 'Кто может писать мне личные сообщения', st.pv_dm)}${selectRow('pv_comments', 'Кто может комментировать мои посты', st.pv_comments)}${selectRow('pv_lists', 'Кто видит мои подписки', st.pv_lists)}</section>
      <section class="card sgroup">${switchRow('hidden', 'Скрытый профиль', 'Вас не найдут через поиск и не покажут в рекомендациях. Ссылку на страницу по-прежнему можно открыть', st.hidden)}</section>
      <p class="muted shint">Закладки видны только вам.</p>`;
    main.addEventListener('change', (e) => { const k = e.target.dataset.k; if (!k) return; const prev = st[k], val = e.target.type === 'checkbox' ? +e.target.checked : e.target.value; st[k] = val; save({ [k]: val }, () => { st[k] = prev; e.target.type === 'checkbox' ? (e.target.checked = !!prev) : (e.target.value = prev); }); });
    return;
  }
  if (sub === 'notifications') {
    const paint = () => {
      const off = !!st.n_off;
      main.innerHTML = `<div id="pushcard"></div>
        <section class="card sgroup">${switchRow('n_off', 'Не беспокоить', 'Выключает всплывающие уведомления и push. Лента событий останется в разделе «Уведомления»', off)}</section>
        <section class="card sgroup"><h3 class="sgh">Что присылать</h3>${switchRow('n_likes', 'Лайки и репосты', '', st.n_likes, off)}${switchRow('n_comments', 'Комментарии, ответы и упоминания', '@username', st.n_comments, off)}${switchRow('n_msgs', 'Новые сообщения', '', st.n_msgs, off)}${switchRow('n_follows', 'Новые подписчики', '', st.n_follows, off)}</section>
        <section class="card sgroup"><h3 class="sgh">Конфиденциальность</h3>${switchRow('n_preview', 'Показывать текст на экране блокировки', 'Если выключить, в push будет только «Новое сообщение» или тип события', st.n_preview, off)}</section>`;
      renderPushCard();
    };
    paint();
    main.addEventListener('change', (e) => { const k = e.target.dataset.k; if (!k) return; const prev = st[k]; st[k] = +e.target.checked; save({ [k]: st[k] }, () => { st[k] = prev; paint(); }); if (k === 'n_off') paint(); });
    return;
  }
  // аккаунт
  const a = st.account;
  const verifyBlock = a.verified ? `<div class="vstate ok">${VBADGE}<div><b>Профиль подтверждён</b><small class="muted">Рядом с вашим именем стоит синяя галочка</small></div></div>`
    : a.verify_req ? `<div class="vstate"><span class="pi">${I.check}</span><div><b>Заявка на рассмотрении</b><small class="muted">Отправлена ${esc(a.verify_req)}. Мы ответим галочкой на странице</small></div></div>`
    : `<p class="muted shint0">Галочка показывает, что страница принадлежит настоящему автору или проекту.</p>
       <label class="field"><span>Кто вы и чем известны <small class="muted" id="vcount">0 / 300</small></span><textarea id="vnote" rows="3" maxlength="300" placeholder="Ссылки на другие соцсети, сайт, публикации о вас"></textarea></label>
       <button class="btn" id="vsend">Подать заявку</button>`;
  main.innerHTML = `<section class="card sgroup"><h3 class="sgh">Профиль</h3>
      <div class="sbody"><label class="field"><span>Имя</span><input id="aname" maxlength="40" value="${esc(me.name)}"></label>
      <label class="field"><span>Никнейм</span><input id="auser" maxlength="20" value="${esc(me.username)}" autocapitalize="none" spellcheck="false"><small class="hint" id="uhint"></small></label>
      <button class="btn" id="asave">Сохранить</button></div></section>
    <section class="card sgroup"><h3 class="sgh">Почта и телефон</h3><div class="sbody">
      <label class="field"><span>Email</span><input id="aemail" type="email" maxlength="120" value="${esc(a.email)}" placeholder="name@example.com" autocomplete="email"></label>
      <button class="btn line" id="emsave">Сохранить почту</button>
      <label class="field sgap"><span>Телефон</span><input id="aphone" type="tel" maxlength="20" value="${esc(a.phone)}" placeholder="+79991234567" autocomplete="tel"><small class="hint">Номер сохраняется в профиле. Подтверждение по SMS пока не подключено</small></label>
      <button class="btn line" id="phsave">Сохранить номер</button></div></section>
    <section class="card sgroup"><h3 class="sgh">Пароль</h3><div class="sbody">
      <label class="field"><span>Текущий пароль</span><input id="pold" type="password" autocomplete="current-password"></label>
      <label class="field"><span>Новый пароль</span><input id="pnew" type="password" autocomplete="new-password"><div class="meter" id="pmeter" data-level="0"><i></i><i></i><i></i></div><small class="hint" id="pnhint">Не короче 8 символов</small></label>
      <button class="btn" id="pwsave">Сменить пароль</button></div></section>
    <section class="card sgroup"><h3 class="sgh">Верификация</h3><div class="sbody">${verifyBlock}</div></section>
    <section class="card sgroup"><h3 class="sgh">Деактивация и удаление</h3><div class="sbody">
      <p class="muted shint0"><b>Заморозить страницу</b> — вас не будет видно другим, пока вы снова не войдёте. Данные сохранятся.</p>
      <button class="btn line" id="deact">Заморозить страницу</button>
      <p class="muted shint0 sgap"><b>Удалить аккаунт</b> навсегда: посты, комментарии, сообщения, подписки и фото будут стёрты без возможности восстановления.</p>
      <button class="btn dng" id="delacc">Удалить аккаунт</button></div></section>`;
  const $ = (id) => document.getElementById(id), busyBtn = async (b, fn) => { b.disabled = true; try { await fn(); } catch (err) { toast(err.message); } b.disabled = false; };
  const uh = $('uhint'), ui = $('auser'); let ut, useq = 0, uok = true;
  const hint = (cls, t) => { uh.className = 'hint ' + cls; uh.textContent = t; };
  ui.addEventListener('input', () => {
    clearTimeout(ut); const val = ui.value.trim(); uok = false;
    if (val.toLowerCase() === me.username.toLowerCase()) { uok = true; return hint('', ''); }
    if (!/^[A-Za-z0-9_]{3,20}$/.test(val)) return hint('bad', val.length < 3 ? 'Минимум 3 символа' : 'Только латиница, цифры и _');
    hint('', 'Проверяем…'); const my = ++useq;
    ut = setTimeout(async () => { try { const r = await api('/username-available?u=' + encodeURIComponent(val)); if (my !== useq) return; uok = r.available; hint(r.available ? 'ok' : 'bad', r.available ? 'Никнейм свободен' : 'Этот никнейм уже занят'); } catch { if (my === useq) hint('', ''); } }, 350);
  });
  $('asave').onclick = (e) => busyBtn(e.target, async () => {
    const name = $('aname').value.trim(), val = ui.value.trim();
    if (val.toLowerCase() !== me.username.toLowerCase() || val !== me.username) {
      if (!uok && val.toLowerCase() !== me.username.toLowerCase()) return toast('Проверьте никнейм');
      if (val !== me.username) { await api('/me/username', { method: 'PUT', body: { username: val } }); me.username = val; }
    }
    if (name !== me.name) { const fd = new FormData(); fd.append('name', name); fd.append('bio', me.bio || ''); me = await api('/me', { method: 'PUT', body: fd }); }
    toast('Сохранено'); sideData = null; app.innerHTML = ''; route();
  });
  $('emsave').onclick = (e) => busyBtn(e.target, async () => {
    const pw = await askPassword({ title: 'Подтвердите пароль', text: 'Чтобы сменить почту, введите текущий пароль.', ok: 'Подтвердить' }); if (pw === null) return;
    await api('/me/email', { method: 'PUT', body: { email: $('aemail').value.trim(), password: pw } }); me.email = $('aemail').value.trim().toLowerCase(); toast('Почта сохранена');
  });
  $('phsave').onclick = (e) => busyBtn(e.target, async () => { const r = await api('/me/phone', { method: 'PUT', body: { phone: $('aphone').value } }); $('aphone').value = r.phone; toast('Номер сохранён'); });
  const pn = $('pnew'), pnh = $('pnhint'), LV = ['Не короче 8 символов', 'Слабый: добавьте цифры, заглавные или длину', 'Нормальный', 'Надёжный'];
  pn.addEventListener('input', () => { const l = pwLevel(pn.value); $('pmeter').dataset.level = pn.value ? l : 0; pnh.className = 'hint ' + (pn.value && l ? (l === 1 ? 'bad' : 'ok') : ''); pnh.textContent = pn.value ? (l ? LV[l] : 'Слишком короткий: минимум 8 символов') : LV[0]; });
  $('pwsave').onclick = (e) => busyBtn(e.target, async () => {
    if (!$('pold').value) return toast('Введите текущий пароль');
    await api('/me/password', { method: 'POST', body: { password: $('pold').value, new_password: pn.value } });
    $('pold').value = pn.value = ''; pn.dispatchEvent(new Event('input')); toast('Пароль изменён');
  });
  const vn = $('vnote');
  if (vn) { vn.addEventListener('input', () => { $('vcount').textContent = `${vn.value.length} / 300`; }); $('vsend').onclick = (e) => busyBtn(e.target, async () => { await api('/me/verify-request', { method: 'POST', body: { note: vn.value } }); toast('Заявка отправлена'); settingsView('account'); }); }
  $('deact').onclick = async () => {
    const pw = await askPassword({ title: 'Заморозить страницу?', text: 'Страница исчезнет для других, пока вы снова не войдёте в аккаунт.', ok: 'Заморозить' }); if (pw === null) return;
    try { await api('/me/deactivate', { method: 'POST', body: { password: pw } }); logout(); toast('Страница заморожена. Войдите, чтобы вернуть её'); } catch (err) { toast(err.message); }
  };
  $('delacc').onclick = async () => {
    const pw = await askPassword({ title: 'Удалить аккаунт навсегда?', text: 'Все ваши данные будут стёрты. Это нельзя отменить. Введите пароль для подтверждения.', ok: 'Удалить навсегда', danger: true }); if (pw === null) return;
    try { await api('/me', { method: 'DELETE', body: { password: pw } }); logout(); toast('Аккаунт удалён'); } catch (err) { toast(err.message); }
  };
}

function appearanceSettings(main) {
  const th = getTheme(), fs = getFont();
  main.innerHTML = `<section class="card sgroup"><h3 class="sgh">Тема оформления</h3><div class="sbody"><div class="pills thm">${THEMES.map(([k, t]) => `<label><input type="radio" name="theme" value="${k}" ${k === th ? 'checked' : ''}><span>${t}</span></label>`).join('')}</div>
      <small class="hint">Deep Black — чисто чёрный фон: экономит заряд на OLED-экранах.</small></div></section>
    <section class="card sgroup"><h3 class="sgh">Размер шрифта в ленте</h3><div class="sbody"><div class="fsrow"><small>А</small><input type="range" id="fsr" min="85" max="130" step="5" value="${fs}" aria-label="Размер шрифта"><big>А</big><b id="fsv">${fs}%</b></div>
      <div class="card fsprev"><p class="ptext">Так будет выглядеть текст записей, комментариев и сообщений.</p></div></div></section>
    <section class="card sgroup"><label class="srow"><span class="stxt"><b>Язык интерфейса</b><small>Английская версия появится позже</small></span><select class="sel" id="lang"><option value="ru" selected>Русский</option><option value="en" disabled>English (скоро)</option></select></label></section>
    <section class="card sgroup"><h3 class="sgh">Память устройства</h3><div class="sbody"><p class="muted shint0">Удалит сохранённые на телефоне картинки, ленту и оболочку приложения. Вход в аккаунт сохранится.</p><button class="btn line" id="clrc">Очистить кэш картинок и сообщений</button></div></section>`;
  main.addEventListener('change', (e) => { if (e.target.name !== 'theme') return; try { localStorage.setItem('kolo_theme', e.target.value); } catch {} applyTheme(); });
  const r = document.getElementById('fsr');
  r.addEventListener('input', () => { try { localStorage.setItem('kolo_fs', r.value); } catch {} applyFont(); document.getElementById('fsv').textContent = r.value + '%'; });
  document.getElementById('clrc').onclick = async (e) => {
    e.target.disabled = true;
    try {
      if ('caches' in window) for (const k of await caches.keys()) await caches.delete(k);
      for (const k of Object.keys(feedCache)) delete feedCache[k];
      sideData = null;
      toast('Кэш очищен');
    } catch { toast('Не удалось очистить кэш'); }
    e.target.disabled = false;
  };
}

// все фотографии пользователя (картинки из его записей)
async function photosView(username) {
  const v = view;
  const main = page({ key: '', title: titleOf('Фотографии'), back: true });
  main.innerHTML = '<div class="empty">Загрузка…</div>';
  let d;
  try { d = await api(`/users/${encodeURIComponent(username)}/photos`); }
  catch (e) { return void (v === view && (main.innerHTML = errBox(e))); }
  if (v !== view) return;
  document.querySelector('#head .ht').innerHTML = titleOf(`Фотографии · ${esc(d.user.name || d.user.username)}`);
  if (!d.photos.length) return void (main.innerHTML = emptyBox('Фотографий пока нет', 'Картинки из записей появятся здесь.'));
  const cells = (arr) => arr.map((p) => `<img data-zoom src="${esc(p.image)}" alt="Фото" loading="lazy" decoding="async">`).join('');
  main.innerHTML = `<div class="muted pgcount">${d.total} ${pl(d.total, 'фотография', 'фотографии', 'фотографий')}</div><div class="pgrid" id="pgrid">${cells(d.photos)}</div>`;
  let last = d.photos;
  const more = () => {
    if (last.length < 30) return;
    const b = document.createElement('button'); b.className = 'btn line pgmore'; b.textContent = 'Показать ещё'; main.appendChild(b);
    b.onclick = async () => {
      b.disabled = true;
      try { const n = await api(`/users/${encodeURIComponent(username)}/photos?before=${last[last.length - 1].id}`); document.getElementById('pgrid').insertAdjacentHTML('beforeend', cells(n.photos)); last = n.photos; b.remove(); more(); }
      catch (e) { toast(e.message); b.disabled = false; }
    };
  };
  more();
}

function editDialog() {
  const d = document.createElement('dialog'); d.className = 'edlg';
  const opts = (map, cur, empty = 'Не указано') => `<option value="">${empty}</option>${Object.entries(map).map(([k, v]) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${v}</option>`).join('')}`;
  const radio = (v, label) => `<label><input type="radio" name="gender" value="${v}" ${(me.gender || '') === v ? 'checked' : ''}><span>${label}</span></label>`;
  let coverFile = null, removeCover = false;
  d.innerHTML = `<form method="dialog" id="eform"><h2>Изменить профиль</h2>
    <section class="esec"><h3>Основное</h3>
      <label class="field"><span>Имя</span><input name="name" maxlength="40" value="${esc(me.name)}"></label>
      <label class="field"><span>О себе</span><textarea name="bio" rows="3" maxlength="160">${esc(me.bio)}</textarea></label>
      <label class="field"><span>Аватар</span><input name="avatar" type="file" accept="image/*"></label></section>
    <section class="esec"><h3>Шапка профиля</h3>
      <div class="ecover" id="ecover" ${me.cover ? `style="background-image:url('${esc(me.cover)}')"` : ''}><span>${me.cover ? '' : 'Шапки пока нет'}</span></div>
      <div class="erow"><button type="button" class="btn line sm" id="edraw">${I.edit}Нарисовать</button><button type="button" class="btn line sm" id="erm" ${me.cover ? '' : 'hidden'}>Убрать</button></div></section>
    <section class="esec"><h3>Личное</h3>
      <div class="field"><span>Пол <small class="muted">нужен для правильных окончаний в уведомлениях</small></span><div class="pills">${radio('m', 'Мужской')}${radio('f', 'Женский')}${radio('', 'Не указан')}</div></div>
      <label class="field"><span>Семейное положение</span><select name="relationship">${opts(REL_L, me.relationship || '')}</select></label>
      <label class="field" id="partnerf" ${REL_PARTNER.includes(me.relationship) ? '' : 'hidden'}><span>Партнёр <small class="muted">имя пользователя, необязательно</small></span><input name="partner" maxlength="20" placeholder="@username" value="${esc(me.partner || '')}" autocapitalize="none"><small class="hint" id="phint"></small></label></section>
    <section class="esec"><h3>Контакты</h3>
      <label class="field"><span>Сайт</span><input name="website" maxlength="100" placeholder="example.com" value="${esc(me.website || '')}" inputmode="url" autocapitalize="none"></label>
      <label class="field"><span>Telegram</span><input name="telegram" maxlength="60" placeholder="@username" value="${esc(me.telegram || '')}" autocapitalize="none"></label></section>
    <section class="esec"><h3>Жизненная позиция</h3>
      <label class="field"><span>Главное в жизни</span><select name="life_main">${opts(LIFE_L, me.life_main || '')}</select></label>
      <label class="field"><span>Главное в людях</span><select name="people_main">${opts(PEOPLE_L, me.people_main || '')}</select></label>
      <label class="field"><span>Интересы <small class="muted">через запятую, до 8</small></span><input name="interests" maxlength="120" placeholder="design, coding, anime" value="${esc((me.interests || '').split(',').filter(Boolean).join(', '))}" autocapitalize="none"></label></section>
    <div class="actions sticky"><button type="button" class="btn line" id="cancel">Отмена</button><button class="btn" type="submit">Сохранить</button></div></form>`;
  document.body.appendChild(d); d.showModal();
  d.querySelector('#cancel').onclick = () => d.close();
  d.addEventListener('close', () => d.remove());
  const rel = d.querySelector('[name=relationship]'), pf = d.querySelector('#partnerf');
  const pin = d.querySelector('[name=partner]'), phint = d.querySelector('#phint'); let ptimer;
  pin.addEventListener('input', () => {
    clearTimeout(ptimer); const q = pin.value.trim().replace(/^@/, ''); phint.textContent = ''; phint.className = 'hint';
    if (!q) return;
    ptimer = setTimeout(async () => { try { const r = await api('/search?q=' + encodeURIComponent(q)); const f = r.users.find((x) => x.username.toLowerCase() === q.toLowerCase()); if (pin.value.trim().replace(/^@/, '') !== q) return; phint.className = 'hint ' + (f ? 'ok' : 'bad'); phint.textContent = f ? `Найден: ${f.name || f.username}. В профиле будет ссылка` : 'Такого пользователя в Kolo нет. Покажем просто как текст'; } catch {} }, 400);
  });
  rel.onchange = () => { pf.hidden = !REL_PARTNER.includes(rel.value); };
  const ec = d.querySelector('#ecover'), rm = d.querySelector('#erm');
  d.querySelector('#edraw').onclick = async () => {
    const f = await drawEditor(coverFile ? URL.createObjectURL(coverFile) : (removeCover ? null : me.cover));
    if (!f) return; coverFile = f; removeCover = false; ec.style.backgroundImage = `url('${URL.createObjectURL(f)}')`; ec.firstChild.textContent = ''; rm.hidden = false;
  };
  rm.onclick = () => { coverFile = null; removeCover = true; ec.style.backgroundImage = ''; ec.firstChild.textContent = 'Шапки пока нет'; rm.hidden = true; };
  d.querySelector('#eform').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target), file = fd.get('avatar');
    fd.delete('avatar');
    if (file && file.size) { const f = await pickedImage(file); if (!f) return; fd.append('avatar', f); }
    if (coverFile) fd.append('cover', coverFile); else if (removeCover) fd.append('remove_cover', '1');
    try { me = await api('/me', { method: 'PUT', body: fd }); d.close(); toast('Профиль сохранён'); sideData = null; app.innerHTML = ''; route(); }
    catch (err) { toast(err.message); }
  };
}

async function postView(id) {
  const v = view;
  const main = page({ key: '', title: titleOf('Пост'), back: true, mode: 'focus' });
  main.innerHTML = `<div class="list">${skel(1)}</div>`;
  let data;
  try { data = await api('/posts/' + id); }
  catch (e) { return void (v === view && (main.innerHTML = errBox(e))); }
  if (v !== view) return;
  const replies = {};
  data.comments.forEach((c) => { if (c.parent_id) (replies[c.parent_id] ||= []).push(c); });
  const cHTML = (c, isReply) => `<div class="comment ${isReply ? 'reply' : ''}" data-ctx="comment" data-root="${c.parent_id || c.id}" data-who="${esc(c.username)}"><a href="#/u/${esc(c.username)}">${avatar(c, 'sm')}</a><div class="pbody"><header>
    <a class="pname" href="#/u/${esc(c.username)}">${esc(c.name || c.username)}</a><span class="muted ptime">${ago(c.created_at)}</span>
    <button class="link" data-reply="${c.parent_id || c.id}" data-who="${esc(c.username)}">Ответить</button></header>
    ${c.text ? `<p class="ptext">${linkify(c.text)}</p>` : ''}${c.image ? `<img class="cimg" data-zoom src="${esc(c.image)}" alt="Изображение в комментарии" loading="lazy" decoding="async">` : ''}</div></div>`;
  const threadHTML = (c) => `<div class="thread" data-root="${c.id}">${cHTML(c)}${(replies[c.id] || []).map((r) => cHTML(r, true)).join('')}</div>`;
  const roots = data.comments.filter((c) => !c.parent_id);
  main.innerHTML = `<div class="list">${postHTML(data.post)}</div>
    <section class="card comments" id="comments">${roots.map(threadHTML).join('') || '<div class="nocom muted">Комментариев пока нет. Напишите первый</div>'}</section>
    ${data.can_comment === false ? `<div class="cform nocomm muted">${I.lock}<span>Автор ограничил комментарии к этому посту</span></div>` : ''}
    <form class="cform" id="cform" ${data.can_comment === false ? 'hidden' : ''}>
      <div class="chip" id="rchip" hidden><span></span><button type="button" class="icon" id="rcancel" aria-label="Отменить ответ">${I.x}</button></div>
      <div class="mpreview" id="cprev" hidden><img alt="Выбранная картинка"><button type="button" class="icon" id="crm" aria-label="Убрать картинку">${I.x}</button></div>
      <div class="crow"><label class="icon attach" title="Картинка или GIF" aria-label="Прикрепить картинку или GIF">${I.image}<input type="file" accept="image/*" id="cfile" hidden></label>
        <input name="text" maxlength="300" placeholder="Написать комментарий…" aria-label="Комментарий" autocomplete="off">
        <button class="send" type="submit" aria-label="Отправить">${I.send}</button></div></form>`;
  const f = document.getElementById('cform'), chip = document.getElementById('rchip');
  let replyTo = null, cfile = null;
  const cprev = document.getElementById('cprev'), cin = document.getElementById('cfile');
  const setCFile = (x) => { cfile = x; cprev.hidden = !x; if (x) cprev.querySelector('img').src = URL.createObjectURL(x); else cin.value = ''; };
  cin.onchange = async () => { const x = await pickedImage(cin.files[0]); if (x) setCFile(x); else cin.value = ''; };
  document.getElementById('crm').onclick = () => setCFile(null);
  const takeC = async (raw) => { const x = await pickedImage(raw); if (x) setCFile(x); };
  f.text.addEventListener('paste', (e) => { const it = clipImage(e); if (it) { e.preventDefault(); takeC(it); } });
  f.addEventListener('dragover', (e) => e.preventDefault());
  f.addEventListener('drop', (e) => { const it = dropImage(e); if (it) { e.preventDefault(); takeC(it); } });
  const setReply = (rootId, who) => {
    replyTo = rootId; chip.hidden = !rootId;
    if (rootId) { chip.querySelector('span').textContent = 'Ответ для @' + who; f.text.value = '@' + who + ' '; f.text.focus(); }
  };
  document.getElementById('comments').onclick = (e) => { const b = e.target.closest('[data-reply]'); if (b) setReply(+b.dataset.reply, b.dataset.who); };
  const cbox = document.getElementById('comments');
  ctxHooks.comment = (el) => [
    { label: 'Ответить', icon: I.reply, fn: () => setReply(+el.dataset.root, el.dataset.who) },
    el.querySelector('.ptext') && { label: 'Копировать текст', fn: () => copyText(el.querySelector('.ptext').textContent) },
  ];
  swipeReply(cbox, '.comment', (el) => setReply(+el.dataset.root, el.dataset.who));
  document.getElementById('rcancel').onclick = () => { setReply(null); f.text.value = ''; };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const btn = f.querySelector('.send'); btn.disabled = true;
    try {
      if (!f.text.value.trim() && !cfile) { btn.disabled = false; return toast('Напишите текст или добавьте картинку'); }
      const fd = new FormData(); fd.append('text', f.text.value); if (replyTo) fd.append('parent_id', replyTo); if (cfile) fd.append('image', cfile);
      const c = await api(`/posts/${id}/comments`, { method: 'POST', body: fd });
      const box = document.getElementById('comments'); box.querySelector('.nocom')?.remove();
      if (c.parent_id) box.querySelector(`.thread[data-root="${c.parent_id}"]`)?.insertAdjacentHTML('beforeend', cHTML(c, true));
      else box.insertAdjacentHTML('beforeend', threadHTML(c));
      f.reset(); setReply(null); setCFile(null);
      const cnt = main.querySelector('.post [href^="#/post/"].act span'); if (cnt) cnt.textContent = (+cnt.textContent || 0) + 1;
    } catch (err) { toast(err.message); }
    btn.disabled = false;
  };
}

async function searchView(q) {
  const v = view;
  const main = page({ key: 'search', title: titleOf('Поиск') });
  main.innerHTML = `<form class="card search" id="sform" role="search">${I.search}<input name="q" type="search" placeholder="Люди, слова, #теги" aria-label="Поиск" value="${esc(q)}" autocomplete="off" enterkeyhint="search"></form><div id="results"></div>`;
  const box = document.getElementById('results'), input = document.querySelector('#sform input');
  let seq = 0, timer;
  const userRow = (u) => `<a class="sug" href="#/u/${esc(u.username)}">${avatar(u, 'sm')}<span class="who"><b>${esc(u.name || u.username)}</b><span>@${esc(u.username)}</span></span></a>`;
  const home = async () => {
    box.innerHTML = '<div class="list">' + skel(1) + '</div>';
    try {
      const [tr, sug] = await Promise.all([api('/trending'), api('/suggestions?limit=6')]);
      if (v !== view || input.value.trim()) return;
      box.innerHTML = `${tr.tags.length ? `<section class="card sidebox"><h2>Сейчас обсуждают</h2><div class="chips">${tr.tags.map((t) => `<a class="tagchip" href="#/tag/${encodeURIComponent(t.tag)}">#${esc(t.tag)}<small>${t.n}</small></a>`).join('')}</div></section>` : ''}
        ${sug.length ? `<section class="card sidebox"><h2>Кого читать</h2>${sug.map(sugHTML).join('')}</section>` : ''}
        <a class="card menu-link" href="#/popular">${I.flame}<span>Популярные посты</span></a>`;
    } catch { box.innerHTML = ''; }
  };
  const run = async (text) => {
    const my = ++seq;
    if (/^#[\p{L}\d_]+$/u.test(text)) return void (location.hash = '#/tag/' + encodeURIComponent(text.slice(1).toLowerCase()));
    if (!text) return home();
    try {
      const r = await api('/search?q=' + encodeURIComponent(text));
      if (my !== seq || v !== view) return;
      box.innerHTML = !r.users.length && !r.posts.length ? emptyBox('Ничего не нашли', 'Попробуйте другое слово.')
        : `${r.users.length ? `<section class="card sidebox"><h2>Люди</h2>${r.users.map(userRow).join('')}</section>` : ''}
           ${r.posts.length ? `<div class="list" style="margin-top:12px">${r.posts.map(postHTML).join('')}</div>` : ''}`;
    } catch (e) { toast(e.message); }
  };
  document.getElementById('sform').onsubmit = (e) => { e.preventDefault(); clearTimeout(timer); history.replaceState(null, '', '#/search/' + encodeURIComponent(input.value.trim())); run(input.value.trim()); };
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { history.replaceState(null, '', '#/search/' + encodeURIComponent(input.value.trim())); run(input.value.trim()); }, 300); });
  run(q.trim());
  if (!q && matchMedia('(pointer: fine)').matches) input.focus();
}

// ---------- популярное, теги, закладки ----------
async function popularView(range) {
  const v = view; range = range === 'all' ? 'all' : 'week';
  const main = page({ key: 'popular', title: titleOf('Популярное') });
  main.innerHTML = `${seg([['week', '#/popular', 'За неделю'], ['all', '#/popular/all', 'За всё время']], range)}<div class="list" id="feed">${skel(3)}</div>`;
  let posts, tags;
  try { [posts, tags] = await Promise.all([api(`/popular?range=${range}`), api('/trending').then((r) => r.tags)]); }
  catch (e) { return void (v === view && (main.innerHTML = errBox(e))); }
  if (v !== view) return;
  main.innerHTML = `${seg([['week', '#/popular', 'За неделю'], ['all', '#/popular/all', 'За всё время']], range)}
    ${tags.length ? `<section class="card sidebox"><h2>Сейчас обсуждают</h2><div class="chips">${tags.map((t) => `<a class="tagchip" href="#/tag/${encodeURIComponent(t.tag)}">#${esc(t.tag)}<small>${t.n}</small></a>`).join('')}</div></section>` : ''}
    <div class="list" id="feed">${feedList(posts, emptyBox('Пока нечего показать', 'Здесь появятся посты, которые лайкают, комментируют и репостят.'))}</div>`;
  infinite(document.getElementById('feed'), posts, (n) => api(`/popular?range=${range}&offset=${n}`));
}

async function tagView(tag) {
  const v = view;
  const main = page({ key: 'search', title: titleOf('#' + esc(tag)), back: true });
  main.innerHTML = `<div class="list">${skel(2)}</div>`;
  let d;
  try { d = await api('/tags/' + encodeURIComponent(tag)); } catch (e) { return void (v === view && (main.innerHTML = errBox(e))); }
  if (v !== view) return;
  document.title = baseTitle = `#${d.tag} — Kolo`;
  main.innerHTML = `<div class="card thead"><h2>#${esc(d.tag)}</h2><div class="muted">${d.total} ${pl(d.total, 'пост', 'поста', 'постов')}</div></div>
    <div class="list" id="feed">${feedList(d.posts, emptyBox('С этим тегом пока нет постов', `Напишите первый: добавьте #${esc(d.tag)} в текст.`))}</div>`;
  infinite(document.getElementById('feed'), d.posts, (n, last) => api(`/tags/${encodeURIComponent(d.tag)}?before=${lastCur(last)}`).then((r) => r.posts));
}

async function bookmarksView() {
  const v = view;
  const main = page({ key: 'bm', title: titleOf('Закладки'), back: true, backTo: '#/' });
  main.innerHTML = `<div class="list" id="feed">${skel(2)}</div>`;
  const feed = document.getElementById('feed');
  const posts = await api('/bookmarks').catch((e) => (toast(e.message), []));
  if (v !== view) return;
  feed.innerHTML = feedList(posts, emptyBox('Закладок пока нет', 'Нажмите на флажок под постом, чтобы сохранить его на потом.'));
  infinite(feed, posts, (n, last) => api('/bookmarks?before=' + lastCur(last)));
}

// ---------- личные сообщения ----------
const lastText = (c) => (c.image && !c.text ? '📷 Фото' : c.image ? '📷 ' + c.text : c.text);
const convHTML = (c) => `<a class="conv ${c.unread ? 'unread' : ''}" href="#/messages/${esc(c.username)}" data-q="${esc((c.name + ' ' + c.username).toLowerCase())}">${avatar(c)}
  <div class="who"><div class="top"><b>${esc(c.name || c.username)}</b><span class="muted">${convTime(c.created_at)}</span></div>
  <div class="snip muted">${c.mine ? '<span class="you">Вы:</span> ' : ''}${esc(lastText(c))}</div></div>${c.unread ? `<i class="badge static">${c.unread > 9 ? '9+' : c.unread}</i>` : ''}</a>`;

function newChatDialog() {
  const d = document.createElement('dialog'); d.className = 'sheetdlg';
  d.innerHTML = `<h2>Новое сообщение</h2><form class="search inner" id="ncs">${I.search}<input name="q" type="search" placeholder="Найти человека" aria-label="Найти человека" autocomplete="off"></form><div class="people" id="ncp"><div class="empty">Загрузка…</div></div>
    <div class="actions"><button type="button" class="btn line" id="ncx">Закрыть</button></div>`;
  document.body.appendChild(d); d.showModal();
  d.querySelector('#ncx').onclick = () => d.close();
  d.addEventListener('close', () => d.remove());
  const box = d.querySelector('#ncp'), input = d.querySelector('input');
  const show = (list) => { box.innerHTML = list.length ? list.filter((u) => u.username !== me.username).map((u) => `<a class="sug" href="#/messages/${esc(u.username)}">${avatar(u, 'sm')}<span class="who"><b>${esc(u.name || u.username)}</b><span>@${esc(u.username)}</span></span></a>`).join('') : '<div class="empty">Никого не нашли</div>'; };
  box.addEventListener('click', (e) => e.target.closest('a') && d.close());
  const load = async (q) => { try { show(q ? (await api('/search?q=' + encodeURIComponent(q))).users : await api('/suggestions?limit=8')); } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; } };
  let t; input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => load(input.value.trim()), 250); });
  d.querySelector('#ncs').onsubmit = (e) => e.preventDefault();
  load('');
}

async function messagesView() {
  const v = view;
  const main = page({ key: 'msgs', title: titleOf('Сообщения'), right: `<button class="icon" id="newchat" aria-label="Новое сообщение">${I.compose}</button>` });
  main.innerHTML = `<form class="card search" id="cfilter" role="search">${I.search}<input type="search" placeholder="Поиск по диалогам" aria-label="Поиск по диалогам" autocomplete="off"></form>
    <section class="card convs" id="convs">${'<div class="conv skel"><span class="av"></span><div class="who"><i class="l1"></i><i class="l2"></i></div></div>'.repeat(4)}</section>`;
  document.getElementById('newchat').onclick = newChatDialog;
  const filter = document.querySelector('#cfilter input');
  document.getElementById('cfilter').onsubmit = (e) => e.preventDefault();
  const apply = () => {
    const q = filter.value.trim().toLowerCase(); let shown = 0;
    document.querySelectorAll('#convs .conv').forEach((el) => { const ok = !q || (el.dataset.q || '').includes(q); el.hidden = !ok; shown += ok; });
    document.getElementById('nomatch')?.remove();
    if (q && !shown) document.getElementById('convs').insertAdjacentHTML('beforeend', '<div class="empty" id="nomatch">Ничего не нашли</div>');
  };
  filter.addEventListener('input', apply);
  const load = async () => {
    const box = document.getElementById('convs'); if (!box) return;
    try {
      const list = await api('/conversations');
      if (v !== view) return;
      box.innerHTML = list.length ? list.map(convHTML).join('') : '<div class="empty"><b>Сообщений пока нет</b>Нажмите на значок сверху и выберите, кому написать.</div>';
      apply();
    } catch (e) { toast(e.message); }
  };
  await load();
  if (v !== view) return;
  msgHook = () => { load(); return false; }; // список обновляется, а счётчик и тост — как обычно
}

let chatCleanup = null;
async function threadView(username) {
  const v = view;
  const main = page({ key: 'msgs', mode: 'chat', back: true, backTo: '#/messages', title: '<div class="chat-who"><span class="av sm"></span></div>' });
  main.innerHTML = '<div class="chat"><div class="msgs" id="msgs"><div class="empty">Загрузка…</div></div></div>';
  let data;
  try { data = await api('/messages/' + encodeURIComponent(username)); }
  catch (e) { return void (v === view && (main.innerHTML = `<div class="card empty"><b>${esc(e.message)}</b><a class="btn" href="#/messages">К сообщениям</a></div>`)); }
  if (v !== view) return;
  const peer = data.user; let list = data.messages, more = data.more, busy = false, olderIo = null, lastDay = '', stick = true;
  document.title = baseTitle = `${peer.name || peer.username} — Kolo`;
  document.querySelector('#head .ht').innerHTML = `<a class="chat-who" href="#/u/${esc(peer.username)}">${avatar(peer, 'sm')}<div class="cwt"><b>${esc(peer.name || peer.username)}</b><small class="muted seen ${peer.online ? 'on' : ''}" id="seen">${seenText(peer)}</small></div></a>`;
  const seenTimer = setInterval(async () => { try { const p = await api('/presence/' + encodeURIComponent(peer.username)); const el = document.getElementById('seen'); if (el) { el.textContent = seenText(p); el.classList.toggle('on', p.online); } } catch {} }, 45000);
  api('/me').then((m) => { unreadMsgs = m.unread_messages || 0; paintBadge(); }).catch(() => {}); // диалог открыт — входящие прочитаны

  main.innerHTML = `<div class="chat" id="chat">
    <div class="msgs" id="msgs" aria-live="polite"></div>
    <form class="mform" id="mform">
      <div class="mreply" id="mreply" hidden><div><b></b><span></span></div><button type="button" class="icon" id="mrx" aria-label="Отменить ответ">${I.x}</button></div>
      <div class="mpreview" id="mprev" hidden><img alt="Выбранное фото"><button type="button" class="icon" id="mrm" aria-label="Убрать фото">${I.x}</button></div>
      <div class="mrow">
        <label class="icon attach" aria-label="Прикрепить фото" title="Прикрепить фото">${I.clip}<input type="file" accept="image/*" id="mfile" hidden></label>
        <textarea name="text" rows="1" maxlength="2000" placeholder="Сообщение…" aria-label="Сообщение" enterkeyhint="send"></textarea>
        <button class="send" type="submit" aria-label="Отправить" disabled>${I.send}</button>
      </div></form></div>`;
  const box = document.getElementById('msgs'), f = document.getElementById('mform'), ta = f.text, sendBtn = f.querySelector('.send'), prev = document.getElementById('mprev'), fileIn = document.getElementById('mfile');

  const tick = (m) => m.mine ? `<i class="tick ${m.is_read ? 'read' : ''}" aria-label="${m.is_read ? 'Прочитано' : 'Отправлено'}">${m.is_read ? I.checks : I.check}</i>` : '';
  const quote = (r) => r ? `<div class="mquote" data-q="${r.id}"><b>${r.mine ? 'Вы' : esc(peer.name || peer.username)}</b><span>${esc((r.text || '').slice(0, 90)) || 'Фото'}</span></div>` : '';
  const msgHTML = (m, st = '') => `<div class="msg ${m.mine ? 'mine' : ''} ${st}" data-id="${m.id || ''}" data-t="${m.created_at || ''}" data-ctx="msg">
    ${quote(m.reply)}${m.image ? `<img class="mimg" data-zoom src="${esc(m.image)}" alt="Фото" decoding="async">` : ''}${m.text ? `<p>${linkify(m.text)}</p>` : ''}
    <span class="mmeta">${timeOf(m.created_at)}${tick(m)}</span></div>`;
  const dayHTML = (m) => { const d = dayOf(m.created_at); if (d === lastDay) return ''; lastDay = d; return `<div class="day">${d}</div>`; };
  const regroup = () => { // подряд идущие сообщения одного автора (до 5 минут): плотнее, время только у последнего
    const ms = [...box.querySelectorAll('.msg')];
    ms.forEach((el, i) => {
      const p = ms[i - 1], n = ms[i + 1], same = (x, y) => x && y && x.classList.contains('mine') === y.classList.contains('mine') && Math.abs(new Date(y.dataset.t) - new Date(x.dataset.t)) < 3e5 && x.nextElementSibling === y;
      el.classList.toggle('cont', !!same(p, el)); el.classList.toggle('nometa', !!same(el, n));
    });
  };
  const nearBottom = () => box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  const toBottom = () => { box.scrollTop = box.scrollHeight; };
  box.addEventListener('scroll', () => { stick = nearBottom(); }, { passive: true });
  box.addEventListener('load', (e) => { if (stick && e.target.classList?.contains('mimg')) toBottom(); }, true); // картинка догрузилась и сдвинула ленту

  const render = (mode) => {
    const prevH = box.scrollHeight, prevTop = box.scrollTop; lastDay = '';
    let out = more ? '<div class="older" id="older">Загрузка…</div>' : '';
    for (const m of list) out += dayHTML(m) + msgHTML(m);
    box.innerHTML = out || '<div class="empty"><b>Начните разговор</b>Напишите первое сообщение или отправьте фото.</div>';
    regroup();
    if (mode === 'bottom') toBottom(); else box.scrollTop = prevTop + (box.scrollHeight - prevH);
    olderIo?.disconnect(); olderIo = null;
    const older = document.getElementById('older');
    if (older) { olderIo = new IntersectionObserver((en) => { if (en[0].isIntersecting) loadOlder(); }, { root: box }); olderIo.observe(older); }
  };
  const append = (m, st = '') => { // новое сообщение добавляем в конец, не перерисовывая весь диалог
    box.querySelector('.empty')?.remove();
    box.insertAdjacentHTML('beforeend', dayHTML(m) + msgHTML(m, st));
    regroup();
    return box.lastElementChild;
  };
  const loadOlder = async () => {
    if (busy || !more || !list.length) return; busy = true;
    try {
      const d = await api(`/messages/${encodeURIComponent(username)}?before=${list[0].id}`);
      list = d.messages.concat(list); more = d.more; render('keep');
    } catch (e) { toast(e.message); }
    busy = false;
  };
  render('bottom');

  msgHook = (m) => {
    if (m.username.toLowerCase() !== peer.username.toLowerCase()) return false;
    if (box.querySelector(`[data-id="${m.id}"]`)) return true; // уже есть (пришло и по потоку, и по опросу)
    const was = nearBottom();
    const msg = { id: m.id, text: m.text, image: m.image, reply: m.reply || null, created_at: m.created_at, mine: false, is_read: 1 };
    list.push(msg); append(msg); if (was) toBottom();
    api(`/messages/${encodeURIComponent(peer.username)}/read`, { method: 'POST' }).catch(() => {});
    return true;
  };
  const markRead = () => box.querySelectorAll('.msg.mine .tick:not(.read)').forEach((t) => { t.classList.add('read'); t.innerHTML = I.checks; });
  readHook = (uname) => { if (uname.toLowerCase() === peer.username.toLowerCase()) markRead(); };
  pollHook = async () => { // запасной режим: подтягиваем новое и «прочитано» без потока событий
    const d = await api('/messages/' + encodeURIComponent(peer.username));
    const was = nearBottom(); let added = false;
    for (const m of d.messages) {
      if (box.querySelector(`[data-id="${m.id}"]`)) continue;
      if (list.some((x) => x.id === m.id)) continue;
      list.push(m); append(m); added = true;
    }
    if (d.messages.some((m) => m.mine && m.is_read)) markRead();
    if (added && was) toBottom();
  };

  // ---- ответ, меню, свайп ----
  let replyTo = null;
  const rbar = document.getElementById('mreply');
  const setReply = (m) => {
    replyTo = m ? { id: m.id, text: m.text, image: m.image, mine: m.mine } : null; rbar.hidden = !m;
    if (m) { rbar.querySelector('b').textContent = m.mine ? 'Вы' : (peer.name || peer.username); rbar.querySelector('span').textContent = m.text ? m.text.slice(0, 90) : 'Фото'; ta.focus(); }
  };
  const msgOf = (el) => list.find((x) => String(x.id) === el.dataset.id);
  const replyTo_ = (el) => { const m = msgOf(el); if (!m) return toast('Сообщение ещё отправляется'); setReply(m); };
  document.getElementById('mrx').onclick = () => setReply(null);
  ctxHooks.msg = (el) => { const m = msgOf(el); if (!m) return []; return [
    { label: 'Ответить', icon: I.reply, fn: () => setReply(m) },
    m.text && { label: 'Копировать', fn: () => copyText(m.text) },
    m.mine && { label: 'Удалить', icon: I.trash, danger: true, fn: async () => { try { await api('/messages/' + m.id, { method: 'DELETE' }); list = list.filter((x) => x !== m); el.remove(); regroup(); } catch (err) { toast(err.message); } } },
  ]; };
  swipeReply(box, '.msg', replyTo_);
  box.addEventListener('click', (e) => { const q = e.target.closest('[data-q]'); if (!q) return; const t = box.querySelector(`.msg[data-id="${q.dataset.q}"]`); if (t) { t.scrollIntoView({ block: 'center', behavior: 'smooth' }); t.classList.add('flash'); setTimeout(() => t.classList.remove('flash'), 1200); } });

  // ---- ввод: текст + фото ----
  let file = null;
  const updateSend = () => { sendBtn.disabled = !ta.value.trim() && !file; };
  const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 130) + 'px'; };
  const setFile = (x) => {
    file = x; prev.hidden = !x;
    if (x) prev.querySelector('img').src = URL.createObjectURL(x); else fileIn.value = '';
    updateSend();
  };
  const take = async (raw) => { const x = await pickedImage(raw); if (x) { setFile(x); ta.focus(); } else fileIn.value = ''; };
  fileIn.onchange = () => take(fileIn.files[0]);
  document.getElementById('mrm').onclick = () => setFile(null);
  ta.addEventListener('input', () => { grow(); updateSend(); });
  ta.addEventListener('paste', (e) => { const it = clipImage(e); if (it) { e.preventDefault(); take(it); } });
  const chat = document.getElementById('chat');
  chat.addEventListener('dragover', (e) => e.preventDefault());
  chat.addEventListener('drop', (e) => { const it = [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith('image/')); if (it) { e.preventDefault(); take(it); } });
  // Enter отправляет на компьютере; на телефоне Enter — перенос строки, отправка по кнопке
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer: fine)').matches) { e.preventDefault(); f.requestSubmit(); } });

  f.onsubmit = (e) => {
    e.preventDefault();
    const text = ta.value.trim(), img = file;
    if (!text && !img) return;
    const rep = replyTo, tmp = { id: 0, text, image: img ? URL.createObjectURL(img) : null, reply: rep, created_at: new Date().toISOString(), mine: true, is_read: 0 };
    ta.value = ''; grow(); setFile(null); setReply(null); ta.focus();
    const el = append(tmp, 'sending'); toBottom(); stick = true;
    const go = async () => { // сообщение появляется сразу, а уходит в фоне; при ошибке его можно нажать и отправить снова
      el.classList.remove('failed'); el.classList.add('sending');
      const fd = new FormData(); fd.append('text', text); if (img) fd.append('image', img); if (rep) fd.append('reply_to', rep.id);
      try {
        const m = await api('/messages/' + encodeURIComponent(peer.username), { method: 'POST', body: fd });
        list.push(m); el.dataset.id = m.id; el.classList.remove('sending');
      } catch (err) { el.classList.remove('sending'); el.classList.add('failed'); toast(err.message); }
    };
    el.addEventListener('click', () => el.classList.contains('failed') && go());
    go();
  };
  if (matchMedia('(pointer: fine)').matches) ta.focus();

  // клавиатура на телефоне: подгоняем высоту чата под видимую область, чтобы поле ввода не пряталось
  const vv = window.visualViewport;
  const fit = () => {
    const root = document.documentElement.style;
    root.setProperty('--vh', (vv ? vv.height : innerHeight) + 'px'); root.setProperty('--vt', (vv ? vv.offsetTop : 0) + 'px');
    if (stick) toBottom();
  };
  if (vv) { vv.addEventListener('resize', fit); vv.addEventListener('scroll', fit); }
  fit();
  chatCleanup = () => {
    if (vv) { vv.removeEventListener('resize', fit); vv.removeEventListener('scroll', fit); }
    document.documentElement.style.removeProperty('--vh'); document.documentElement.style.removeProperty('--vt');
    olderIo?.disconnect(); clearInterval(seenTimer);
  };
}

// ---------- уведомления ----------
const NOTE = { like: 'ставит лайк вашему посту', comment: 'комментирует ваш пост', reply: 'отвечает на ваш комментарий', follow: 'читает вас', mention: 'упоминает вас', repost: 'делает репост вашего поста' };
const NICON = { like: ['heart', 'like'], repost: ['repost', 'rep'], comment: ['comment', 'com'], reply: ['comment', 'com'], mention: ['at', 'men'], follow: ['userPlus', 'fol'] };
const NFILTER = { mentions: ['mention', 'reply', 'comment'], likes: ['like', 'repost'], follows: ['follow'] };
const NTABS = [['all', '#/notifications', 'Все'], ['mentions', '#/notifications/mentions', 'Ответы'], ['likes', '#/notifications/likes', 'Лайки'], ['follows', '#/notifications/follows', 'Подписки']];
function noteHTML(n) {
  const [icon, cls] = NICON[n.type] || ['bell', 'men'];
  const snip = n.text || n.post_text;
  return `<a class="note ${n.is_read ? '' : 'new'}" href="${n.type === 'follow' ? '#/u/' + esc(n.username) : '#/post/' + n.post_id}">
    <span class="nav-av">${avatar(n, '')}<i class="ntype ${cls}">${I[icon]}</i></span>
    <div class="nb"><div class="nt"><b>${esc(n.name || n.username)}</b> ${NOTE[n.type] || ''}</div>${snip ? `<p class="snip muted">${esc(snip)}</p>` : ''}<span class="muted ntime">${ago(n.created_at)}</span></div>
    ${n.post_image ? `<img class="nthumb" src="${esc(n.post_image)}" alt="" loading="lazy" decoding="async">` : ''}${n.is_read ? '' : '<i class="dot" aria-label="Новое"></i>'}</a>`;
}

// push: подписка браузера. Работает на https (и localhost); на iPhone — только у сайта, добавленного на экран «Домой»
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
const b64uToBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
async function swReg() { if (!('serviceWorker' in navigator) || !isSecureContext) return null; return Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(() => r(null), 3000))]); }
async function pushState() {
  const reg = await swReg();
  if (!reg || !('PushManager' in window) || !('Notification' in window)) return isIOS && !standalone ? 'ios' : 'none';
  if (Notification.permission === 'denied') return 'denied';
  return Notification.permission === 'granted' && (await reg.pushManager.getSubscription()) ? 'on' : 'off';
}
async function enablePush() {
  const reg = await swReg(); if (!reg) throw new Error('Уведомления недоступны в этом браузере');
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('Разрешите уведомления в настройках браузера');
  const { key } = await api('/push/key'), want = b64uToBytes(key);
  let sub = await reg.pushManager.getSubscription();
  if (sub && sub.options?.applicationServerKey && new Uint8Array(sub.options.applicationServerKey).join() !== want.join()) { await sub.unsubscribe(); sub = null; }
  sub = sub || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: want });
  await api('/push/subscribe', { method: 'POST', body: sub.toJSON() });
}
async function disablePush() {
  const reg = await swReg(), sub = reg && await reg.pushManager.getSubscription();
  if (sub) { await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {}); await sub.unsubscribe(); }
}
let pushSynced = false;
async function syncPush() { // при входе привязываем подписку устройства к текущему аккаунту
  if (pushSynced) return; pushSynced = true;
  try { if ((await pushState()) === 'on') { const sub = await (await swReg()).pushManager.getSubscription(); await api('/push/subscribe', { method: 'POST', body: sub.toJSON() }); } } catch {}
}
async function renderPushCard() {
  const box = document.getElementById('pushcard'); if (!box) return;
  const st = await pushState(); if (!document.getElementById('pushcard')) return;
  const card = (html) => (box.innerHTML = `<div class="card pushcard">${html}</div>`);
  if (st === 'off') {
    card(`<span class="pi">${I.bell}</span><div><b>Включить уведомления</b><p class="muted">Сообщения, ответы и лайки — даже когда Kolo закрыт.</p></div><button class="btn sm" id="pushon">Включить</button>`);
    document.getElementById('pushon').onclick = async (e) => { e.target.disabled = true; try { await enablePush(); toast('Уведомления включены'); } catch (err) { toast(err.message); } renderPushCard(); };
  } else if (st === 'on') {
    card(`<span class="pi ok">${I.check}</span><div><b>Уведомления включены</b><p class="muted">На этом устройстве.</p></div><button class="btn sm line" id="pushoff">Выключить</button>`);
    document.getElementById('pushoff').onclick = async () => { await disablePush(); renderPushCard(); };
  } else if (st === 'denied') card(`<span class="pi">${I.alert}</span><div><b>Уведомления заблокированы</b><p class="muted">Разрешите их для этого сайта в настройках браузера.</p></div>`);
  else if (st === 'ios') card(`<span class="pi">${I.bell}</span><div><b>Уведомления на iPhone</b><p class="muted">Нажмите «Поделиться» → «На экран Домой», затем откройте Kolo с экрана и включите уведомления здесь.</p></div>`);
  else box.innerHTML = '';
}

async function notificationsView(tab) {
  tab = NFILTER[tab] ? tab : 'all';
  const v = view;
  const main = page({ key: 'notes', title: titleOf('Уведомления') });
  main.innerHTML = `<div id="pushcard"></div>${seg(NTABS, tab)}<section class="card nlist" id="notes">${'<div class="note skel"><span class="av sm"></span><div class="nb"><i class="l1"></i><i class="l2"></i></div></div>'.repeat(4)}</section>`;
  renderPushCard();
  const box = document.getElementById('notes');
  const empty = '<div class="empty"><b>Пока ничего нового</b>Лайки, ответы и подписки появятся здесь.</div>';
  const url = (before) => `/notifications?type=${tab}${before ? '&before=' + before : ''}`;
  let r;
  try { r = await api(url()); } catch (e) { return void (v === view && (box.innerHTML = `<div class="empty">${esc(e.message)}</div>`)); }
  if (v !== view) return;
  box.innerHTML = r.items.length ? r.items.map(noteHTML).join('') : empty;
  const addMore = (res, items) => {
    box.querySelector('.sentinel')?.remove(); io?.disconnect(); io = null;
    if (!res.more) return;
    const s = document.createElement('div'); s.className = 'sentinel'; s.textContent = 'Загрузка…'; box.appendChild(s);
    let busy = false, last = items[items.length - 1].id;
    const load = async () => {
      if (busy) return; busy = true;
      try { const nx = await api(url(last)); s.insertAdjacentHTML('beforebegin', nx.items.map(noteHTML).join('')); last = nx.items.length ? nx.items[nx.items.length - 1].id : last; if (!nx.more) { ob.disconnect(); s.remove(); } else { ob.unobserve(s); ob.observe(s); } }
      catch { s.innerHTML = '<button class="btn line">Повторить</button>'; s.firstChild.onclick = load; }
      busy = false;
    };
    const ob = new IntersectionObserver((en) => { if (en[0].isIntersecting) load(); }, { rootMargin: '500px' }); ob.observe(s); io = ob;
  };
  if (r.items.length) addMore(r, r.items);
  noteHook = (n) => { // пришло новое уведомление, пока экран открыт
    if (NFILTER[tab] && !NFILTER[tab].includes(n.type)) return false;
    box.querySelector('.empty')?.remove();
    box.insertAdjacentHTML('afterbegin', noteHTML(n));
    api('/notifications/read', { method: 'POST' }).catch(() => {});
    return true;
  };
  if (unread) { try { await api('/notifications/read', { method: 'POST' }); unread = 0; paintBadge(); } catch {} }
}

// ---------- действия (делегирование) ----------
function zoom(src) {
  const d = document.createElement('div'); d.className = 'lb';
  d.innerHTML = `<img src="${esc(src)}" alt=""><button class="icon" aria-label="Закрыть">${I.x}</button>`;
  const close = () => { d.remove(); removeEventListener('keydown', key); };
  const key = (e) => e.key === 'Escape' && close();
  d.onclick = close; addEventListener('keydown', key); document.body.appendChild(d);
}
document.addEventListener('click', async (e) => {
  const z = e.target.closest('img[data-zoom]');
  if (z) return zoom(z.src);
  const more = e.target.closest('[data-more]');
  if (more) { const r = more.getBoundingClientRect(); return void ctxFor(more, r.right - 200, r.bottom + 4); }
  const navA = e.target.closest('.nav a[href], .mlogo');
  if (navA) { // повторное нажатие на текущий раздел: наверх и обновить
    const h = navA.getAttribute('href');
    if (h === (location.hash || '#/')) { e.preventDefault(); delete feedCache.all; delete feedCache.following; route(); }
    return;
  }
  const repB = e.target.closest('[data-repost]'), bmB = e.target.closest('[data-bm]'), likeB = e.target.closest('[data-like]'), delB = e.target.closest('[data-del]'), folB = e.target.closest('[data-follow]');
  const busy = (b) => b.dataset.busy === '1';
  try {
    if (likeB) { // лайк, репост и закладка меняются на экране сразу, а на сервер уходят в фоне; при ошибке откатываются
      if (busy(likeB)) return; likeB.dataset.busy = '1';
      const span = likeB.querySelector('span'), n = +span.textContent || 0, on = !likeB.classList.contains('on');
      const set = (o, c) => { likeB.classList.toggle('on', o); likeB.setAttribute('aria-pressed', o); span.textContent = c > 0 ? c : ''; };
      set(on, n + (on ? 1 : -1));
      try { const r = await api(`/posts/${likeB.dataset.like}/like`, { method: 'POST' }); set(r.liked, r.likes); } catch (err) { set(!on, n); throw err; } finally { likeB.dataset.busy = ''; }
    } else if (repB) {
      if (busy(repB)) return; repB.dataset.busy = '1';
      const span = repB.querySelector('span'), n = +span.textContent || 0, on = !repB.classList.contains('on');
      const set = (o, c) => { repB.classList.toggle('on', o); repB.setAttribute('aria-pressed', o); span.textContent = c > 0 ? c : ''; };
      set(on, n + (on ? 1 : -1));
      try { const r = await api(`/posts/${repB.dataset.repost}/repost`, { method: 'POST' }); set(r.reposted, r.reposts); delete feedCache.all; delete feedCache.following; toast(r.reposted ? 'Репост опубликован' : 'Репост отменён'); } catch (err) { set(!on, n); throw err; } finally { repB.dataset.busy = ''; }
    } else if (bmB) {
      if (busy(bmB)) return; bmB.dataset.busy = '1';
      const on = !bmB.classList.contains('on'), set = (o) => { bmB.classList.toggle('on', o); bmB.setAttribute('aria-pressed', o); };
      set(on);
      try { const r = await api(`/posts/${bmB.dataset.bm}/bookmark`, { method: 'POST' }); set(r.bookmarked); toast(r.bookmarked ? 'Сохранено в закладки' : 'Убрано из закладок'); } catch (err) { set(!on); throw err; } finally { bmB.dataset.busy = ''; }
    } else if (delB) {
      if (!confirm('Удалить этот пост?')) return;
      await api('/posts/' + delB.dataset.del, { method: 'DELETE' });
      delete feedCache.all; delete feedCache.following;
      delB.closest('.post').remove(); toast('Пост удалён');
      if (location.hash.startsWith('#/post/')) location.hash = '#/';
    } else if (folB) {
      folB.disabled = true;
      const r = await api(`/users/${encodeURIComponent(folB.dataset.follow)}/follow`, { method: 'POST' });
      delete feedCache.following; sideData = null;
      if (folB.id === 'fbtn') {
        folB.textContent = r.isFollowing ? 'Вы читаете' : 'Читать'; folB.classList.toggle('line', r.isFollowing);
        const fc = document.getElementById('fcount'); if (fc) fc.textContent = r.followers;
      } else { folB.textContent = r.isFollowing ? 'Вы читаете' : 'Читать'; folB.classList.toggle('line', !r.isFollowing); }
      folB.disabled = false;
    }
  } catch (err) { toast(err.message); [folB].forEach((b) => b && (b.disabled = false)); }
});

// ---------- realtime и уведомления ----------
let baseTitle = 'Kolo';
function paintBadge() {
  for (const [id, n] of [['badge', unread], ['hbadge', unread], ['mbadge', unreadMsgs]]) {
    const b = document.getElementById(id);
    if (b) { b.hidden = !n; b.textContent = n > 9 ? '9+' : n; }
  }
  const total = unread + unreadMsgs;
  document.title = (total ? `(${total > 99 ? '99+' : total}) ` : '') + baseTitle;
}
function stopStream(retry) {
  if (stream) { stream.close(); stream = null; }
  clearTimeout(streamTimer); streamTimer = null;
  if (retry && me) streamTimer = setTimeout(() => { streamTimer = null; connectStream(); }, 4000);
}
function onNotification(n) {
  pollNote = Math.max(pollNote, n.id || 0);
  if (noteHook && noteHook(n)) return; // экран уведомлений открыт — запись уже добавлена
  unread++; paintBadge(); toast(`${n.name || n.username} ${NOTE[n.type] || ''}`);
}
function onMessage(m) {
  pollMsg = Math.max(pollMsg, m.id || 0);
  if (msgHook && msgHook(m)) return; // диалог с этим человеком открыт — сообщение уже на экране
  unreadMsgs++; paintBadge(); toast(`${m.name || m.username}: ${(m.text || '📷 Фото').slice(0, 50)}`);
}

// Запасной режим: если пульс от потока событий не приходит (прокси режет или копит SSE), раз в 5 секунд спрашиваем сервер сами.
async function poll() {
  if (!me || polling || document.hidden) return;
  const alive = lastBeat && Date.now() - lastBeat < 45000;
  if (alive) return;
  if (stream && lastBeat) stopStream(true); // поток тихо умер — переподключаемся
  polling = true;
  try {
    if (!pollLogged) { pollLogged = true; console.info('[kolo] поток событий недоступен, включён опрос раз в 5 секунд'); }
    if (pollHook) await pollHook();
    const d = await api(`/updates?msg=${pollMsg}&note=${pollNote}`);
    d.notes.forEach(onNotification);
    d.messages.forEach(onMessage);
  } catch {}
  polling = false;
}
function startPoller() { if (!pollTimer) { pollTimer = setInterval(poll, 5000); document.addEventListener('visibilitychange', () => !document.hidden && poll()); } }

let connecting = false;
async function connectStream() {
  startPoller();
  if (stream || streamTimer || connecting || !me) return;
  connecting = true; // пока ждём билет, второй вызов (роутер дёргается дважды) не должен открыть второй поток
  try {
    const { ticket } = await api('/stream-ticket', { method: 'POST' });
    if (!me) return; // успели выйти из аккаунта
    stream = new EventSource('/api/stream?ticket=' + ticket);
  } catch { return stopStream(true); }
  finally { connecting = false; }
  lastBeat = 0;
  stream.addEventListener('hb', () => { if (!lastBeat) console.info('[kolo] живые обновления: поток событий работает'); lastBeat = Date.now(); });
  stream.addEventListener('notification', (e) => { lastBeat = Date.now(); onNotification(JSON.parse(e.data)); });
  stream.addEventListener('msgdel', (e) => { try { document.querySelector(`.msg[data-id="${JSON.parse(e.data).id}"]`)?.remove(); } catch {} });
  stream.addEventListener('message', (e) => { lastBeat = Date.now(); onMessage(JSON.parse(e.data)); });
  stream.addEventListener('read', (e) => { lastBeat = Date.now(); if (readHook) readHook(JSON.parse(e.data).username); });
  stream.addEventListener('post', (e) => {
    const d = JSON.parse(e.data);
    if (!feedScope || (feedScope === 'following' && !d.following)) return;
    pending++;
    const b = document.getElementById('banner');
    if (b) { b.hidden = false; b.textContent = `Новых постов: ${pending} — показать`; }
  });
  stream.onerror = () => stopStream(true); // билет одноразовый, поэтому переподключаемся с новым
}

// ---------- роутер ----------
async function route() {
  document.title = baseTitle = 'Kolo'; view++;
  io?.disconnect(); io = null; msgHook = null; readHook = null; pollHook = null; noteHook = null;
  chatCleanup?.(); chatCleanup = null; delete ctxHooks.msg; delete ctxHooks.comment; closeCtx();
  const [, a, b] = (location.hash.slice(1) || '/').split('/');
  if (!localStorage.getItem('kolo_token')) { document.body.dataset.mode = ''; return a === 'register' ? registerView() : authView(); }
  if (!me) { try { await loadMe(); } catch { return authView(); } }
  if (a === 'login' || a === 'register') return void (location.hash = me.onboarded ? '#/' : '#/welcome/2');
  if (!me.onboarded && a !== 'welcome') return void (location.hash = '#/welcome/2');
  if (a === 'welcome') { document.body.dataset.mode = ''; return me.onboarded ? void (location.hash = '#/') : welcomeView(+b === 3 ? 3 : 2); }
  window.scrollTo(0, 0);
  feedScope = null;
  connectStream(); syncPush();
  if (a === 'notifications') return notificationsView(b);
  if (a === 'messages') return b ? threadView(decodeURIComponent(b)) : messagesView();
  if (a === 'bookmarks') return bookmarksView();
  if (a === 'settings') return settingsView(b);
  if (a === 'photos' && b) return photosView(decodeURIComponent(b));
  if (a === 'popular') return popularView(b);
  if (a === 'new') return newPostView();
  if (a === 'tag' && b) return tagView(decodeURIComponent(b));
  if (a === 'u' && b) return profileView(decodeURIComponent(b));
  if (a === 'post' && b) return postView(+b);
  if (a === 'search') return searchView(decodeURIComponent(b || ''));
  return feedView(a === 'following' ? 'following' : 'all');
}
window.addEventListener('hashchange', route);
if ('serviceWorker' in navigator && isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.goto) location.hash = e.data.goto; }); // нажали на push — открываем нужный экран
}
route();

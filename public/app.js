'use strict';
const app = document.getElementById('app');
let me = null;
let unread = 0, unreadMsgs = 0, pending = 0, feedScope = null, stream = null, streamTimer = null;
let lastBeat = 0, pollMsg = 0, pollNote = 0, pollHook = null, polling = false, pollTimer = null, pollLogged = false;
let view = 0; // номер текущего экрана: запоздавший ответ от уже закрытого экрана ничего не рисует
let io = null, msgHook = null, readHook = null; // io — наблюдатель бесконечной прокрутки; хуки — живые сообщения на открытом экране

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
const I = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/></svg>',
  heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 21s-8-4.9-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 10c0 6.100-8 11-8 11z"/></svg>',
  comment: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.800 7L3 20.500l1.500-5.200A8 8 0 1 1 21 12z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="1.800"/><path d="M21 16l-5-5-9 9"/></svg>',
  out: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>',
  bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9a6 6 0 0 1 12 0c0 6 2.500 8 2.500 8h-17S6 15 6 9zM10 21h4"/></svg>',
  bookmark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M6 3h12v18l-6-4.500L6 21z"/></svg>',
  repost: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/></svg>',
  mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 7l9 6 9-6"/></svg>',
  flame: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22c4 0 7-2.700 7-6.500 0-3-2-5-3.500-6.500C15 7.500 15 6 14 3c-3 2-6 5-6 9.500 0-1-.8-2-1.500-2.500C5.500 11.500 5 13 5 15.500 5 19.300 8 22 12 22z"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.200" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.500" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};
const pl = (n, one, few, many) => { const a = Math.abs(n) % 100, b = a % 10; return a > 10 && a < 20 ? many : b === 1 ? one : b > 1 && b < 5 ? few : many; };
const timeOf = (iso) => new Date(iso).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
function dayOf(iso) {
  const d = new Date(iso), t = new Date();
  const diff = Math.round((new Date(t.getFullYear(), t.getMonth(), t.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 864e5);
  return diff === 0 ? 'Сегодня' : diff === 1 ? 'Вчера' : d.toLocaleDateString('ru', { day: 'numeric', month: 'long' });
}
let toastT;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2600);
}
const avatar = (u, cls = '') => `<span class="av ${cls}" style="--h:${hue(u.username)}">${u.avatar ? `<img src="${esc(u.avatar)}" alt="">` : `<span aria-hidden="true">${esc((u.name || u.username)[0].toUpperCase())}</span>`}</span>`;

async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  const tk = localStorage.getItem('kolo_token');
  if (tk) headers.Authorization = 'Bearer ' + tk;
  if (body && !(body instanceof FormData)) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
  const r = await fetch('/api' + path, { method, headers, body });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401 && tk) { localStorage.removeItem('kolo_token'); me = null; location.hash = '#/login'; }
    throw new Error(data.error || 'Что-то пошло не так. Попробуйте ещё раз');
  }
  return data;
}

async function loadMe() { me = await api('/me'); unread = me.unread || 0; unreadMsgs = me.unread_messages || 0; pollMsg = me.last_msg || 0; pollNote = me.last_note || 0; return me; }

// ---------- каркас ----------
function shell(inner, active) {
  const link = (h, k, label, icon) => `<a href="${h}" class="${active === k ? 'on' : ''}" ${active === k ? 'aria-current="page"' : ''}>${icon}<span>${label}</span></a>`;
  app.innerHTML = `<div class="shell">
    <nav class="nav" aria-label="Основное меню">
      <a class="logo" href="#/"><svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="11" fill="none" stroke="var(--blue)" stroke-width="6"/></svg>Kolo</a>
      ${link('#/', 'home', 'Лента', I.home)}${link('#/popular', 'popular', 'Популярное', I.flame)}${link('#/search', 'search', 'Поиск', I.search)}${link('#/messages', 'msgs', 'Сообщения', I.mail + '<i class="badge" id="mbadge" hidden></i>')}${link('#/bookmarks', 'bm', 'Закладки', I.bookmark)}${link('#/notifications', 'notes', 'Уведомления', I.bell + '<i class="badge" id="badge" hidden></i>')}${link('#/u/' + esc(me.username), 'me', 'Профиль', I.user)}
      <span class="spacer"></span>
      <button class="navbtn" id="logout">${I.out}<span>Выйти</span></button>
    </nav>
    <main class="main" id="main">${inner}</main>
    <aside class="side" id="side"></aside></div>`;
  document.getElementById('logout').onclick = () => { stopStream(); localStorage.removeItem('kolo_token'); me = null; location.hash = '#/login'; };
  paintBadge();
  loadSuggestions();
}
async function loadSuggestions() {
  try {
    const [list, tr] = await Promise.all([api('/suggestions'), api('/trending').catch(() => ({ tags: [] }))]);
    if (!document.getElementById('side')) return;
    const sug = list.length ? `<div class="sheet"><h2>Кого читать</h2>${list.map(sugHTML).join('')}</div>` : '';
    const tags = tr.tags.length ? `<div class="sheet"><h2>В тренде</h2>${tr.tags.slice(0, 6).map((t) => `<a class="trend" href="#/tag/${encodeURIComponent(t.tag)}"><b>#${esc(t.tag)}</b><span>${t.n} ${pl(t.n, 'пост', 'поста', 'постов')}</span></a>`).join('')}</div>` : '';
    document.getElementById('side').innerHTML = sug + tags;
  } catch {}
}
const sugHTML = (u) => `<div class="sug"><a href="#/u/${esc(u.username)}">${avatar(u, 'sm')}</a>
  <a class="who" href="#/u/${esc(u.username)}"><b>${esc(u.name || u.username)}</b><span>@${esc(u.username)}</span></a>
  <button class="btn sm line" data-follow="${esc(u.username)}">Читать</button></div>`;

// ---------- посты ----------
function postHTML(p) {
  const rp = p.reposted_by ? `<div class="rp muted">${I.repost}<span>${p.reposted_by === me.username ? 'Вы сделали репост' : `Репост от <a href="#/u/${esc(p.reposted_by)}">${esc(p.reposted_by_name || p.reposted_by)}</a>`}</span></div>` : '';
  return `<article class="post" data-id="${p.id}">
    <a href="#/u/${esc(p.username)}" tabindex="-1" aria-hidden="true">${avatar(p)}</a>
    <div class="pbody">${rp}
      <header><a class="pname" href="#/u/${esc(p.username)}">${esc(p.name || p.username)}</a>
        <span class="muted">@${esc(p.username)}</span>
        <a class="muted" href="#/post/${p.id}" title="${esc(new Date(p.created_at).toLocaleString('ru'))}">${ago(p.created_at)}</a>
        ${p.username === me.username ? `<button class="icon del" data-del="${p.id}" aria-label="Удалить пост">${I.trash}</button>` : ''}</header>
      ${p.text ? `<p class="ptext">${linkify(p.text)}</p>` : ''}
      ${p.image ? `<img class="pimg" src="${esc(p.image)}" alt="Изображение к посту" loading="lazy">` : ''}
      <footer>
        <button class="act like ${p.liked ? 'on' : ''}" data-like="${p.id}" aria-pressed="${p.liked}" aria-label="Нравится">${I.heart}<span>${p.likes || ''}</span></button>
        <a class="act" href="#/post/${p.id}" aria-label="Комментарии">${I.comment}<span>${p.comments || ''}</span></a>
        <button class="act rep ${p.reposted ? 'on' : ''}" data-repost="${p.id}" aria-pressed="${!!p.reposted}" aria-label="Репост">${I.repost}<span>${p.reposts || ''}</span></button>
        <button class="act bm grow ${p.bookmarked ? 'on' : ''}" data-bm="${p.id}" aria-pressed="${!!p.bookmarked}" aria-label="В закладки">${I.bookmark}</button>
      </footer>
    </div></article>`;
}
const feedList = (posts, emptyHTML) => posts.length ? posts.map(postHTML).join('') : emptyHTML;

function composerHTML() {
  return `<form class="sheet composer" id="composer">${avatar(me)}
    <div class="col">
      <textarea name="text" rows="2" maxlength="500" placeholder="Что нового?" aria-label="Текст поста"></textarea>
      <div class="preview" id="preview" hidden><img alt="Предпросмотр"><button type="button" class="icon" id="unpick" aria-label="Убрать картинку">${I.x}</button></div>
      <div class="row">
        <label class="icon" title="Добавить картинку" style="cursor:pointer">${I.image}<input type="file" accept="image/jpeg,image/png,image/webp,image/gif" id="pick" hidden></label>
        <span class="count" id="count">0 / 500</span>
        <button class="btn" type="submit">Опубликовать</button>
      </div></div></form>`;
}
function bindComposer(onPost) {
  const f = document.getElementById('composer'), ta = f.text, pick = document.getElementById('pick'), prev = document.getElementById('preview');
  ta.addEventListener('input', () => {
    ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px';
    const c = document.getElementById('count'); c.textContent = `${ta.value.length} / 500`; c.classList.toggle('over', ta.value.length > 480);
  });
  pick.onchange = () => {
    const file = pick.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { pick.value = ''; return toast('Файл больше 5 МБ'); }
    prev.querySelector('img').src = URL.createObjectURL(file); prev.hidden = false;
  };
  document.getElementById('unpick').onclick = () => { pick.value = ''; prev.hidden = true; };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const btn = f.querySelector('.btn'); btn.disabled = true;
    const fd = new FormData(); fd.append('text', ta.value);
    if (pick.files[0]) fd.append('image', pick.files[0]);
    try {
      const p = await api('/posts', { method: 'POST', body: fd });
      f.reset(); prev.hidden = true; ta.style.height = 'auto'; document.getElementById('count').textContent = '0 / 500';
      onPost(p); toast('Опубликовано');
    } catch (err) { toast(err.message); }
    btn.disabled = false;
  };
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
  const observer = new IntersectionObserver((en) => { if (en[0].isIntersecting) load(); }, { rootMargin: '600px' });
  observer.observe(s); io = observer;
}
const lastCur = (batch) => batch[batch.length - 1].cur;

// ---------- экраны ----------
function authView() {
  app.innerHTML = `<div class="authwrap"><form class="sheet authbox" id="auth">
    <h1>С возвращением</h1><p>Войдите, чтобы увидеть ленту.</p>
    <label class="field"><span>Имя пользователя</span><input name="username" required maxlength="20" autocomplete="username" autocapitalize="none"></label>
    <label class="field"><span>Пароль</span><input name="password" type="password" required autocomplete="current-password"></label>
    <p class="err" id="err" role="alert"></p>
    <button class="btn" type="submit">Войти</button>
    <div class="switch">Нет аккаунта? <a href="#/register">Создать</a></div></form></div>`;
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
  app.innerHTML = `<div class="authwrap"><div class="sheet authbox wiz">
    <ol class="steps" aria-label="Шаги регистрации">${titles.map((t, i) => `<li class="${i + 1 < step ? 'done' : i + 1 === step ? 'cur' : ''}" ${i + 1 === step ? 'aria-current="step"' : ''}><i>${i + 1 < step ? '✓' : i + 1}</i><span>${t}</span></li>`).join('')}</ol>
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
  shell(`${composerHTML()}
    <div class="tabs" style="margin-top:14px"><a href="#/" class="${scope === 'all' ? 'on' : ''}">Все</a><a href="#/following" class="${scope === 'following' ? 'on' : ''}">Подписки</a></div>
    <button class="banner" id="banner" hidden></button>
    <div class="sheet" id="feed"></div>`, 'home');
  feedScope = scope; pending = 0;
  document.getElementById('banner').onclick = () => route();
  const feed = document.getElementById('feed');
  const q = (before) => api(`/feed?scope=${scope}${before ? '&before=' + before : ''}`);
  const empty = `<div class="empty"><b>${scope === 'all' ? 'Здесь пока тихо' : 'В подписках пусто'}</b>${scope === 'all' ? 'Напишите первый пост.' : 'Подпишитесь на кого-нибудь — их посты появятся здесь.'}</div>`;
  bindComposer((p) => { feed.querySelector('.empty')?.remove(); feed.insertAdjacentHTML('afterbegin', postHTML(p)); });
  const posts = await q().catch((e) => (toast(e.message), []));
  if (v !== view) return;
  feed.innerHTML = feedList(posts, empty); infinite(feed, posts, (n, last) => q(lastCur(last)));
}

async function profileView(username) {
  const v = view;
  shell('<div class="sheet empty">Загрузка…</div>', username === me.username ? 'me' : '');
  let data;
  try { data = await api('/users/' + encodeURIComponent(username)); }
  catch (e) { return void (v === view && (document.getElementById('main').innerHTML = errBox(e))); }
  if (v !== view) return;
  const u = data.user, own = u.username === me.username;
  document.title = `${u.name || u.username} — Kolo`;
  document.getElementById('main').innerHTML = `<div class="sheet">
    <div class="cover" style="--h:${hue(u.username)}"></div>
    <div class="phead"><div class="top">${avatar(u, 'xl')}
      ${own ? '<button class="btn line" id="edit">Изменить профиль</button>' : `<div class="btns"><a class="btn line" href="#/messages/${esc(u.username)}">Написать</a><button class="btn ${u.isFollowing ? 'line' : ''}" data-follow="${esc(u.username)}" id="fbtn">${u.isFollowing ? 'Вы читаете' : 'Читать'}</button></div>`}</div>
      <h1>${esc(u.name || u.username)}</h1><div class="muted">@${esc(u.username)}</div>
      ${u.bio ? `<p class="bio">${linkify(u.bio)}</p>` : ''}
      <div class="stats"><span><b>${u.posts}</b> постов</span><span><b id="fcount">${u.followers}</b> читателей</span><span><b>${u.following}</b> в подписках</span></div></div></div>
    <div class="sheet" id="feed">${feedList(data.posts, `<div class="empty"><b>Постов пока нет</b>${own ? 'Опубликуйте первый на главной.' : ''}</div>`)}</div>`;
  infinite(document.getElementById('feed'), data.posts, (n, last) => api(`/users/${encodeURIComponent(username)}?before=${lastCur(last)}`).then((d) => d.posts));
  if (own) document.getElementById('edit').onclick = () => editDialog();
}

function editDialog() {
  const d = document.createElement('dialog');
  d.innerHTML = `<form method="dialog" id="eform"><h2>Изменить профиль</h2>
    <label class="field"><span>Имя</span><input name="name" maxlength="40" value="${esc(me.name)}"></label>
    <label class="field"><span>О себе</span><textarea name="bio" rows="3" maxlength="160">${esc(me.bio)}</textarea></label>
    <label class="field"><span>Аватар (до 5 МБ)</span><input name="avatar" type="file" accept="image/jpeg,image/png,image/webp,image/gif"></label>
    <div class="actions"><button type="button" class="btn line" id="cancel">Отмена</button><button class="btn" type="submit">Сохранить</button></div></form>`;
  document.body.appendChild(d); d.showModal();
  d.querySelector('#cancel').onclick = () => d.close();
  d.addEventListener('close', () => d.remove());
  d.querySelector('#eform').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    if (!fd.get('avatar').size) fd.delete('avatar');
    try { me = await api('/me', { method: 'PUT', body: fd }); d.close(); toast('Профиль сохранён'); route(); }
    catch (err) { toast(err.message); }
  };
}

async function postView(id) {
  const v = view;
  shell('<div class="sheet empty">Загрузка…</div>', '');
  let data;
  try { data = await api('/posts/' + id); }
  catch (e) { return void (v === view && (document.getElementById('main').innerHTML = errBox(e))); }
  if (v !== view) return;
  const replies = {};
  data.comments.forEach((c) => { if (c.parent_id) (replies[c.parent_id] ||= []).push(c); });
  const cHTML = (c, isReply) => `<div class="comment ${isReply ? 'reply' : ''}">${avatar(c, 'sm')}<div class="pbody"><header>
    <a class="pname" href="#/u/${esc(c.username)}">${esc(c.name || c.username)}</a><span class="muted">${ago(c.created_at)}</span>
    <button class="link" data-reply="${c.parent_id || c.id}" data-who="${esc(c.username)}">Ответить</button></header>
    <p class="ptext">${linkify(c.text)}</p></div></div>`;
  const threadHTML = (c) => `<div class="thread" data-root="${c.id}">${cHTML(c)}${(replies[c.id] || []).map((r) => cHTML(r, true)).join('')}</div>`;
  document.getElementById('main').innerHTML = `<div class="sheet">${postHTML(data.post)}
    <div id="comments">${data.comments.filter((c) => !c.parent_id).map(threadHTML).join('')}</div>
    <form class="cform" id="cform">
      <div class="chip" id="rchip" hidden><span></span><button type="button" class="icon" id="rcancel" aria-label="Отменить ответ">${I.x}</button></div>
      <input name="text" maxlength="300" placeholder="Написать комментарий" aria-label="Комментарий" required><button class="btn" type="submit">Отправить</button></form></div>`;
  const f = document.getElementById('cform'), chip = document.getElementById('rchip');
  let replyTo = null;
  const setReply = (rootId, who) => {
    replyTo = rootId; chip.hidden = !rootId;
    if (rootId) { chip.querySelector('span').textContent = 'Ответ для @' + who; f.text.value = '@' + who + ' '; f.text.focus(); }
  };
  document.getElementById('comments').onclick = (e) => { const b = e.target.closest('[data-reply]'); if (b) setReply(+b.dataset.reply, b.dataset.who); };
  document.getElementById('rcancel').onclick = () => { setReply(null); f.text.value = ''; };
  f.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const c = await api(`/posts/${id}/comments`, { method: 'POST', body: { text: f.text.value, parent_id: replyTo } });
      const box = document.getElementById('comments');
      if (c.parent_id) box.querySelector(`.thread[data-root="${c.parent_id}"]`)?.insertAdjacentHTML('beforeend', cHTML(c, true));
      else box.insertAdjacentHTML('beforeend', threadHTML(c));
      f.reset(); setReply(null);
    } catch (err) { toast(err.message); }
  };
}

async function searchView(q) {
  const v = view;
  shell(`<div class="sheet"><form class="search" id="sform"><input name="q" type="search" placeholder="Люди и слова, #теги" aria-label="Поиск" value="${esc(q)}"><button class="btn" type="submit">Найти</button></form></div><div id="results"></div>`, 'search');
  document.getElementById('sform').onsubmit = (e) => { e.preventDefault(); location.hash = '#/search/' + encodeURIComponent(e.target.q.value.trim()); };
  if (/^#[\p{L}\d_]+$/u.test(q)) return void location.replace('#/tag/' + encodeURIComponent(q.slice(1).toLowerCase()));
  if (!q) return;
  const box = document.getElementById('results');
  try {
    const r = await api('/search?q=' + encodeURIComponent(q));
    if (v !== view) return;
    if (!r.users.length && !r.posts.length) return void (box.innerHTML = `<div class="sheet empty" style="margin-top:14px"><b>Ничего не нашли</b>Попробуйте другое слово.</div>`);
    box.innerHTML = `${r.users.length ? `<div class="sheet" style="margin-top:14px"><div class="sechead">Люди</div>${r.users.map((u) => `<div class="sug"><a href="#/u/${esc(u.username)}">${avatar(u, 'sm')}</a><a class="who" href="#/u/${esc(u.username)}"><b>${esc(u.name || u.username)}</b><span>@${esc(u.username)}</span></a></div>`).join('')}</div>` : ''}
      ${r.posts.length ? `<div class="sheet" style="margin-top:14px"><div class="sechead">Посты</div>${r.posts.map(postHTML).join('')}</div>` : ''}`;
  } catch (e) { toast(e.message); }
}

// ---------- популярное, теги, закладки ----------
const errBox = (e) => `<div class="sheet empty"><b>${esc(e.message)}</b><a class="btn" href="#/">В ленту</a></div>`;

async function popularView(range) {
  const v = view; range = range === 'all' ? 'all' : 'week';
  shell(`<div class="sheet empty">Загрузка…</div>`, 'popular');
  let posts, tags;
  try { [posts, tags] = await Promise.all([api(`/popular?range=${range}`), api('/trending').then((r) => r.tags)]); }
  catch (e) { return void (v === view && (document.getElementById('main').innerHTML = errBox(e))); }
  if (v !== view) return;
  document.getElementById('main').innerHTML = `<div class="tabs"><a href="#/popular" class="${range === 'week' ? 'on' : ''}">За неделю</a><a href="#/popular/all" class="${range === 'all' ? 'on' : ''}">За всё время</a></div>
    ${tags.length ? `<div class="sheet"><div class="sechead">Сейчас обсуждают</div><div class="chips">${tags.map((t) => `<a class="tagchip" href="#/tag/${encodeURIComponent(t.tag)}">#${esc(t.tag)}<small>${t.n}</small></a>`).join('')}</div></div>` : ''}
    <div class="sheet" id="feed">${feedList(posts, `<div class="empty"><b>Пока нечего показать</b>Здесь появятся посты, которые лайкают, комментируют и репостят.</div>`)}</div>`;
  infinite(document.getElementById('feed'), posts, (n) => api(`/popular?range=${range}&offset=${n}`));
}

async function tagView(tag) {
  const v = view;
  shell('<div class="sheet empty">Загрузка…</div>', 'search');
  let d;
  try { d = await api('/tags/' + encodeURIComponent(tag)); } catch (e) { return void (v === view && (document.getElementById('main').innerHTML = errBox(e))); }
  if (v !== view) return;
  document.title = `#${d.tag} — Kolo`;
  document.getElementById('main').innerHTML = `<div class="sheet thead"><h1>#${esc(d.tag)}</h1><div class="muted">${d.total} ${pl(d.total, 'пост', 'поста', 'постов')}</div></div>
    <div class="sheet" id="feed">${feedList(d.posts, `<div class="empty"><b>С этим тегом пока нет постов</b>Напишите первый: добавьте #${esc(d.tag)} в текст.</div>`)}</div>`;
  infinite(document.getElementById('feed'), d.posts, (n, last) => api(`/tags/${encodeURIComponent(d.tag)}?before=${lastCur(last)}`).then((r) => r.posts));
}

async function bookmarksView() {
  const v = view;
  shell('<div class="sheet thead"><h1>Закладки</h1><div class="muted">Видите только вы</div></div><div class="sheet" id="feed"><div class="empty">Загрузка…</div></div>', 'bm');
  const feed = document.getElementById('feed');
  const posts = await api('/bookmarks').catch((e) => (toast(e.message), []));
  if (v !== view) return;
  feed.innerHTML = feedList(posts, '<div class="empty"><b>Закладок пока нет</b>Нажмите на флажок под постом, чтобы сохранить его на потом.</div>');
  infinite(feed, posts, (n, last) => api('/bookmarks?before=' + lastCur(last)));
}

// ---------- личные сообщения ----------
const convHTML = (c) => `<a class="conv ${c.unread ? 'unread' : ''}" href="#/messages/${esc(c.username)}">${avatar(c, 'sm')}
  <div class="who"><div class="top"><b>${esc(c.name || c.username)}</b><span class="muted">${ago(c.created_at)}</span></div>
  <div class="snip muted">${c.mine ? 'Вы: ' : ''}${esc(c.text)}</div></div>${c.unread ? `<i class="badge static">${c.unread > 9 ? '9+' : c.unread}</i>` : ''}</a>`;

async function messagesView() {
  const v = view;
  shell('<div class="sheet thead"><h1>Сообщения</h1></div><div class="sheet" id="convs"><div class="empty">Загрузка…</div></div>', 'msgs');
  const load = async () => {
    const box = document.getElementById('convs'); if (!box) return;
    try {
      const list = await api('/conversations');
      if (v !== view) return;
      box.innerHTML = list.length ? list.map(convHTML).join('') : '<div class="empty"><b>Сообщений пока нет</b>Откройте чей-нибудь профиль и нажмите «Написать».</div>';
    } catch (e) { toast(e.message); }
  };
  await load();
  if (v !== view) return;
  msgHook = () => { load(); return false; }; // список обновляется, а счётчик и тост — как обычно
}

async function threadView(username) {
  const v = view;
  shell('<div class="sheet empty">Загрузка…</div>', 'msgs');
  let data;
  try { data = await api('/messages/' + encodeURIComponent(username)); }
  catch (e) { return void (v === view && (document.getElementById('main').innerHTML = `<div class="sheet empty"><b>${esc(e.message)}</b><a class="btn" href="#/messages">К сообщениям</a></div>`)); }
  if (v !== view) return;
  const peer = data.user; let list = data.messages, more = data.more, busy = false, olderIo = null;
  document.title = `${peer.name || peer.username} — Kolo`;
  api('/me').then((m) => { unreadMsgs = m.unread_messages || 0; paintBadge(); }).catch(() => {}); // диалог открыт — входящие прочитаны
  document.getElementById('main').innerHTML = `<div class="sheet chat">
    <header class="chead"><a class="icon" href="#/messages" aria-label="Назад к сообщениям">${I.back}</a>
      <a class="chat-who" href="#/u/${esc(peer.username)}">${avatar(peer, 'sm')}<div class="cwt"><b>${esc(peer.name || peer.username)}</b><small class="muted">@${esc(peer.username)}</small></div></a></header>
    <div class="msgs" id="msgs" aria-live="polite"></div>
    <form class="mform" id="mform"><textarea name="text" rows="1" maxlength="2000" placeholder="Сообщение…" aria-label="Сообщение"></textarea><button class="btn" type="submit">Отправить</button></form></div>`;
  const box = document.getElementById('msgs'), f = document.getElementById('mform'), ta = f.text;

  const render = (mode) => {
    const prevH = box.scrollHeight, prevTop = box.scrollTop;
    let day = '', out = more ? '<div class="older" id="older">Загрузка…</div>' : '';
    for (const m of list) {
      const d = dayOf(m.created_at);
      if (d !== day) { day = d; out += `<div class="day">${d}</div>`; }
      out += `<div class="msg ${m.mine ? 'mine' : ''}"><p>${linkify(m.text)}</p><span>${timeOf(m.created_at)}${m.mine && m.is_read ? ' · прочитано' : ''}</span></div>`;
    }
    box.innerHTML = out || '<div class="empty"><b>Начните разговор</b>Напишите первое сообщение.</div>';
    box.scrollTop = mode === 'bottom' ? box.scrollHeight : prevTop + (box.scrollHeight - prevH);
    const older = document.getElementById('older');
    olderIo?.disconnect();
    if (older) { olderIo = new IntersectionObserver((en) => { if (en[0].isIntersecting) loadOlder(); }, { root: box }); olderIo.observe(older); }
  };
  const loadOlder = async () => {
    if (busy || !more) return; busy = true;
    try {
      const d = await api(`/messages/${encodeURIComponent(username)}?before=${list[0].id}`);
      list = d.messages.concat(list); more = d.more; render('keep');
    } catch (e) { toast(e.message); }
    busy = false;
  };
  render('bottom');

  const nearBottom = () => box.scrollHeight - box.scrollTop - box.clientHeight < 90;
  msgHook = (m) => {
    if (m.username.toLowerCase() !== peer.username.toLowerCase()) return false;
    if (list.some((x) => x.id === m.id)) return true; // уже есть (пришло и по потоку, и по опросу)
    const stick = nearBottom();
    list.push({ id: m.id, text: m.text, created_at: m.created_at, mine: false, is_read: 1 });
    render(stick ? 'bottom' : 'keep');
    api(`/messages/${encodeURIComponent(peer.username)}/read`, { method: 'POST' }).catch(() => {});
    return true;
  };
  readHook = (uname) => {
    if (uname.toLowerCase() !== peer.username.toLowerCase()) return;
    list.forEach((m) => { if (m.mine) m.is_read = 1; }); render('keep');
  };

  pollHook = async () => { // запасной режим: подтягиваем новое и «прочитано» без потока событий
    const d = await api('/messages/' + encodeURIComponent(peer.username));
    let changed = false;
    for (const m of d.messages) {
      const have = list.find((x) => x.id === m.id);
      if (!have) { list.push(m); changed = true; }
      else if (m.mine && m.is_read && !have.is_read) { have.is_read = 1; changed = true; }
    }
    if (changed) { list.sort((a, b) => a.id - b.id); render(nearBottom() ? 'bottom' : 'keep'); }
  };
  const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 140) + 'px'; };
  ta.addEventListener('input', grow);
  // Enter отправляет на компьютере; на телефоне Enter — перенос строки
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer: fine)').matches) { e.preventDefault(); f.requestSubmit(); } });
  f.onsubmit = async (e) => {
    e.preventDefault();
    const text = ta.value.trim(); if (!text) return;
    const btn = f.querySelector('.btn'); btn.disabled = true;
    try {
      const m = await api('/messages/' + encodeURIComponent(peer.username), { method: 'POST', body: { text } });
      list.push(m); ta.value = ''; grow(); render('bottom');
    } catch (err) { toast(err.message); }
    btn.disabled = false; ta.focus();
  };
  if (matchMedia('(pointer: fine)').matches) ta.focus();
}

// ---------- действия (делегирование) ----------
document.addEventListener('click', async (e) => {
  const repB = e.target.closest('[data-repost]'), bmB = e.target.closest('[data-bm]'), likeB = e.target.closest('[data-like]'), delB = e.target.closest('[data-del]'), folB = e.target.closest('[data-follow]');
  try {
    if (likeB) {
      likeB.disabled = true;
      const r = await api(`/posts/${likeB.dataset.like}/like`, { method: 'POST' });
      likeB.classList.toggle('on', r.liked); likeB.setAttribute('aria-pressed', r.liked); likeB.querySelector('span').textContent = r.likes || '';
      likeB.disabled = false;
    } else if (repB) {
      repB.disabled = true;
      const r = await api(`/posts/${repB.dataset.repost}/repost`, { method: 'POST' });
      repB.classList.toggle('on', r.reposted); repB.setAttribute('aria-pressed', r.reposted); repB.querySelector('span').textContent = r.reposts || '';
      repB.disabled = false; toast(r.reposted ? 'Репост опубликован' : 'Репост отменён');
    } else if (bmB) {
      bmB.disabled = true;
      const r = await api(`/posts/${bmB.dataset.bm}/bookmark`, { method: 'POST' });
      bmB.classList.toggle('on', r.bookmarked); bmB.setAttribute('aria-pressed', r.bookmarked);
      bmB.disabled = false; toast(r.bookmarked ? 'Сохранено в закладки' : 'Убрано из закладок');
    } else if (delB) {
      if (!confirm('Удалить этот пост?')) return;
      await api('/posts/' + delB.dataset.del, { method: 'DELETE' });
      const post = delB.closest('.post'); post.remove(); toast('Пост удалён');
      if (location.hash.startsWith('#/post/')) location.hash = '#/';
    } else if (folB) {
      folB.disabled = true;
      const r = await api(`/users/${encodeURIComponent(folB.dataset.follow)}/follow`, { method: 'POST' });
      if (folB.id === 'fbtn') {
        folB.textContent = r.isFollowing ? 'Вы читаете' : 'Читать'; folB.classList.toggle('line', r.isFollowing);
        document.getElementById('fcount').textContent = r.followers;
      } else { folB.textContent = r.isFollowing ? 'Вы читаете' : 'Читать'; folB.classList.toggle('line', !r.isFollowing); }
      folB.disabled = false;
    }
  } catch (err) { toast(err.message); [likeB, repB, bmB, folB].forEach((b) => b && (b.disabled = false)); }
});

// ---------- realtime и уведомления ----------
const NOTE = { like: 'ставит лайк вашему посту', comment: 'комментирует ваш пост', reply: 'отвечает на ваш комментарий', follow: 'читает вас', mention: 'упоминает вас', repost: 'делает репост вашего поста' };
function paintBadge() {
  for (const [id, n] of [['badge', unread], ['mbadge', unreadMsgs]]) {
    const b = document.getElementById(id);
    if (b) { b.hidden = !n; b.textContent = n > 9 ? '9+' : n; }
  }
}
const noteHTML = (n) => `<a class="note ${n.is_read ? '' : 'new'}" href="${n.type === 'follow' ? '#/u/' + esc(n.username) : '#/post/' + n.post_id}">${avatar(n, 'sm')}
  <div><b>${esc(n.name || n.username)}</b> ${NOTE[n.type] || ''}${n.text ? `<p class="muted snip">${esc(n.text)}</p>` : ''}<span class="muted">${ago(n.created_at)}</span></div></a>`;

function stopStream(retry) {
  if (stream) { stream.close(); stream = null; }
  clearTimeout(streamTimer); streamTimer = null;
  if (retry && me) streamTimer = setTimeout(() => { streamTimer = null; connectStream(); }, 4000);
}
function onNotification(n) {
  pollNote = Math.max(pollNote, n.id || 0);
  toast(`${n.name || n.username} ${NOTE[n.type] || ''}`);
  const box = document.getElementById('notes');
  if (box) { box.querySelector('.empty')?.remove(); box.insertAdjacentHTML('afterbegin', noteHTML(n)); api('/notifications/read', { method: 'POST' }).catch(() => {}); }
  else { unread++; paintBadge(); }
}
function onMessage(m) {
  pollMsg = Math.max(pollMsg, m.id || 0);
  if (msgHook && msgHook(m)) return; // диалог с этим человеком открыт — сообщение уже на экране
  unreadMsgs++; paintBadge(); toast(`${m.name || m.username}: ${m.text.slice(0, 50)}`);
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

async function notificationsView() {
  const v = view;
  shell('<div class="sheet" id="notes"><div class="empty">Загрузка…</div></div>', 'notes');
  try {
    const r = await api('/notifications');
    if (v !== view) return;
    document.getElementById('notes').innerHTML = r.items.length ? r.items.map(noteHTML).join('')
      : '<div class="empty"><b>Пока ничего нового</b>Лайки, ответы и подписки появятся здесь.</div>';
    if (unread) { await api('/notifications/read', { method: 'POST' }); unread = 0; paintBadge(); }
  } catch (e) { toast(e.message); }
}

// ---------- роутер ----------
async function route() {
  document.title = 'Kolo'; view++;
  io?.disconnect(); io = null; msgHook = null; readHook = null; pollHook = null;
  const [, a, b] = (location.hash.slice(1) || '/').split('/');
  if (!localStorage.getItem('kolo_token')) return a === 'register' ? registerView() : authView();
  if (!me) { try { await loadMe(); } catch { return authView(); } }
  if (a === 'login' || a === 'register') return void (location.hash = me.onboarded ? '#/' : '#/welcome/2');
  if (!me.onboarded && a !== 'welcome') return void (location.hash = '#/welcome/2');
  if (a === 'welcome') return me.onboarded ? void (location.hash = '#/') : welcomeView(+b === 3 ? 3 : 2);
  window.scrollTo(0, 0);
  feedScope = null;
  connectStream();
  if (a === 'notifications') return notificationsView();
  if (a === 'messages') return b ? threadView(decodeURIComponent(b)) : messagesView();
  if (a === 'bookmarks') return bookmarksView();
  if (a === 'popular') return popularView(b);
  if (a === 'tag' && b) return tagView(decodeURIComponent(b));
  if (a === 'u' && b) return profileView(decodeURIComponent(b));
  if (a === 'post' && b) return postView(+b);
  if (a === 'search') return searchView(decodeURIComponent(b || ''));
  return feedView(a === 'following' ? 'following' : 'all');
}
window.addEventListener('hashchange', route);
route();

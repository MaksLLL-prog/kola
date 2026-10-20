const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { db, DATA_DIR } = require('./db');
const storage = require('./storage');
const push = require('./push');
const zlib = require('zlib');

const PORT = process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === 'production';

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function loadSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (PROD) throw new Error('В production обязательно задайте JWT_SECRET');
  const f = path.join(DATA_DIR, '.jwt_secret');
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(48).toString('hex'), { mode: 0o600 });
  return fs.readFileSync(f, 'utf8');
}
const SECRET = loadSecret();

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', 1); // за Caddy/Nginx, иначе лимиты видят один IP
// Render и подобные платформы кладут настоящий IP посетителя в отдельный заголовок (True-Client-IP):
// цепочка прокси там длиннее одного узла, и без этого лимиты считали бы всех посетителей одним человеком.
const IP_HEADER = (process.env.CLIENT_IP_HEADER || '').toLowerCase();
if (IP_HEADER) app.use((req, res, next) => {
  const v = req.headers[IP_HEADER];
  if (v) Object.defineProperty(req, 'ip', { value: String(v).split(',')[0].trim(), configurable: true });
  next();
});
// gzip для текстовых ответов: без внешних пакетов. Поток событий (SSE) не трогаем — он должен уходить сразу.
app.use((req, res, next) => {
  if (req.method === 'HEAD' || req.path === '/api/stream' || !/\bgzip\b/.test(req.get('Accept-Encoding') || '')) return next();
  const write = res.write.bind(res), end = res.end.bind(res);
  let gz = null;
  const start = () => {
    if (gz !== null) return;
    const type = String(res.getHeader('Content-Type') || '');
    if (!/json|javascript|css|html|svg|manifest|text\//.test(type) || res.getHeader('Content-Encoding') || res.statusCode === 204 || res.statusCode === 304) { gz = false; return; }
    gz = zlib.createGzip({ level: 5 });
    res.setHeader('Content-Encoding', 'gzip'); res.removeHeader('Content-Length'); res.vary('Accept-Encoding');
    gz.on('data', (c) => write(c)); gz.on('end', () => end());
  };
  res.write = (c, e, cb) => { start(); return gz ? (gz.write(c, e, cb), true) : write(c, e, cb); };
  res.end = (c, e, cb) => { start(); if (!gz) return end(c, e, cb); if (c) gz.write(c, e); gz.end(); return res; };
  next();
});
app.use(express.json({ limit: '50kb' }));
app.use((req, res, next) => {
  const img = ["'self'", 'data:', 'blob:', storage.publicOrigin].filter(Boolean).join(' ');
  const h = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': `default-src 'self'; img-src ${img}; style-src 'self' https://fonts.googleapis.com; style-src-attr 'unsafe-inline'; font-src https://fonts.gstatic.com; script-src 'self'; frame-ancestors 'none'`,
  };
  if (PROD) h['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  res.set(h); next();
});

// ---------- лимиты ----------
function limiter(max, windowMs, msg) {
  const hits = new Map();
  setInterval(() => { const n = Date.now(); for (const [k, a] of hits) { const f = a.filter((t) => n - t < windowMs); f.length ? hits.set(k, f) : hits.delete(k); } }, windowMs).unref();
  return (req, res, next) => {
    const n = Date.now(), arr = (hits.get(req.ip) || []).filter((t) => n - t < windowMs);
    if (arr.length >= max) return res.status(429).json({ error: msg });
    arr.push(n); hits.set(req.ip, arr); next();
  };
}
const limitAuth = limiter(30, 15 * 60 * 1000, 'Слишком много попыток. Попробуйте через 15 минут');
const limitWrites = limiter(120, 60 * 1000, 'Слишком часто. Подождите минуту');
const limitCheck = limiter(60, 60 * 1000, 'Слишком часто. Подождите минуту');

// ---------- картинки ----------
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
function sniff(b) { // тип определяем по содержимому, а не по заголовку от клиента
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return '.jpg';
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
  if (b.subarray(0, 4).toString('latin1') === 'GIF8') return '.gif';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return '.webp';
  return null;
}
async function saveImage(file) {
  const ext = sniff(file.buffer);
  if (!ext) throw new HttpError(400, 'Допустимы только JPG, PNG, WebP и GIF');
  return storage.save(file.buffer, ext);
}

// ---------- realtime (SSE) ----------
const clients = new Map();   // userId -> Set<res>
const tickets = new Map();   // одноразовые билеты, чтобы не светить JWT в URL
setInterval(() => { const n = Date.now(); for (const [k, v] of tickets) if (v.exp < n) tickets.delete(k); }, 60000).unref();
function emit(userId, event, data) {
  for (const res of clients.get(userId) || []) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ---------- авторизация ----------
const sign = (id) => jwt.sign({ id }, SECRET, { expiresIn: '30d' });
const auth = route(async (req, res, next) => {
  let id;
  try { id = jwt.verify((req.get('Authorization') || '').replace(/^Bearer /, ''), SECRET).id; } catch { throw new HttpError(401, 'Нужно войти в аккаунт'); }
  const user = await db.get('SELECT id, username, name, bio, avatar, onboarded, gender, relationship, partner, website, telegram, life_main, people_main, interests, cover, pinned_post FROM users WHERE id = @id', { id });
  if (!user) throw new HttpError(401, 'Нужно войти в аккаунт');
  req.user = user; next();
});

const clean = (s, max) => String(s ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);
const now = () => new Date().toISOString();
const count = async (sql, params) => (await db.get(sql, params)).n;

app.post('/api/register', limitAuth, route(async (req, res) => {
  const username = clean(req.body.username, 20), name = clean(req.body.name, 40), password = String(req.body.password || '');
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) throw new HttpError(400, 'Имя пользователя: 3–20 символов, латиница, цифры и _');
  if (password.length < 8) throw new HttpError(400, 'Пароль должен быть не короче 8 символов');
  if (await db.get('SELECT 1 AS x FROM users WHERE lower(username) = lower(@u)', { u: username })) throw new HttpError(409, 'Это имя пользователя уже занято');
  try {
    const id = await db.insert('INSERT INTO users (username, name, password_hash, created_at, onboarded) VALUES (@u,@n,@p,@c,0)',
      { u: username, n: name || username, p: bcrypt.hashSync(password, 10), c: now() });
    res.json({ token: sign(id) });
  } catch (e) {
    if (/unique/i.test(e.message)) throw new HttpError(409, 'Это имя пользователя уже занято');
    throw e;
  }
}));

app.get('/api/username-available', limitCheck, route(async (req, res) => {
  const u = clean(req.query.u, 20);
  if (!/^[A-Za-z0-9_]{3,20}$/.test(u)) return res.json({ available: false, reason: 'format' });
  res.json({ available: !(await db.get('SELECT 1 AS x FROM users WHERE lower(username) = lower(@u)', { u })) });
}));

app.post('/api/login', limitAuth, route(async (req, res) => {
  const u = await db.get('SELECT id, password_hash FROM users WHERE lower(username) = lower(@u)', { u: clean(req.body.username, 20) });
  if (!u || !bcrypt.compareSync(String(req.body.password || ''), u.password_hash)) throw new HttpError(401, 'Неверное имя пользователя или пароль');
  res.json({ token: sign(u.id) });
}));

app.get('/api/me', auth, route(async (req, res) => {
  const [unread, unread_messages, last_msg, last_note] = await Promise.all([
    count('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM notifications WHERE user_id = @me AND is_read = 0', { me: req.user.id }),
    count('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM messages WHERE recipient_id = @me AND is_read = 0', { me: req.user.id }),
    count('SELECT CAST(COALESCE(MAX(id), 0) AS INTEGER) AS n FROM messages WHERE recipient_id = @me', { me: req.user.id }),
    count('SELECT CAST(COALESCE(MAX(id), 0) AS INTEGER) AS n FROM notifications WHERE user_id = @me', { me: req.user.id }),
  ]);
  res.json({ ...req.user, onboarded: !!req.user.onboarded, unread, unread_messages, last_msg, last_note });
}));

app.post('/api/me/onboarded', auth, route(async (req, res) => {
  await db.run('UPDATE users SET onboarded = 1 WHERE id = @id', { id: req.user.id });
  res.json({ ok: true });
}));

const LIFE = ['family', 'career', 'growth', 'creativity', 'fun', 'travel', 'knowledge', 'health'];
const PEOPLE = ['kindness', 'humor', 'mind', 'honesty', 'courage', 'beauty', 'loyalty'];
const RELS = ['', 'single', 'dating', 'engaged', 'married', 'complicated', 'searching', 'inlove'];
const cleanTags = (v) => [...new Set(String(v || '').split(/[,\s]+/).map((t) => t.replace(/^#/, '').toLowerCase()).filter((t) => /^[\p{L}\d_]{1,30}$/u.test(t)))].slice(0, 8).join(',');
function cleanSite(v) {
  v = clean(v, 100); if (!v) return '';
  if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
  try { const u = new URL(v); return /^https?:$/.test(u.protocol) && u.hostname.includes('.') ? u.href.slice(0, 120) : ''; } catch { return ''; }
}
const profileUpload = upload.fields([{ name: 'avatar', maxCount: 1 }, { name: 'cover', maxCount: 1 }]);
app.put('/api/me', auth, (req, res, next) => profileUpload(req, res, (e) => next(e)), route(async (req, res) => {
  const b = req.body, f = req.files || {};
  const name = clean(b.name, 40) || req.user.username, bio = clean(b.bio, 160);
  let avatar = req.user.avatar, cover = req.user.cover;
  if (f.avatar?.[0]) { const url = await saveImage(f.avatar[0]); await storage.remove(avatar); avatar = url; }
  if (f.cover?.[0]) { const url = await saveImage(f.cover[0]); await storage.remove(cover); cover = url; }
  else if (b.remove_cover === '1' && cover) { await storage.remove(cover); cover = null; }
  const has = (k) => b[k] !== undefined; // поля, которых нет в запросе (мастер регистрации), не трогаем
  const u = {
    gender: has('gender') ? (['m', 'f'].includes(b.gender) ? b.gender : '') : req.user.gender,
    relationship: has('relationship') ? (RELS.includes(b.relationship) ? b.relationship : '') : req.user.relationship,
    partner: has('partner') ? clean(b.partner, 20).replace(/^@/, '').replace(/[^A-Za-z0-9_]/g, '') : req.user.partner,
    website: has('website') ? cleanSite(b.website) : req.user.website,
    telegram: has('telegram') ? (clean(b.telegram, 60).replace(/^(https?:\/\/)?(t\.me\/|telegram\.me\/)?@?/i, '').match(/^[A-Za-z0-9_]{5,32}$/)?.[0] || '') : req.user.telegram,
    life_main: has('life_main') ? (LIFE.includes(b.life_main) ? b.life_main : '') : req.user.life_main,
    people_main: has('people_main') ? (PEOPLE.includes(b.people_main) ? b.people_main : '') : req.user.people_main,
    interests: has('interests') ? cleanTags(b.interests) : req.user.interests,
  };
  if (!u.relationship || ['single', 'searching'].includes(u.relationship)) u.partner = '';
  await db.run(`UPDATE users SET name = @name, bio = @bio, avatar = @avatar, cover = @cover, gender = @gender, relationship = @relationship, partner = @partner,
    website = @website, telegram = @telegram, life_main = @life_main, people_main = @people_main, interests = @interests WHERE id = @id`, { name, bio, avatar, cover, ...u, id: req.user.id });
  res.json({ ...req.user, onboarded: !!req.user.onboarded, name, bio, avatar, cover, ...u });
}));

// ---------- уведомления ----------
async function mentionedUsers(text) {
  const names = [...new Set((text.match(/(?:^|\s)@([A-Za-z0-9_]{3,20})/g) || []).map((m) => m.trim().slice(1).toLowerCase()))].slice(0, 5);
  if (!names.length) return [];
  const params = {}; names.forEach((n, i) => (params['m' + i] = n));
  return db.all(`SELECT id, username FROM users WHERE lower(username) IN (${names.map((_, i) => '@m' + i).join(',')})`, params);
}

async function notify(actor, userId, type, postId, text = '') {
  if (userId === actor.id) return;
  if (type === 'like' || type === 'follow' || type === 'repost') { // не спамим повторными лайками/подписками
    if (await db.get('SELECT 1 AS x FROM notifications WHERE user_id = @u AND actor_id = @a AND type = @t AND post_id = @p', { u: userId, a: actor.id, t: type, p: postId })) return;
  }
  const snippet = text.slice(0, 90), created_at = now();
  const id = await db.insert('INSERT INTO notifications (user_id, actor_id, type, post_id, text, created_at) VALUES (@u,@a,@t,@p,@x,@c)',
    { u: userId, a: actor.id, t: type, p: postId, x: snippet, c: created_at });
  const post = postId ? await db.get('SELECT text, image FROM posts WHERE id = @p', { p: postId }) : null;
  const post_text = post ? post.text.slice(0, 90) : '', post_image = post ? post.image : null;
  emit(userId, 'notification', { id, type, post_id: postId, text: snippet, post_text, post_image, created_at, is_read: 0, username: actor.username, name: actor.name, avatar: actor.avatar, gender: actor.gender || '' });
  push.notifyUser(userId, {
    title: actor.name || actor.username, body: `${noteVerb(type, actor.gender)}${snippet || post_text ? ': ' + (snippet || post_text) : ''}`,
    url: type === 'follow' ? '#/u/' + actor.username : '#/post/' + postId, tag: `n-${type}-${postId}`, icon: actor.avatar || '/icon-192.png',
  }).catch(() => {});
}
const NOTE_PUSH = {
  like: ['нравится ваш пост'], comment: ['прокомментировал(а) ваш пост', 'прокомментировал ваш пост', 'прокомментировала ваш пост'],
  reply: ['ответил(а) на ваш комментарий', 'ответил на ваш комментарий', 'ответила на ваш комментарий'],
  follow: ['подписался(ась) на вас', 'подписался на вас', 'подписалась на вас'], mention: ['упомянул(а) вас', 'упомянул вас', 'упомянула вас'],
  repost: ['сделал(а) репост вашего поста', 'сделал репост вашего поста', 'сделала репост вашего поста'],
};
const noteVerb = (type, g) => { const v = NOTE_PUSH[type]; return v ? (v.length === 1 ? v[0] : v[g === 'm' ? 1 : g === 'f' ? 2 : 0]) : ''; };

const NOTE_FILTERS = { mentions: "('mention','reply','comment')", likes: "('like','repost')", follows: "('follow')" };
const NOTE_COLS = 'n.id, n.type, n.post_id, n.text, n.created_at, n.is_read, u.username, u.name, u.avatar, p.text AS post_text, p.image AS post_image, u.gender';
app.get('/api/notifications', auth, route(async (req, res) => {
  const f = NOTE_FILTERS[req.query.type], LIM = 30;
  const rows = await db.all(`SELECT ${NOTE_COLS} FROM notifications n JOIN users u ON u.id = n.actor_id LEFT JOIN posts p ON p.id = n.post_id AND n.post_id > 0
    WHERE n.user_id = @me AND n.id < @before ${f ? 'AND n.type IN ' + f : ''} ORDER BY n.id DESC LIMIT ${LIM + 1}`, { me: req.user.id, before: cursorOf(req) });
  const items = rows.slice(0, LIM).map((i) => ({ ...i, post_text: (i.post_text || '').slice(0, 90) }));
  res.json({ items, more: rows.length > LIM });
}));
app.post('/api/notifications/read', auth, route(async (req, res) => {
  await db.run('UPDATE notifications SET is_read = 1 WHERE user_id = @me AND is_read = 0', { me: req.user.id });
  res.json({ ok: true });
}));

// Запасной канал: клиент опрашивает его, если поток событий (SSE) не работает из-за прокси.
const limitUpdates = limiter(300, 60 * 1000, 'Слишком часто. Подождите минуту');
app.get('/api/updates', auth, limitUpdates, route(async (req, res) => {
  const me = req.user.id, msg = parseInt(req.query.msg) || 0, note = parseInt(req.query.note) || 0;
  const [messages, notes] = await Promise.all([
    db.all(`SELECT m.id, m.text, m.image, m.created_at, u.username, u.name, u.avatar FROM messages m JOIN users u ON u.id = m.sender_id
      WHERE m.recipient_id = @me AND m.id > @msg ORDER BY m.id LIMIT 50`, { me, msg }),
    db.all(`SELECT ${NOTE_COLS} FROM notifications n
      JOIN users u ON u.id = n.actor_id LEFT JOIN posts p ON p.id = n.post_id AND n.post_id > 0 WHERE n.user_id = @me AND n.id > @note ORDER BY n.id LIMIT 50`, { me, note }),
  ]);
  res.json({ messages, notes });
}));

// ---------- push-подписки браузера ----------
app.get('/api/push/key', auth, (req, res) => res.json({ key: push.publicKey() }));
app.post('/api/push/subscribe', auth, limitWrites, route(async (req, res) => {
  const s = req.body || {}, k = s.keys || {};
  if (typeof s.endpoint !== 'string' || !/^https:\/\//.test(s.endpoint) || s.endpoint.length > 1000 || typeof k.p256dh !== 'string' || typeof k.auth !== 'string' || k.p256dh.length > 200 || k.auth.length > 100)
    throw new HttpError(400, 'Некорректная подписка');
  await db.run('DELETE FROM push_subscriptions WHERE endpoint = @e', { e: s.endpoint });
  await db.run('INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at) VALUES (@u,@e,@p,@a,@c)', { u: req.user.id, e: s.endpoint, p: k.p256dh, a: k.auth, c: now() });
  res.json({ ok: true });
}));
app.post('/api/push/unsubscribe', auth, route(async (req, res) => {
  await db.run('DELETE FROM push_subscriptions WHERE endpoint = @e AND user_id = @u', { e: String(req.body.endpoint || ''), u: req.user.id });
  res.json({ ok: true });
}));

app.post('/api/stream-ticket', auth, (req, res) => {
  const ticket = crypto.randomBytes(24).toString('hex');
  tickets.set(ticket, { id: req.user.id, exp: Date.now() + 30000 });
  res.json({ ticket });
});
app.get('/api/stream', (req, res) => {
  const t = tickets.get(String(req.query.ticket));
  tickets.delete(String(req.query.ticket));
  if (!t || t.exp < Date.now()) return res.status(401).end();
  // Connection: keep-alive не ставим: в HTTP/2 этот заголовок запрещён, а прокси платформ почти всегда говорят по HTTP/2
  res.set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  // заполнитель пробивает прокси, которые копят первые килобайты ответа; hb — пульс, по нему клиент понимает, что поток живой
  res.write(`: ${' '.repeat(2048)}\n\nretry: 5000\n\nevent: hb\ndata: 1\n\n`);
  const set = clients.get(t.id) || new Set(); clients.set(t.id, set);
  if (set.size >= 5) { const old = set.values().next().value; old.end(); set.delete(old); }
  set.add(res);
  const beat = setInterval(() => res.write('event: hb\ndata: 1\n\n'), 15000);
  req.on('close', () => { clearInterval(beat); set.delete(res); if (!set.size) clients.delete(t.id); });
});

// ---------- посты ----------
// Репост — это строка в posts с repost_of. Для клиента такая запись выглядит как оригинал
// (id, текст, счётчики — от оригинала) + пометка reposted_by. cur — курсор для пагинации.
const EID = 'COALESCE(p.repost_of, p.id)';
const cnt = (sql) => `(SELECT CAST(COUNT(*) AS INTEGER) FROM ${sql})`;
const POST_COLS = `${EID} AS id, COALESCE(o.text, p.text) AS text, COALESCE(o.image, p.image) AS image,
  COALESCE(o.created_at, p.created_at) AS created_at, u.username, u.name, u.avatar,
  CASE WHEN p.repost_of IS NULL THEN NULL ELSE ru.username END AS reposted_by,
  CASE WHEN p.repost_of IS NULL THEN NULL ELSE ru.name END AS reposted_by_name,
  ${cnt(`likes l WHERE l.post_id = ${EID}`)} AS likes,
  ${cnt(`comments c WHERE c.post_id = ${EID}`)} AS comments,
  ${cnt(`posts r WHERE r.repost_of = ${EID}`)} AS reposts,
  EXISTS(SELECT 1 FROM likes l WHERE l.post_id = ${EID} AND l.user_id = @me) AS liked,
  EXISTS(SELECT 1 FROM posts r WHERE r.repost_of = ${EID} AND r.user_id = @me) AS reposted,
  EXISTS(SELECT 1 FROM bookmarks b WHERE b.post_id = ${EID} AND b.user_id = @me) AS bookmarked`;
const POST_JOINS = 'LEFT JOIN posts o ON o.id = p.repost_of JOIN users u ON u.id = COALESCE(o.user_id, p.user_id) JOIN users ru ON ru.id = p.user_id';
function postSql({ from = 'posts p', where = '', order = 'ORDER BY p.id DESC', cur = 'p.id' } = {}) {
  return `SELECT ${POST_COLS}, ${cur} AS cur FROM ${from} ${POST_JOINS} ${where} ${order}`;
}
const asPosts = (rows) => rows.map((r) => ({ ...r, liked: !!r.liked, reposted: !!r.reposted, bookmarked: !!r.bookmarked }));
const getPost = async (pid, me) => asPosts(await db.all(postSql({ where: 'WHERE p.id = @pid AND p.repost_of IS NULL' }), { me, pid }))[0];
const BEFORE_MAX = 2 ** 31 - 1;
const cursorOf = (req) => parseInt(req.query.before) || BEFORE_MAX;

// действия над репостом считаются действиями над оригиналом
async function origPost(rawId) {
  let p = await db.get('SELECT id, user_id, repost_of FROM posts WHERE id = @id', { id: +rawId || 0 });
  if (p && p.repost_of) p = await db.get('SELECT id, user_id, repost_of FROM posts WHERE id = @id', { id: p.repost_of });
  if (!p) throw new HttpError(404, 'Пост не найден');
  return p;
}

// ---------- хэштеги ----------
const TAG_RE = /(?:^|\s)#([\p{L}\d_]{1,50})/gu;
const extractTags = (t) => [...new Set([...t.matchAll(TAG_RE)].map((m) => m[1].toLowerCase()))].slice(0, 10);
async function saveTags(postId, text) {
  for (const tag of extractTags(text)) await db.run('INSERT INTO post_tags (post_id, tag) VALUES (@p,@t) ON CONFLICT DO NOTHING', { p: postId, t: tag });
}
async function backfillTags() { // один раз: теги для постов, написанных до появления хэштегов
  if (await count('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM post_tags', {})) return;
  for (const p of await db.all("SELECT id, text FROM posts WHERE repost_of IS NULL AND text LIKE '%#%'", {})) await saveTags(p.id, p.text);
}

function announce(user, entryId) { // баннер «новые посты» у онлайн-пользователей
  return db.all('SELECT follower_id FROM follows WHERE followee_id = @a', { a: user.id }).then((rows) => {
    const followers = new Set(rows.map((r) => r.follower_id));
    for (const uid of clients.keys()) if (uid !== user.id) emit(uid, 'post', { id: entryId, username: user.username, following: followers.has(uid) });
  });
}

app.get('/api/feed', auth, route(async (req, res) => {
  const where = req.query.scope === 'following'
    ? 'WHERE p.id < @before AND (p.user_id = @me OR p.user_id IN (SELECT followee_id FROM follows WHERE follower_id = @me))'
    : 'WHERE p.id < @before';
  res.json(asPosts(await db.all(`${postSql({ where })} LIMIT 20`, { me: req.user.id, before: cursorOf(req) })));
}));

// популярное: баллы = лайки + 2·репосты + комментарии (только оригинальные посты, с хотя бы одним откликом)
app.get('/api/popular', auth, route(async (req, res) => {
  const since = req.query.range === 'all' ? '' : new Date(Date.now() - 7 * 864e5).toISOString();
  const offset = Math.max(0, Math.min(parseInt(req.query.offset) || 0, 1000));
  const inner = postSql({ where: 'WHERE p.repost_of IS NULL AND p.created_at > @since', order: '' });
  res.json(asPosts(await db.all(`SELECT * FROM (${inner}) t WHERE (t.likes + t.reposts + t.comments) > 0
    ORDER BY (t.likes + t.reposts * 2 + t.comments) DESC, t.id DESC LIMIT 20 OFFSET @off`, { me: req.user.id, since, off: offset })));
}));

app.get('/api/trending', auth, route(async (req, res) => {
  const q = (since) => db.all(`SELECT t.tag, CAST(COUNT(*) AS INTEGER) AS n FROM post_tags t JOIN posts p ON p.id = t.post_id
    WHERE p.created_at > @since GROUP BY t.tag ORDER BY n DESC, t.tag LIMIT 10`, { since });
  let tags = await q(new Date(Date.now() - 7 * 864e5).toISOString());
  if (!tags.length) tags = await q('');
  res.json({ tags });
}));

app.get('/api/tags/:tag', auth, route(async (req, res) => {
  const tag = clean(req.params.tag, 50).replace(/^#/, '').toLowerCase();
  if (!tag) throw new HttpError(404, 'Тег не найден');
  const where = 'WHERE p.repost_of IS NULL AND p.id < @before AND p.id IN (SELECT post_id FROM post_tags WHERE tag = @tag)';
  const [total, posts] = await Promise.all([
    count('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM post_tags WHERE tag = @tag', { tag }),
    db.all(`${postSql({ where })} LIMIT 20`, { me: req.user.id, tag, before: cursorOf(req) }),
  ]);
  res.json({ tag, total, posts: asPosts(posts) });
}));

// ---------- закладки ----------
app.get('/api/bookmarks', auth, route(async (req, res) => {
  const q = postSql({ from: 'bookmarks b JOIN posts p ON p.id = b.post_id', where: 'WHERE b.user_id = @me AND b.id < @before', order: 'ORDER BY b.id DESC', cur: 'b.id' });
  res.json(asPosts(await db.all(`${q} LIMIT 20`, { me: req.user.id, before: cursorOf(req) })));
}));

app.post('/api/posts/:id/bookmark', auth, limitWrites, route(async (req, res) => {
  const post = await origPost(req.params.id);
  const del = await db.run('DELETE FROM bookmarks WHERE user_id = @u AND post_id = @p', { u: req.user.id, p: post.id });
  if (!del.changes) await db.run('INSERT INTO bookmarks (user_id, post_id, created_at) VALUES (@u,@p,@c) ON CONFLICT DO NOTHING', { u: req.user.id, p: post.id, c: now() });
  res.json({ bookmarked: !del.changes });
}));

// ---------- репосты ----------
app.post('/api/posts/:id/repost', auth, limitWrites, route(async (req, res) => {
  const post = await origPost(req.params.id);
  const del = await db.run('DELETE FROM posts WHERE user_id = @u AND repost_of = @o', { u: req.user.id, o: post.id });
  if (!del.changes) {
    await db.run("INSERT INTO posts (user_id, text, repost_of, created_at) VALUES (@u,'',@o,@c) ON CONFLICT DO NOTHING", { u: req.user.id, o: post.id, c: now() });
    notify(req.user, post.user_id, 'repost', post.id).catch(console.error);
    db.get('SELECT id FROM posts WHERE user_id = @u AND repost_of = @o', { u: req.user.id, o: post.id })
      .then((e) => e && announce(req.user, e.id)).catch(console.error);
  }
  res.json({ reposted: !del.changes, reposts: await count('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM posts WHERE repost_of = @o', { o: post.id }) });
}));

app.post('/api/posts', auth, limitWrites, upload.single('image'), route(async (req, res) => {
  const text = clean(req.body.text, 500);
  if (!text && !req.file) throw new HttpError(400, 'Напишите текст или добавьте картинку');
  const image = req.file ? await saveImage(req.file) : null;
  const id = await db.insert('INSERT INTO posts (user_id, text, image, created_at) VALUES (@u,@t,@i,@c)', { u: req.user.id, t: text, i: image, c: now() });
  await saveTags(id, text);
  const post = await getPost(id, req.user.id);
  res.json(post);
  (async () => { // уведомления и рассылка — уже после ответа
    for (const m of await mentionedUsers(text)) await notify(req.user, m.id, 'mention', id, text);
    await announce(req.user, id);
  })().catch((e) => console.error('post fanout:', e));
}));

app.get('/api/posts/:id', auth, route(async (req, res) => {
  const post = await getPost(+req.params.id || 0, req.user.id);
  if (!post) throw new HttpError(404, 'Пост не найден');
  const comments = await db.all(`SELECT c.id, c.parent_id, c.text, c.image, c.created_at, u.username, u.name, u.avatar
    FROM comments c JOIN users u ON u.id = c.user_id WHERE c.post_id = @p ORDER BY c.id`, { p: post.id });
  res.json({ post, comments });
}));

app.delete('/api/posts/:id', auth, route(async (req, res) => {
  const p = await db.get('SELECT id, image FROM posts WHERE id = @id AND user_id = @u', { id: +req.params.id || 0, u: req.user.id });
  if (!p) throw new HttpError(404, 'Пост не найден');
  await db.run('UPDATE users SET pinned_post = NULL WHERE pinned_post = @id', { id: p.id });
  await db.run('DELETE FROM posts WHERE id = @id', { id: p.id });
  await db.run('DELETE FROM notifications WHERE post_id = @id', { id: p.id });
  await storage.remove(p.image);
  res.json({ ok: true });
}));

app.post('/api/posts/:id/like', auth, limitWrites, route(async (req, res) => {
  const post = await origPost(req.params.id), id = post.id;
  const del = await db.run('DELETE FROM likes WHERE user_id = @u AND post_id = @p', { u: req.user.id, p: id });
  if (!del.changes) {
    await db.run('INSERT INTO likes (user_id, post_id) VALUES (@u,@p)', { u: req.user.id, p: id });
    notify(req.user, post.user_id, 'like', id).catch(console.error);
  }
  res.json({ liked: !del.changes, likes: await count('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM likes WHERE post_id = @p', { p: id }) });
}));

// закрепить пост (свой или чужой) в своём профиле; закреплён может быть один
app.post('/api/posts/:id/pin', auth, limitWrites, route(async (req, res) => {
  const post = await origPost(req.params.id);
  const pinned = req.user.pinned_post !== post.id;
  await db.run('UPDATE users SET pinned_post = @p WHERE id = @u', { p: pinned ? post.id : null, u: req.user.id });
  res.json({ pinned });
}));

app.post('/api/posts/:id/comments', auth, limitWrites, upload.single('image'), route(async (req, res) => {
  const text = clean(req.body.text, 300);
  if (!text && !req.file) throw new HttpError(400, 'Комментарий не может быть пустым');
  const post = await origPost(req.params.id), id = post.id;
  let parent = null, rootId = null;
  if (req.body.parent_id) {
    parent = await db.get('SELECT id, user_id, parent_id FROM comments WHERE id = @c AND post_id = @p', { c: +req.body.parent_id || 0, p: id });
    if (!parent) throw new HttpError(400, 'Комментарий, на который вы отвечаете, не найден');
    rootId = parent.parent_id || parent.id; // ветки в один уровень: ответ на ответ идёт в ту же ветку
  }
  const image = req.file ? await saveImage(req.file) : null, created_at = now();
  const cid = await db.insert('INSERT INTO comments (post_id, user_id, parent_id, text, image, created_at) VALUES (@p,@u,@r,@t,@i,@c)',
    { p: id, u: req.user.id, r: rootId, t: text, i: image, c: created_at });
  const comment = { id: cid, parent_id: rootId, text, image, created_at, username: req.user.username, name: req.user.name, avatar: req.user.avatar };
  res.json(comment);
  (async () => { // один получатель — одно уведомление: ответ важнее комментария, комментарий важнее упоминания
    const who = new Map([[post.user_id, 'comment']]);
    if (parent) who.set(parent.user_id, 'reply');
    for (const m of await mentionedUsers(text)) if (!who.has(m.id)) who.set(m.id, 'mention');
    for (const [uid, type] of who) await notify(req.user, uid, type, id, text);
  })().catch((e) => console.error('comment fanout:', e));
}));

// ---------- профили, подписки, поиск ----------
app.get('/api/users/:username', auth, route(async (req, res) => {
  const u = await db.get('SELECT id, username, name, bio, avatar, created_at, gender, relationship, partner, website, telegram, life_main, people_main, interests, cover, pinned_post FROM users WHERE lower(username) = lower(@u)', { u: req.params.username });
  if (!u) throw new HttpError(404, 'Пользователь не найден');
  const before = cursorOf(req);
  const [posts, followers, following, isF, list] = await Promise.all([
    count('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM posts WHERE user_id = @id AND repost_of IS NULL', { id: u.id }),
    count('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM follows WHERE followee_id = @id', { id: u.id }),
    count('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM follows WHERE follower_id = @id', { id: u.id }),
    db.get('SELECT 1 AS x FROM follows WHERE follower_id = @me AND followee_id = @id', { me: req.user.id, id: u.id }),
    db.all(`${postSql({ where: 'WHERE p.user_id = @uid AND p.id < @before' })} LIMIT 20`, { me: req.user.id, uid: u.id, before }),
  ]);
  const pinned = !req.query.before && u.pinned_post ? await getPost(u.pinned_post, req.user.id) : null;
  const partner = u.partner ? await db.get('SELECT username, name FROM users WHERE lower(username) = lower(@p)', { p: u.partner }) : null;
  const { pinned_post, ...pub } = u;
  res.json({ user: { ...pub, partner: partner || (u.partner ? { username: '', name: u.partner } : null), posts, followers, following, isFollowing: !!isF }, posts: asPosts(list), pinned });
}));

app.post('/api/users/:username/follow', auth, limitWrites, route(async (req, res) => {
  const u = await db.get('SELECT id FROM users WHERE lower(username) = lower(@u)', { u: req.params.username });
  if (!u) throw new HttpError(404, 'Пользователь не найден');
  if (u.id === req.user.id) throw new HttpError(400, 'Нельзя подписаться на себя');
  const del = await db.run('DELETE FROM follows WHERE follower_id = @a AND followee_id = @b', { a: req.user.id, b: u.id });
  if (!del.changes) {
    await db.run('INSERT INTO follows (follower_id, followee_id) VALUES (@a,@b)', { a: req.user.id, b: u.id });
    notify(req.user, u.id, 'follow', 0).catch(console.error);
  }
  res.json({ isFollowing: !del.changes, followers: await count('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM follows WHERE followee_id = @id', { id: u.id }) });
}));

app.get('/api/suggestions', auth, route(async (req, res) => {
  res.json(await db.all(`SELECT username, name, avatar FROM users
    WHERE id != @me AND id NOT IN (SELECT followee_id FROM follows WHERE follower_id = @me)
    ORDER BY (SELECT COUNT(*) FROM follows f WHERE f.followee_id = users.id) DESC, id DESC LIMIT @lim`,
    { me: req.user.id, lim: Math.max(1, Math.min(parseInt(req.query.limit) || 5, 20)) }));
}));

app.get('/api/search', auth, route(async (req, res) => {
  const q = clean(req.query.q, 50);
  if (!q) return res.json({ users: [], posts: [] });
  const like = '%' + q.replace(/[\\%_]/g, '\\$&') + '%';
  res.json({
    users: await db.all("SELECT username, name, avatar, bio FROM users WHERE lower(username) LIKE lower(@l) ESCAPE '\\' OR lower(name) LIKE lower(@l) ESCAPE '\\' OR lower(interests) LIKE lower(@l) ESCAPE '\\' LIMIT 20", { l: like }),
    posts: asPosts(await db.all(`${postSql({ where: "WHERE p.repost_of IS NULL AND lower(p.text) LIKE lower(@q) ESCAPE '\\'" })} LIMIT 30`, { me: req.user.id, q: like })),
  });
}));

// ---------- личные сообщения ----------
const userByName = async (name) => {
  const u = await db.get('SELECT id, username, name, avatar FROM users WHERE lower(username) = lower(@u)', { u: String(name) });
  if (!u) throw new HttpError(404, 'Пользователь не найден');
  return u;
};
const PAIR = '((sender_id = @me AND recipient_id = @u) OR (sender_id = @u AND recipient_id = @me))';

async function markRead(me, peer) { // прочитано всё входящее от peer; отправителю уходит событие
  const r = await db.run('UPDATE messages SET is_read = 1 WHERE sender_id = @u AND recipient_id = @me AND is_read = 0', { me: me.id, u: peer.id });
  if (r.changes) emit(peer.id, 'read', { username: me.username });
  return r.changes;
}

app.get('/api/conversations', auth, route(async (req, res) => {
  const rows = await db.all(`SELECT u.username, u.name, u.avatar, m.text, m.image, m.created_at, (m.sender_id = @me) AS mine,
      ${cnt('messages x WHERE x.sender_id = u.id AND x.recipient_id = @me AND x.is_read = 0')} AS unread
    FROM users u JOIN messages m ON m.id = (SELECT MAX(id) FROM messages WHERE (sender_id = @me AND recipient_id = u.id) OR (sender_id = u.id AND recipient_id = @me))
    WHERE u.id IN (SELECT recipient_id FROM messages WHERE sender_id = @me UNION SELECT sender_id FROM messages WHERE recipient_id = @me)
    ORDER BY m.id DESC LIMIT 50`, { me: req.user.id });
  res.json(rows.map((r) => ({ ...r, mine: !!r.mine })));
}));

app.get('/api/messages/:username', auth, route(async (req, res) => {
  const u = await userByName(req.params.username);
  const rows = await db.all(`SELECT m.id, m.sender_id, m.text, m.image, m.created_at, m.is_read, m.reply_to, r.text AS rtext, r.image AS rimage, r.sender_id AS rsender
    FROM messages m LEFT JOIN messages r ON r.id = m.reply_to
    WHERE m.id < @before AND ((m.sender_id = @me AND m.recipient_id = @u) OR (m.sender_id = @u AND m.recipient_id = @me)) ORDER BY m.id DESC LIMIT 30`,
    { me: req.user.id, u: u.id, before: cursorOf(req) });
  if (!req.query.before) await markRead(req.user, u);
  res.json({
    user: { username: u.username, name: u.name, avatar: u.avatar },
    messages: rows.reverse().map((m) => ({ id: m.id, text: m.text, image: m.image, created_at: m.created_at, mine: m.sender_id === req.user.id, is_read: m.sender_id === req.user.id ? +m.is_read : 1,
      reply: m.reply_to && m.rsender ? { id: m.reply_to, text: m.rtext, image: m.rimage, mine: m.rsender === req.user.id } : null })),
    more: rows.length === 30,
  });
}));

app.post('/api/messages/:username/read', auth, route(async (req, res) => {
  await markRead(req.user, await userByName(req.params.username));
  res.json({ ok: true });
}));

app.post('/api/messages/:username', auth, limitWrites, upload.single('image'), route(async (req, res) => {
  const u = await userByName(req.params.username), text = clean(req.body.text, 2000);
  if (u.id === req.user.id) throw new HttpError(400, 'Нельзя написать самому себе');
  if (!text && !req.file) throw new HttpError(400, 'Сообщение не может быть пустым');
  const image = req.file ? await saveImage(req.file) : null, created_at = now();
  const rep = +req.body.reply_to ? await db.get('SELECT id, text, image, sender_id FROM messages WHERE id = @i AND ((sender_id = @a AND recipient_id = @b) OR (sender_id = @b AND recipient_id = @a))', { i: +req.body.reply_to, a: req.user.id, b: u.id }) : null;
  const id = await db.insert('INSERT INTO messages (sender_id, recipient_id, text, image, reply_to, created_at) VALUES (@s,@r,@t,@i,@rt,@c)', { s: req.user.id, r: u.id, t: text, i: image, rt: rep ? rep.id : null, c: created_at });
  const reply = rep ? { id: rep.id, text: rep.text, image: rep.image, mine: rep.sender_id === req.user.id } : null;
  emit(u.id, 'message', { id, text, image, reply: rep ? { ...reply, mine: !reply.mine } : null, created_at, username: req.user.username, name: req.user.name, avatar: req.user.avatar });
  push.notifyUser(u.id, { title: req.user.name || req.user.username, body: text || '📷 Фото', url: '#/messages/' + req.user.username, tag: 'msg-' + req.user.username, icon: req.user.avatar || '/icon-192.png' }).catch(() => {});
  res.json({ id, text, image, reply, created_at, mine: true, is_read: 0 });
}));

app.delete('/api/messages/:id', auth, route(async (req, res) => {
  const m = await db.get('SELECT id, image, recipient_id FROM messages WHERE id = @i AND sender_id = @u', { i: +req.params.id || 0, u: req.user.id });
  if (!m) throw new HttpError(404, 'Сообщение не найдено');
  await db.run('DELETE FROM messages WHERE id = @i', { i: m.id });
  await storage.remove(m.image);
  emit(m.recipient_id, 'msgdel', { id: m.id });
  res.json({ ok: true });
}));

// ---------- служебное и статика ----------
app.get('/healthz', route(async (req, res) => { await db.get('SELECT 1 AS ok', {}); res.json({ ok: true }); }));
app.use('/uploads', express.static(storage.UPLOADS, { maxAge: '7d', immutable: true }));
app.get('/sw.js', (req, res) => { res.set('Cache-Control', 'no-cache'); res.type('js').sendFile(path.join(__dirname, 'public', 'sw.js')); });
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
app.use('/api', (req, res) => res.status(404).json({ error: 'Не найдено' }));
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Файл больше 5 МБ' : 'Не удалось загрузить файл' });
  console.error(err);
  res.status(500).json({ error: 'Ошибка сервера. Попробуйте ещё раз' });
});

let server;
db.init().then(push.init).then(backfillTags).then(() => {
  server = app.listen(PORT, () => console.log(`Kolo запущен: http://localhost:${PORT} (${db.kind})`));
}).catch((e) => { console.error('Не удалось запустить:', e); process.exit(1); });

function shutdown() {
  for (const set of clients.values()) for (const r of set) r.end();
  (server ? new Promise((r) => server.close(r)) : Promise.resolve()).then(() => db.close()).finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

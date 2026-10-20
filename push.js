// Web Push без внешних зависимостей: VAPID (RFC 8292) + шифрование aes128gcm (RFC 8291) на встроенном crypto.
// Ключи VAPID хранятся в таблице kv — поэтому переживают перезапуск и переезд между серверами вместе с базой.
const crypto = require('crypto');
const { db } = require('./db');

const b64u = (b) => Buffer.from(b).toString('base64url');
const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';

let keys = null; // { priv: KeyObject, pub: Buffer(65), pubB64 }

async function init() {
  let row = await db.get("SELECT v FROM kv WHERE k = 'vapid'", {});
  let jwk;
  if (process.env.VAPID_PRIVATE_JWK) jwk = JSON.parse(process.env.VAPID_PRIVATE_JWK);
  else if (row) jwk = JSON.parse(row.v);
  else {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    jwk = privateKey.export({ format: 'jwk' });
    await db.run("INSERT INTO kv (k, v) VALUES ('vapid', @v) ON CONFLICT DO NOTHING", { v: JSON.stringify(jwk) });
    row = await db.get("SELECT v FROM kv WHERE k = 'vapid'", {}); // если два экземпляра стартовали одновременно — берём победителя
    jwk = JSON.parse(row.v);
  }
  const priv = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
  const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  keys = { priv, pub, pubB64: b64u(pub) };
}

const publicKey = () => keys && keys.pubB64;

function vapidHeader(endpoint) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SUBJECT }));
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key: keys.priv, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${keys.pubB64}`;
}

// шифрование тела по RFC 8291; uaPublic — p256dh подписки (65 байт), authSecret — 16 байт
function encrypt(payload, uaPublic, authSecret) {
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(uaPublic);
  const salt = crypto.randomBytes(16);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const data = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, data]);
}

// отправка одной подписки; true — доставлено в службу push, false — подписка мертва (её надо удалить)
async function send(sub, payload) {
  const body = encrypt(JSON.stringify(payload), Buffer.from(sub.p256dh, 'base64url'), Buffer.from(sub.auth, 'base64url'));
  const r = await fetch(sub.endpoint, {
    method: 'POST', body, signal: AbortSignal.timeout(10000),
    headers: { Authorization: vapidHeader(sub.endpoint), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'normal' },
  });
  if (r.status === 404 || r.status === 410) return false;
  if (!r.ok) throw new Error('push ' + r.status);
  return true;
}

async function notifyUser(userId, payload) {
  if (!keys) return;
  const subs = await db.all('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = @u', { u: userId });
  await Promise.all(subs.map(async (s) => {
    try { if (!(await send(s, payload))) await db.run('DELETE FROM push_subscriptions WHERE id = @id', { id: s.id }); }
    catch (e) { console.error('push:', e.message); }
  }));
}

module.exports = { init, publicKey, notifyUser, encrypt, vapidHeader };

import { DurableObject } from 'cloudflare:workers';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const WINDOW = 15 * 60_000;
const COOKIE = 'regalo_session';
const USER_SESSION = 60 * DAY;
const ADMIN_SESSION = 30 * DAY;
const encoder = new TextEncoder();
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }
});
const hash = async s => [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(s)))].map(b => b.toString(16).padStart(2, '0')).join('');
const equal = (a, b) => { let n = a.length ^ b.length; for (let i = 0; i < a.length; i++) n |= a.charCodeAt(i) ^ (b.charCodeAt(i) || 0); return n === 0; };
const cookie = (token, ageSeconds) => `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${ageSeconds}`;
const tokenFrom = req => req.headers.get('Cookie')?.split(';').map(v => v.trim()).find(v => v.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1) || '';
const clearCookie = () => ({ 'Set-Cookie': cookie('', 0) });
const validDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
const validName = s => typeof s === 'string' && s.trim().length >= 1 && s.trim().length <= 60;
const validPin = s => typeof s === 'string' && /^\d{4,8}$/.test(s);
const validLink = s => s === '' || (typeof s === 'string' && s.length <= 500 && /^https:\/\//.test(s));
const MADRID = 'Europe/Madrid';
const madridWall = utc => new Date(utc).toLocaleString('sv-SE', { timeZone: MADRID }).replace(' ', 'T');
const utcFromMadridWall = wall => { const guess = Date.parse(wall + 'Z'); const off = u => Date.parse(madridWall(u) + 'Z') - u; return guess - off(guess - off(guess)); };
// Fin del día (23:59) y una hora concreta de Madrid en UTC
const endOfDayMadrid = dateStr => utcFromMadridWall(dateStr + 'T23:59:00');
const atHourMadrid = (dateStr, hh) => utcFromMadridWall(dateStr + 'T' + String(hh).padStart(2, '0') + ':00:00');
const addDays = (dateStr, n) => { const d = new Date(dateStr + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// ===== Web Push (RFC 8290 VAPID + RFC 8291 aes128gcm, sin dependencias externas) =====
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64uDec = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const concatBytes = (...arrs) => { const out = new Uint8Array(arrs.reduce((t, a) => t + a.length, 0)); let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; } return out; };
const hmac = async (key, data) => new Uint8Array(await crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), data));
export async function vapidJwt(privJwk, aud, sub) {
  const key = await crypto.subtle.importKey('jwk', privJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const b64json = o => b64u(encoder.encode(JSON.stringify(o)));
  const input = `${b64json({ typ: 'JWT', alg: 'ES256' })}.${b64json({ aud, exp: Math.floor(Date.now() / 1000) + 43200, sub })}`;
  return `${input}.${b64u(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(input)))}`;
}
export async function encryptPush(p256dhB64, authB64, plaintext, ephemeral, saltBytes) {
  const uaPub = b64uDec(p256dhB64);
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const asKey = ephemeral || await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', asKey.publicKey));
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKey.privateKey, 256));
  const prkKey = await hmac(b64uDec(authB64), shared);
  const ikm = await hmac(prkKey, concatBytes(encoder.encode('WebPush: info\0'), uaPub, asPub, new Uint8Array([1])));
  const salt = saltBytes || crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const info = enc => concatBytes(encoder.encode(`Content-Encoding: ${enc}\0`), new Uint8Array([1]));
  const cek = (await hmac(prk, info('aes128gcm'))).slice(0, 16);
  const nonce = (await hmac(prk, info('nonce'))).slice(0, 12);
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, concatBytes(encoder.encode(plaintext), new Uint8Array([2]))));
  const rs = new Uint8Array(4); new DataView(rs.buffer).setUint32(0, 4096);
  return concatBytes(salt, rs, new Uint8Array([asPub.length]), asPub, cipher);
}

// Reparto sin auto-regalos y sin repetir parejas del año pasado (por nombre).
// Backtracking con azar; devuelve Map(giverId -> targetId) o null si no hay combinación.
export function hacerSorteo(users, lastYearPairs) {
  if (!Array.isArray(users) || users.length < 2) return null;
  const byName = new Map(users.map(u => [u.name.trim().toLowerCase(), u.id]));
  const banned = new Map(); // giverId -> Set(targetId)
  const ban = (g, t) => { if (!banned.has(g)) banned.set(g, new Set()); banned.get(g).add(t); };
  for (const u of users) ban(u.id, u.id);
  for (const pair of lastYearPairs || []) {
    const g = byName.get(String(pair[0] || '').trim().toLowerCase());
    const t = byName.get(String(pair[1] || '').trim().toLowerCase());
    if (g && t) ban(g, t);
  }
  const rand = n => crypto.getRandomValues(new Uint32Array(1))[0] % n;
  const givers = [...users].sort(() => rand(2) - 1);
  const taken = new Set();
  const result = new Map();
  const options = g => users.filter(u => u.id !== g.id && !(banned.get(g.id) || new Set()).has(u.id) && !taken.has(u.id));
  const step = i => {
    if (i === givers.length) return true;
    let opts = options(givers[i]);
    for (let j = opts.length - 1; j > 0; j--) { const k = rand(j + 1); [opts[j], opts[k]] = [opts[k], opts[j]]; }
    for (const t of opts) {
      taken.add(t.id); result.set(givers[i].id, t.id);
      if (step(i + 1)) return true;
      taken.delete(t.id); result.delete(givers[i].id);
    }
    return false;
  };
  return step(0) ? result : null;
}

export function validateWishlist(input) {
  if (!Array.isArray(input) || input.length > 20) throw Error('La lista admite hasta 20 deseos');
  return input.map(item => {
    const text = typeof item?.text === 'string' ? item.text.trim() : '';
    if (!text || text.length > 200) throw Error('Cada deseo debe tener entre 1 y 200 caracteres');
    const link = typeof item?.link === 'string' ? item.link.trim() : '';
    if (!validLink(link)) throw Error('Los enlaces deben empezar por https://');
    return { id: crypto.randomUUID(), text, link };
  });
}
const publicCfg = cfg => ({ appName: cfg.appName, budget: cfg.budget, joinDeadline: cfg.joinDeadline, giftDate: cfg.giftDate, drawn: !!cfg.drawnAt });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) {
      try { return await env.SORTEO.get(env.SORTEO.idFromName('regalo-invisible-v1')).fetch(req); }
      catch { return json({ error: 'Servicio temporalmente no disponible. Inténtalo de nuevo.' }, 503); }
    }
    const response = await env.ASSETS.fetch(req);
    const headers = new Headers(response.headers);
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'no-referrer');
    headers.set('X-Frame-Options', 'DENY');
    headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; connect-src 'self'; img-src 'self' data:; font-src 'self' https://fonts.gstatic.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    return new Response(response.body, { status: response.status, headers });
  }
};

export class Sorteo extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.ctx = ctx; this.env = env; }

  async cfg() {
    let cfg = await this.ctx.storage.get('cfg:main');
    if (!cfg) {
      cfg = { appName: 'Amigo invisible FugaLos', budget: '10 €', joinDeadline: '2026-12-01', giftDate: '2026-12-31', createdAt: Date.now(), drawnAt: null };
      await this.ctx.storage.put('cfg:main', cfg);
    }
    return cfg;
  }
  async saveCfg(cfg) { await this.ctx.storage.put('cfg:main', cfg); await this.planAlarms(); }
  async users() { return new Map(await this.ctx.storage.list({ prefix: 'user:' })); }

  async scheduleAlarm() {
    const current = await this.ctx.storage.getAlarm();
    if (current == null || current > Date.now() + 60_000) await this.ctx.storage.setAlarm(Date.now() + 60_000);
  }
  async session(req) {
    const token = tokenFrom(req);
    if (!/^[a-f0-9]{64}$/.test(token)) return null;
    const key = 'session:' + await hash(token), session = await this.ctx.storage.get(key);
    if (!session || session.expiresAt <= Date.now()) return null;
    if (session.role === 'admin') {
      if (session.passwordHash !== await hash(this.env.ADMIN_PASSWORD || '')) return null;
    } else {
      const user = await this.ctx.storage.get('user:' + session.userId);
      if (!user || user.pinHash !== session.pinHash) return null;
    }
    return { ...session, key };
  }

  async fetch(req) {
    const url = new URL(req.url), path = url.pathname;
    if (typeof this.env.ADMIN_PASSWORD !== 'string' || this.env.ADMIN_PASSWORD.length < 8) return json({ error: 'Configura ADMIN_PASSWORD como secreto de al menos 8 caracteres antes de usar la app.' }, 503);
    if (req.method !== 'GET') {
      if (req.headers.get('Origin') !== url.origin) { await req.arrayBuffer(); return json({ error: 'Origen no permitido' }, 403); }
    }
    if (req.method === 'POST' && !req.headers.get('Content-Type')?.startsWith('application/json')) return json({ error: 'Se requiere JSON' }, 415);
    let body;
    if (req.method === 'POST') {
      if (Number(req.headers.get('Content-Length') || 0) > 8192) return json({ error: 'Petición demasiado grande' }, 413);
      const raw = await req.text();
      if (encoder.encode(raw).length > 8192) return json({ error: 'Petición demasiado grande' }, 413);
      try { body = JSON.parse(raw); } catch { return json({ error: 'JSON no válido' }, 400); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'JSON no válido' }, 400);
    }

    // Pantalla de entrada: solo nombres y datos públicos del sorteo, nada de PINs ni listas.
    if (path === '/api/names' && req.method === 'GET') {
      const cfg = await this.cfg();
      const users = [...(await this.users()).values()].map(u => ({ id: u.id, name: u.name, kid: !!u.kid }));
      return json({ ...publicCfg(cfg), users });
    }

    if (path === '/api/login' && req.method === 'POST') {
      const now = Date.now();
      const ip = await hash(req.headers.get('CF-Connecting-IP') || 'local');
      const rateKey = 'rate:' + ip;
      const allowed = await this.ctx.storage.transaction(async tx => {
        let rate = await tx.get(rateKey);
        if (!rate || rate.until <= now) rate = { count: 0, until: now + WINDOW };
        rate.count++;
        await tx.put(rateKey, rate);
        return rate.count <= 10;
      });
      await this.scheduleAlarm();
      if (!allowed) return json({ error: 'Demasiados intentos. Espera 15 minutos.' }, 429, { 'Retry-After': '900' });

      if (body.mode === 'admin') {
        const candidate = typeof body.password === 'string' && body.password.length <= 1024 ? body.password : '';
        if (!equal(await hash(candidate), await hash(this.env.ADMIN_PASSWORD))) return json({ error: 'Contraseña incorrecta' }, 401);
        const token = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');
        const session = { role: 'admin', expiresAt: now + ADMIN_SESSION, passwordHash: await hash(this.env.ADMIN_PASSWORD) };
        await this.ctx.storage.put('session:' + await hash(token), session);
        return json({ role: 'admin', expiresAt: session.expiresAt }, 200, { 'Set-Cookie': cookie(token, ADMIN_SESSION / 1000) });
      }

      const name = typeof body.name === 'string' ? body.name.trim().toLowerCase() : '';
      const pin = typeof body.pin === 'string' ? body.pin : '';
      const users = await this.users();
      const user = [...users.values()].find(u => u.name.trim().toLowerCase() === name);
      if (!user || !equal(await hash(pin), user.pinHash)) return json({ error: 'Nombre o PIN incorrectos' }, 401);
      user.joinedAt = user.joinedAt || now;
      await this.ctx.storage.put('user:' + user.id, user);
      const token = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');
      const session = { role: 'user', userId: user.id, expiresAt: now + USER_SESSION, pinHash: user.pinHash };
      await this.ctx.storage.put('session:' + await hash(token), session);
      return json({ role: 'user', expiresAt: session.expiresAt }, 200, { 'Set-Cookie': cookie(token, USER_SESSION / 1000) });
    }

    const session = await this.session(req);
    if (!session) return json({ error: 'Sesión caducada. Vuelve a entrar.' }, 401, clearCookie());
    if (path === '/api/session' && req.method === 'GET') return json({ role: session.role, expiresAt: session.expiresAt });
    if (path === '/api/logout' && req.method === 'POST') {
      await this.ctx.storage.delete(session.key);
      return json({ ok: true }, 200, clearCookie());
    }

    // ===== Participante =====
    if (session.role === 'user') {
      const cfg = await this.cfg();
      const user = await this.ctx.storage.get('user:' + session.userId);
      if (path === '/api/me' && req.method === 'GET') {
        const hint = cfg.drawnAt ? (await this.ctx.storage.get('hint:' + session.userId)) || null : null;
        return json({ role: 'user', ...publicCfg(cfg), name: user.name, kid: !!user.kid, wishlist: user.wishlist || [], hint });
      }
      if (path === '/api/wishlist' && req.method === 'POST') {
        let items;
        try { items = validateWishlist(body.items); } catch (e) { return json({ error: e.message }, 400); }
        user.wishlist = items;
        await this.ctx.storage.put('user:' + session.userId, user);
        return json({ ok: true, wishlist: items });
      }
      // Revelar es una acción explícita: queda marcado quién ha abierto su sobre.
      if (path === '/api/reveal' && req.method === 'POST') {
        if (!cfg.drawnAt) return json({ error: 'El sorteo todavía no se ha hecho' }, 409);
        const targetId = await this.ctx.storage.get('assign:' + session.userId);
        if (!targetId) return json({ error: 'No tienes asignación; habla con Gabri' }, 404);
        const target = await this.ctx.storage.get('user:' + targetId);
        if (!target) return json({ error: 'No tienes asignación; habla con Gabri' }, 404);
        if (!user.openedAt) { user.openedAt = Date.now(); await this.ctx.storage.put('user:' + session.userId, user); }
        return json({ name: target.name, kid: !!target.kid, wishlist: target.wishlist || [] });
      }
      // La pista anónima va del que regala al que recibe: se guarda en la ficha del destinatario.
      if (path === '/api/hint' && req.method === 'POST') {
        if (!cfg.drawnAt) return json({ error: 'El sorteo todavía no se ha hecho' }, 409);
        const targetId = await this.ctx.storage.get('assign:' + session.userId);
        if (!targetId) return json({ error: 'No tienes asignación; habla con Gabri' }, 404);
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        if (text.length > 200) return json({ error: 'La pista no puede superar 200 caracteres' }, 400);
        if (text) await this.ctx.storage.put('hint:' + targetId, { text, at: Date.now() });
        else await this.ctx.storage.delete('hint:' + targetId);
        return json({ ok: true });
      }
    }

    // ===== Organizador (Gabri) =====
    if (session.role === 'admin') {
      const cfg = await this.cfg();
      if (path === '/api/admin/state' && req.method === 'GET') {
        const users = [...(await this.users()).values()].map(u => ({
          id: u.id, name: u.name, kid: !!u.kid, pin: u.pin, joinedAt: u.joinedAt || null,
          wishes: (u.wishlist || []).length, openedAt: u.openedAt || null
        })).sort((a, b) => a.name.localeCompare(b.name, 'es'));
        const lastYear = (await this.ctx.storage.get('cfg:lastYear')) || [];
        return json({ role: 'admin', ...publicCfg(cfg), drawnAt: cfg.drawnAt, users, lastYear });
      }
      if (path === '/api/admin/config' && req.method === 'POST') {
        const appName = typeof body.appName === 'string' && body.appName.trim() && body.appName.trim().length <= 80 ? body.appName.trim() : cfg.appName;
        const budget = typeof body.budget === 'string' && body.budget.trim() && body.budget.trim().length <= 60 ? body.budget.trim() : cfg.budget;
        const joinDeadline = validDate(body.joinDeadline || '') ? body.joinDeadline : cfg.joinDeadline;
        const giftDate = validDate(body.giftDate || '') ? body.giftDate : cfg.giftDate;
        if (cfg.drawnAt && joinDeadline !== cfg.joinDeadline) return json({ error: 'El sorteo ya se hizo; la fecha de cierre queda como estaba' }, 409);
        await this.saveCfg({ ...cfg, appName, budget, joinDeadline, giftDate });
        return json({ ok: true });
      }
      if (path === '/api/admin/users' && req.method === 'POST') {
        if (!['add', 'remove', 'set-pin', 'set-kid'].includes(body.action)) return json({ error: 'Operación no válida' }, 400);
        if (body.action === 'add') {
          if (!validName(body.name)) return json({ error: 'Nombre de 1 a 60 caracteres' }, 400);
          if (!validPin(body.pin)) return json({ error: 'El PIN debe ser de 4 a 8 dígitos' }, 400);
          const users = await this.users();
          if (users.size >= 50) return json({ error: 'Máximo 50 participantes' }, 409);
          if ([...users.values()].some(u => u.name.trim().toLowerCase() === body.name.trim().toLowerCase())) return json({ error: 'Ya hay un participante con ese nombre' }, 409);
          if ([...users.values()].some(u => u.pin === body.pin)) return json({ error: 'Ese PIN ya lo tiene otro participante' }, 409);
          const id = crypto.randomUUID();
          await this.ctx.storage.put('user:' + id, { id, name: body.name.trim(), kid: body.kid === true, pin: body.pin, pinHash: await hash(body.pin), wishlist: [], joinedAt: null, openedAt: null });
          return json({ ok: true, id });
        }
        const user = typeof body.id === 'string' ? await this.ctx.storage.get('user:' + body.id) : null;
        if (!user) return json({ error: 'Participante no encontrado' }, 404);
        if (body.action === 'remove') {
          if (cfg.drawnAt) return json({ error: 'El sorteo ya se hizo; no se puede quitar a nadie' }, 409);
          await this.ctx.storage.delete('user:' + user.id);
          await this.ctx.storage.delete('hint:' + user.id);
          const sessions = await this.ctx.storage.list({ prefix: 'session:' });
          for (const [key, s] of sessions) if (s.userId === user.id) await this.ctx.storage.delete(key);
          return json({ ok: true });
        }
        if (body.action === 'set-pin') {
          if (!validPin(body.pin)) return json({ error: 'El PIN debe ser de 4 a 8 dígitos' }, 400);
          const users = await this.users();
          if ([...users.values()].some(u => u.id !== user.id && u.pin === body.pin)) return json({ error: 'Ese PIN ya lo tiene otro participante' }, 409);
          user.pin = body.pin;
          user.pinHash = await hash(body.pin); // invalida sus sesiones anteriores
          await this.ctx.storage.put('user:' + user.id, user);
          return json({ ok: true });
        }
        if (body.action === 'set-kid') {
          user.kid = body.kid === true;
          await this.ctx.storage.put('user:' + user.id, user);
          return json({ ok: true });
        }
      }
      if (path === '/api/admin/lastyear' && req.method === 'POST') {
        if (cfg.drawnAt) return json({ error: 'El sorteo ya se hizo; las parejas del año pasado quedan como estaban' }, 409);
        if (!Array.isArray(body.pairs) || body.pairs.length > 100) return json({ error: 'Lista de parejas no válida' }, 400);
        let pairs;
        try {
          pairs = body.pairs.map(p => {
            if (!Array.isArray(p) || p.length !== 2 || !validName(p[0]) || !validName(p[1])) throw Error();
            return [p[0].trim(), p[1].trim()];
          });
        } catch { return json({ error: 'Lista de parejas no válida' }, 400); }
        await this.ctx.storage.put('cfg:lastYear', pairs);
        return json({ ok: true });
      }
      if (path === '/api/admin/draw' && req.method === 'POST') {
        if (cfg.drawnAt) return json({ error: 'El sorteo ya se hizo el ' + new Date(cfg.drawnAt).toLocaleDateString('es-ES', { timeZone: MADRID }) }, 409);
        const result = await this.runDraw();
        if (result.error) return json({ error: result.error }, result.status);
        return json({ ok: true, drawnAt: result.drawnAt });
      }
      // Exportación manual: todo salvo asignaciones y pistas, para que el organizador no se las cuele.
      if (path === '/api/export' && req.method === 'GET') {
        const exportedAt = Date.now();
        const users = [...(await this.users()).values()].map(u => ({ name: u.name, kid: !!u.kid, wishlist: u.wishlist || [], joinedAt: u.joinedAt || null, openedAt: u.openedAt || null }));
        const payload = JSON.stringify({ app: 'regalo-invisible', exportedAt: new Date(exportedAt).toISOString(), config: publicCfg(cfg), parejasAnoPasado: (await this.ctx.storage.get('cfg:lastYear')) || [], participantes: users, nota: 'Sin asignaciones ni pistas: ni el organizador puede verlas.' }, null, 2);
        return new Response(payload, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="regalo-invisible-${new Date(exportedAt).toISOString().slice(0, 10)}.json"`, 'Cache-Control': 'no-store' } });
      }
    }

    // ===== Avisos push (cualquier sesión) =====
    if (path === '/api/push-key' && req.method === 'GET') return json({ key: (await this.vapid()).publicKey });
    if (path === '/api/push' && req.method === 'POST') {
      if (!['subscribe', 'unsubscribe'].includes(body.action)) return json({ error: 'Operación no válida' }, 400);
      if (body.action === 'unsubscribe') {
        const ep = typeof body.endpoint === 'string' ? body.endpoint : '';
        await this.ctx.storage.delete('pushsub:' + await hash(ep));
        return json({ ok: true });
      }
      const s = body.subscription, endpoint = s && typeof s.endpoint === 'string' ? s.endpoint : '', keys = (s && s.keys) || {};
      if (!/^https:\/\/.{1,480}$/.test(endpoint) || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string' || keys.p256dh.length > 200 || keys.auth.length > 100) return json({ error: 'Suscripción no válida' }, 400);
      if ((await this.ctx.storage.list({ prefix: 'pushsub:' })).size >= 50) return json({ error: 'Límite de dispositivos alcanzado' }, 409);
      await this.ctx.storage.put('pushsub:' + await hash(endpoint), { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } });
      await this.planAlarms();
      return json({ ok: true });
    }

    return json({ error: 'Ruta o método no permitido' }, 404);
  }

  async runDraw() {
    const cfg = await this.cfg();
    if (cfg.drawnAt) return { error: 'El sorteo ya está hecho' };
    const users = [...(await this.users()).values()];
    if (users.length < 2) return { status: 409, error: 'Hacen falta al menos 2 participantes' };
    const lastYear = (await this.ctx.storage.get('cfg:lastYear')) || [];
    const result = hacerSorteo(users, lastYear);
    if (!result) return { status: 409, error: 'No hay combinación posible sin repetir el año pasado. Revisa las parejas cargadas.' };
    for (const [giver, target] of result) await this.ctx.storage.put('assign:' + giver, target);
    cfg.drawnAt = Date.now();
    await this.ctx.storage.put('cfg:main', cfg);
    await this.pushAll('¡Ya está hecho el sorteo! 🎁', 'Abre tu sobre y descubre a quién le regalas.');
    await this.planAlarms();
    return { drawnAt: cfg.drawnAt };
  }

  async vapid() {
    let v = await this.ctx.storage.get('vapid');
    if (!v) {
      const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
      v = { publicKey: b64u(await crypto.subtle.exportKey('raw', pair.publicKey)), privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey) };
      await this.ctx.storage.put('vapid', v);
    }
    return v;
  }
  async pushAll(title, body) {
    const subs = await this.ctx.storage.list({ prefix: 'pushsub:' });
    if (!subs.size) return;
    const vapid = await this.vapid();
    for (const sub of subs.values()) {
      try {
        const jwt = await vapidJwt(vapid.privateJwk, new URL(sub.endpoint).origin, 'https://regalo-invisible.bodorrio.workers.dev');
        const payload = await encryptPush(sub.keys.p256dh, sub.keys.auth, JSON.stringify({ title, body }));
        const r = await fetch(sub.endpoint, { method: 'POST', headers: { Authorization: `vapid t=${jwt},k=${vapid.publicKey}`, 'Content-Encoding': 'aes128gcm', TTL: '86400', 'Content-Type': 'application/octet-stream' }, body: payload });
        if (r.status === 404 || r.status === 410) await this.ctx.storage.delete('pushsub:' + await hash(sub.endpoint));
      } catch { /* un dispositivo que falla no frena a los demás */ }
    }
  }
  // Próximas fechas con aviso: recordatorios fijos y el sorteo automático al cerrar el plazo.
  async nextEvents() {
    const cfg = await this.cfg();
    const events = [];
    if (!cfg.drawnAt) events.push({ at: endOfDayMadrid(cfg.joinDeadline), kind: 'draw' });
    const hasSubs = (await this.ctx.storage.list({ prefix: 'pushsub:', limit: 1 })).size > 0;
    if (hasSubs) {
      const today = new Date().toLocaleDateString('sv-SE', { timeZone: MADRID });
      const reminders = [
        { at: atHourMadrid(addDays(cfg.joinDeadline, -3), 10), title: 'Quedan 3 días 🎁', body: 'Apúntate y deja tu lista de deseos antes de que cierre el plazo.' },
        { at: atHourMadrid(cfg.joinDeadline, 9), title: 'Hoy cierra el plazo ✨', body: 'Último día para apuntarte y rellenar tu lista de deseos.' },
        { at: atHourMadrid(addDays(cfg.giftDate, -1), 10), title: '¡Mañana es el día! 🎁', body: 'Repasa la lista de deseos de tu amigo invisible.' },
        { at: atHourMadrid(cfg.giftDate, 10), title: '¡Hoy es el día del regalo! 🎉', body: 'Feliz Nochevieja. A disfrutar.' }
      ];
      for (const r of reminders) if (r.at > Date.now() && addDays(today, 0) <= cfg.giftDate) events.push({ ...r, kind: 'remind' });
    }
    return events.filter(e => e.at > Date.now() - 60_000).sort((a, b) => a.at - b.at);
  }
  async planAlarms() {
    const events = await this.nextEvents();
    const times = [Date.now() + 60_000];
    if (events.length) times.push(events[0].at);
    const current = await this.ctx.storage.getAlarm();
    const wanted = Math.min(...times);
    if (current == null || current > wanted) await this.ctx.storage.setAlarm(wanted);
    await this.ctx.storage.put('meta:lastEventAt', events.length ? events[0].at : 0);
  }
  async alarm() {
    const now = Date.now();
    for (const prefix of ['session:', 'rate:']) {
      const entries = await this.ctx.storage.list({ prefix });
      for (const [key, value] of entries) if ((value.expiresAt || value.until) <= now) await this.ctx.storage.delete(key);
    }
    const cfg = await this.cfg();
    if (!cfg.drawnAt && now >= endOfDayMadrid(cfg.joinDeadline)) await this.runDraw();
    const events = await this.nextEvents();
    const due = events.filter(e => e.kind === 'remind' && e.at <= now && now < e.at + 30 * 60_000);
    const lastFired = (await this.ctx.storage.get('meta:fired')) || {};
    for (const e of due) {
      if (lastFired[e.at]) continue;
      lastFired[e.at] = true;
      await this.ctx.storage.put('meta:fired', lastFired);
      await this.pushAll(e.title, e.body);
    }
    const times = [];
    if ((await this.ctx.storage.list({ prefix: 'session:', limit: 1 })).size || (await this.ctx.storage.list({ prefix: 'rate:', limit: 1 })).size) times.push(now + 60_000);
    if (events.length) times.push(events[0].at);
    if (times.length) await this.ctx.storage.setAlarm(Math.min(...times));
  }
}

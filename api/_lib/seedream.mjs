// ─────────────────────────────────────────────────────────────────────────────
// seedream.mjs — Client du backend non documenté de seedream.pro
// Reverse-engineered le 2026-09-04 (analyse des bundles Nuxt + captures réseau).
//
//   API  : https://api.seedream.pro   (vérifie l'en-tête Origin)
//   Auth : https://auth.seedream.pro  (better-auth : /api/auth/*)
//   CDN  : https://cdn.seedream.pro   (URLs de sortie, accès public direct)
//
// Contrat découvert :
//   GET  /v1/guest/context                       → {data:{token:JWT(10 min),expiresAt}}
//   POST /v1/image/jobs  [guest]  JSON           → {data:{jobId,status,pollUrl,pollToken}}
//       headers : Origin, Content-Type, X-Request-Context: <JWT guest>
//       body    : {prompt, negative_prompt?, width, height}
//   POST /v1/image/jobs  [user]   multipart       → idem
//       headers : Origin, Authorization: Bearer <worker token>
//       form    : prompt, width, height, input_image_0..3 (fichiers, max 4, ≤10 Mo)
//   GET  /v1/jobs/{id}/events  (SSE)             → events status {jobId,status,outputUrl,error} + end
//       headers : Origin, Accept: text/event-stream,
//                 X-Job-Poll-Token: <pollToken>,
//                 (+ X-Request-Context guest | Authorization Bearer user)
//   GET  /v1/jobs/{id}        (polling fallback) → {data:{jobId,status,outputUrl,error}}
//   POST {auth}/api/auth/sign-in/email           → 200 + Set-Cookie session (pas de captcha au login)
//   GET  {auth}/api/auth/token  (cookie session) → {token, expiresAt}
//
// Limites observées : ~1 création/min/IP en mode guest (429 QUOTA_EXCEEDED).
// L'édition d'image (input_image_*) exige un compte : 401 sinon
//   {"code":"UNAUTHORIZED","message":"Authentication required to edit images"}.
// ─────────────────────────────────────────────────────────────────────────────

const API_BASE = 'https://api.seedream.pro';
const AUTH_BASE = 'https://auth.seedream.pro';
const SITE_ORIGIN = 'https://seedream.pro';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Images sources : 4 max, 10 Mo max (contraintes UI du site).
export const MAX_INPUT_IMAGES = 4;
export const MAX_INPUT_BYTES = 10 * 1024 * 1024;
export const MIN_DIM = 512;
export const MAX_DIM = 1536;

// ─── Registre des jobs (pour /api/status) ────────────────────────────────────
// Map jobId → {mode:'guest'|'user', pollToken, ts}
const JOB_REGISTRY = new Map();
const REGISTRY_MAX = 500;
const REGISTRY_TTL_MS = 30 * 60 * 1000;

// ─── Petits utilitaires ──────────────────────────────────────────────────────
function getEnv(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function clamp(n, min, max) {
  n = Number(n);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function makeErr(code, message, status = 400, retryable = false, requestId) {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  e.retryable = retryable;
  e.requestId = requestId;
  return e;
}

function upstreamError(body, fallbackMessage, requestId) {
  // Corps de réponse upstream : peut être vide, non-JSON, ou JSON quelconque.
  // Ne JAMAIS supposer la forme — tout accès passe par des gardes null.
  let b = null;
  if (typeof body === 'string') {
    try { b = JSON.parse(body); } catch { b = null; }
  } else if (body && typeof body === 'object') {
    b = body;
  }
  const er = (b && typeof b === 'object' && b.error && typeof b.error === 'object') ? b.error : {};
  const reqId = er.requestId || (b && b.requestId) || requestId || undefined;
  return makeErr(
    er.code || 'UPSTREAM_ERROR',
    er.message || (b && b.message) || fallbackMessage || 'Erreur du service distant',
    (er.status && er.status >= 400 && er.status < 600) ? er.status : 502,
    !!er.retryable,
    reqId
  );
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function extractCookies(res) {
  // Node ≥18.14 : getSetCookie() ; repli sur l'en-tête brut.
  let raw = [];
  if (typeof res.headers.getSetCookie === 'function') {
    raw = res.headers.getSetCookie();
  } else {
    const v = res.headers.get('set-cookie');
    if (v) raw = [v];
  }
  return raw
    .map((c) => c.split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}

// ─── HTTP bas niveau (Origin spoofé, UA) ─────────────────────────────────────
async function apiFetch(path, { method = 'GET', headers = {}, body, cookie, host = 'api' } = {}) {
  const base = host === 'auth' ? AUTH_BASE : API_BASE;
  const h = {
    'User-Agent': UA,
    Origin: SITE_ORIGIN,
    ...headers,
  };
  if (cookie) h.Cookie = cookie;
  let res;
  try {
    res = await fetch(base + path, { method, headers: h, body, redirect: 'follow' });
  } catch (e) {
    throw makeErr('NETWORK_ERROR', 'Impossible de joindre ' + base + ' : ' + e.message, 502, true);
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    throw upstreamError(text, `Upstream ${res.status} sur ${path}`, undefined);
  }
  return { res, text };
}

// ─── Contexte invité (JWT X-Request-Context) ─────────────────────────────────
let guestCtxCache = null; // {token, expiresAtMs}
let guestCtxInflight = null;

async function getGuestContext(force = false) {
  const now = Date.now();
  if (!force && guestCtxCache && guestCtxCache.expiresAtMs > now + 60_000) {
    return guestCtxCache.token;
  }
  if (guestCtxInflight) return guestCtxInflight;
  guestCtxInflight = (async () => {
    const { text } = await apiFetch('/v1/guest/context', { host: 'api' });
    const j = safeJson(text);
    const data = j && j.data;
    if (!data || !data.token) throw upstreamError(text, 'guest/context: réponse invalide');
    const exp = data.expiresAt ? Date.parse(data.expiresAt) : NaN;
    guestCtxCache = {
      token: data.token,
      expiresAtMs: Number.isFinite(exp) ? exp : now + 10 * 60_000,
    };
    return data.token;
  })();
  try {
    return await guestCtxInflight;
  } finally {
    guestCtxInflight = null;
  }
}

// ─── Session utilisateur (login email/mdp → cookie) ──────────────────────────
let sessionCookie = null;   // jar complet pour auth.seedream.pro
let sessionExpiresMs = 0;
let sessionInflight = null;

function hasCredentials() {
  return Boolean(getEnv('SEEDREAM_COOKIE') || (getEnv('SEEDREAM_EMAIL') && getEnv('SEEDREAM_PASSWORD')));
}

async function getSessionCookie(force = false) {
  const envCookie = getEnv('SEEDREAM_COOKIE');
  if (envCookie) return envCookie;
  if (!getEnv('SEEDREAM_EMAIL') || !getEnv('SEEDREAM_PASSWORD')) {
    throw makeErr('AUTH_NOT_CONFIGURED',
      'Cette fonctionnalité nécessite un compte seedream.pro. Configure SEEDREAM_EMAIL / SEEDREAM_PASSWORD (ou SEEDREAM_COOKIE).', 503, false);
  }
  const now = Date.now();
  if (!force && sessionCookie && sessionExpiresMs > now) return sessionCookie;
  if (sessionInflight) return sessionInflight;
  sessionInflight = (async () => {
    const body = JSON.stringify({
      email: getEnv('SEEDREAM_EMAIL'),
      password: getEnv('SEEDREAM_PASSWORD'),
    });
    const { res } = await apiFetch('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      host: 'auth',
    });
    const cookie = extractCookies(res);
    if (!cookie) throw makeErr('LOGIN_FAILED', 'Login seedream.pro : aucune session renvoyée', 502, true);
    sessionCookie = cookie;
    // Session "remember me" par défaut ; on rafraîchit par prudence après 12 h.
    sessionExpiresMs = now + 12 * 60 * 60 * 1000;
    return cookie;
  })();
  try {
    return await sessionInflight;
  } finally {
    sessionInflight = null;
  }
}

// ─── Worker token (Bearer pour api.seedream.pro) ─────────────────────────────
let workerTokCache = null; // {token, expiresAtMs}
let workerTokInflight = null;

async function getWorkerToken(force = false) {
  const now = Date.now();
  if (!force && workerTokCache && workerTokCache.expiresAtMs > now + 60_000) {
    return workerTokCache.token;
  }
  if (workerTokInflight) return workerTokInflight;
  workerTokInflight = (async () => {
    const cookie = await getSessionCookie(force);
    const { text } = await apiFetch('/api/auth/token', {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cookie,
      host: 'auth',
    });
    const j = safeJson(text);
    // Réponse réelle observée : {ok, requestId, data:{token, expiresAt}}.
    // (le site accepte aussi la forme plate {token, expiresAt} — on gère les deux.)
    const d = (j && j.data) || j;
    if (!d || !d.token) throw upstreamError(text, '/api/auth/token : réponse invalide');
    const exp = d.expiresAt ? Date.parse(d.expiresAt) : NaN;
    workerTokCache = {
      token: d.token,
      expiresAtMs: Number.isFinite(exp) ? exp : now + 15 * 60_000,
    };
    return d.token;
  })();
  try {
    return await workerTokInflight;
  } finally {
    workerTokInflight = null;
  }
}

// ─── Téléchargement de l'image source ────────────────────────────────────────
export async function downloadImage(url) {
  let href = String(url || '').trim();
  if (!href) throw makeErr('INVALID_PARAMS', 'image_url manquant', 400);

  if (href.startsWith('data:')) {
    const m = /^data:(image\/[\w.+-]+)?(;base64)?,(.*)$/s.exec(href);
    if (!m) throw makeErr('INVALID_PARAMS', 'data: URL invalide', 400);
    const buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
    if (buf.length > MAX_INPUT_BYTES) throw makeErr('IMAGE_TOO_LARGE', `Image > ${MAX_INPUT_BYTES / 1024 / 1024} Mo`, 400);
    return { buffer: buf, type: m[1] || 'image/png', name: 'input_0.png' };
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30_000);
  let res;
  try {
    res = await fetch(href, { headers: { 'User-Agent': UA }, signal: ctl.signal, redirect: 'follow' });
  } catch (e) {
    throw makeErr('IMAGE_FETCH_FAILED', 'Téléchargement de image_url impossible : ' + e.message, 400, true);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw makeErr('IMAGE_FETCH_FAILED', `image_url répond HTTP ${res.status}`, 400, true);

  const ctype = (res.headers.get('content-type') || '').split(';')[0].toLowerCase();
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_INPUT_BYTES) throw makeErr('IMAGE_TOO_LARGE', `Image > ${MAX_INPUT_BYTES / 1024 / 1024} Mo`, 400);
  if (ctype && !ctype.startsWith('image/') && ctype !== 'application/octet-stream') {
    throw makeErr('INVALID_PARAMS', `image_url ne pointe pas vers une image (content-type: ${ctype})`, 400);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_INPUT_BYTES) throw makeErr('IMAGE_TOO_LARGE', `Image > ${MAX_INPUT_BYTES / 1024 / 1024} Mo`, 400);
  const ext = ctype === 'image/png' ? 'png' : ctype === 'image/webp' ? 'webp' : 'jpg';
  return { buffer, type: ctype || 'image/jpeg', name: `input_0.${ext}` };
}

// ─── Création d'un job image ─────────────────────────────────────────────────
export async function createImageJob({
  prompt, negativePrompt, width = 512, height = 512,
  inputImages = [], // [{buffer, type, name}] — présent ⇒ mode utilisateur
  mode, // 'guest' | 'user' | 'auto' (auto = user si images ou compte configuré)
}) {
  prompt = String(prompt || '').trim();
  if (!prompt) throw makeErr('INVALID_PARAMS', 'prompt manquant', 400);
  const w = clamp(width, MIN_DIM, MAX_DIM);
  const h = clamp(height, MIN_DIM, MAX_DIM);
  const imgs = inputImages.slice(0, MAX_INPUT_IMAGES);
  if (imgs.some((i) => !i || !i.buffer)) throw makeErr('INVALID_PARAMS', 'inputImages invalides', 400);
  if (imgs.some((i) => i.buffer.length > MAX_INPUT_BYTES)) {
    throw makeErr('IMAGE_TOO_LARGE', `Image > ${MAX_INPUT_BYTES / 1024 / 1024} Mo`, 400);
  }

  let m = mode;
  if (!m || m === 'auto') m = imgs.length > 0 ? 'user' : (hasCredentials() ? 'user' : 'guest');
  if (m === 'guest' && imgs.length > 0) {
    throw makeErr('IMAGE_AUTH_REQUIRED',
      'L\'édition d\'image (image source) nécessite un compte seedream.pro. Configure SEEDREAM_EMAIL / SEEDREAM_PASSWORD.', 401, false);
  }

  // Appel + 1 retry automatique en cas de 401 (jeton expiré/rafraîchi côté serveur).
  const attempt = async (withAuth) => {
    const headers = { Origin: SITE_ORIGIN };
    let body;
    if (m === 'user') {
      const token = withAuth ? await getWorkerToken(true) : await getWorkerToken();
      headers.Authorization = `Bearer ${token}`;
      const fd = new FormData();
      fd.append('prompt', prompt);
      fd.append('width', String(w));
      fd.append('height', String(h));
      if (negativePrompt) fd.append('negative_prompt', negativePrompt);
      imgs.forEach((img, p) => {
        fd.append(`input_image_${p}`, new Blob([img.buffer], { type: img.type || 'image/png' }), img.name || `input_${p}.png`);
      });
      body = fd;
    } else {
      headers['X-Request-Context'] = await getGuestContext();
      headers['Content-Type'] = 'application/json';
      const payload = { prompt, width: w, height: h };
      if (negativePrompt) payload.negative_prompt = negativePrompt;
      body = JSON.stringify(payload);
    }
    const { text } = await apiFetch('/v1/image/jobs', { method: 'POST', headers, body });
    return text;
  };

  let text;
  try {
    text = await attempt(false);
  } catch (e) {
    if (m === 'user' && e.status === 401 && e.retryable !== false) {
      try { text = await attempt(true); } catch (e2) { throw e2; }
    } else {
      throw e;
    }
  }

  const j = safeJson(text);
  const data = j && j.data;
  if (!data || !data.jobId) throw upstreamError(text, '/v1/image/jobs : réponse invalide');

  // Registre pour /api/status.
  const pollToken = data.pollToken || '';
  registerJob(data.jobId, m, pollToken);

  return {
    jobId: data.jobId,
    status: data.status || 'queued',
    pollUrl: data.pollUrl || `/v1/jobs/${data.jobId}`,
    pollToken,
    mode: m,
    width: w,
    height: h,
    requestId: j.requestId,
  };
}

function registerJob(jobId, mode, pollToken) {
  const now = Date.now();
  for (const [k, v] of JOB_REGISTRY) {
    if (v.ts < now - REGISTRY_TTL_MS || JOB_REGISTRY.size > REGISTRY_MAX) JOB_REGISTRY.delete(k);
  }
  JOB_REGISTRY.set(jobId, { mode, pollToken, ts: now });
}

// ─── Attente du résultat : SSE d'abord, polling en secours ───────────────────
export async function waitForJob({ jobId, pollToken, mode, timeoutMs = 50_000, onStatus }) {
  const started = Date.now();
  let result;
  try {
    result = await waitSse(jobId, pollToken, mode, timeoutMs, onStatus);
  } catch (e) {
    // Jeton utilisateur périmé → on rafraîchit et on retente une fois.
    if (mode === 'user' && e.status === 401) {
      await getWorkerToken(true);
      result = await waitSse(jobId, pollToken, mode, timeoutMs - (Date.now() - started), onStatus);
    } else {
      throw e;
    }
  }
  if (result.done) return result;

  // Timeout SSE → bascule en polling (budget restant).
  const remaining = timeoutMs - (Date.now() - started);
  if (remaining > 0) {
    return waitPoll(jobId, pollToken, mode, remaining, onStatus);
  }
  return { done: false };
}

function authHeadersFor(mode, pollToken, extra = {}) {
  const headers = { ...extra };
  if (pollToken) headers['X-Job-Poll-Token'] = pollToken;
  return headers; // guest/user : ajoutés par la couche d'appel
}

async function requestWithChannelHeaders(path, mode, headers) {
  if (mode === 'user') {
    headers.Authorization = `Bearer ${await getWorkerToken()}`;
    return apiFetch(path, { method: 'GET', headers, host: 'api' });
  }
  headers['X-Request-Context'] = await getGuestContext();
  return apiFetch(path, { method: 'GET', headers, host: 'api' });
}

async function waitSse(jobId, pollToken, mode, timeoutMs, onStatus) {
  const path = `/v1/jobs/${jobId}/events`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);

  const headers = authHeadersFor(mode, pollToken, { Accept: 'text/event-stream', Origin: SITE_ORIGIN });
  if (mode === 'user') headers.Authorization = `Bearer ${await getWorkerToken()}`;
  else headers['X-Request-Context'] = await getGuestContext();

  try {
    const res = await fetch(API_BASE + path, {
      headers: { 'User-Agent': UA, ...headers },
      signal: ctl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (res.status === 401 && mode === 'user') { /* jeton périmé : le polling avortera proprement */ }
      throw upstreamError(body, `SSE ${res.status}`, undefined);
    }
    if (!res.body) return { done: false };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let lastStage = null;

    const emit = (ev) => {
      const j = ev.data ? safeJson(ev.data) : null;
      if (!j) return;
      const stage = j.status === 'succeeded' ? 'succeeded' : j.status === 'failed' ? 'failed' : (j.status || 'queued');
      if (stage !== lastStage) {
        lastStage = stage;
        if (onStatus) onStatus({ stage, jobId, outputUrl: j.outputUrl, error: j.error });
      }
      if (j.status === 'succeeded' && j.outputUrl) {
        return { outputUrl: j.outputUrl };
      }
      if (j.status === 'failed') {
        throw makeErr('JOB_FAILED', j.error || 'Job échoué côté Seedream', 502, true);
      }
      return null;
    };

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = {};
        for (const line of block.split('\n')) {
          if (!line || line.startsWith(':')) continue;
          if (line.startsWith('event:')) ev.event = line.slice(6).trim();
          else if (line.startsWith('data:')) ev.data = (ev.data ? ev.data + '\n' : '') + line.slice(5).trim();
        }
        const hit = emit(ev);
        if (hit) return { done: true, result: { images: [{ image: hit.outputUrl }] } };
      }
    }
    return { done: false };
  } catch (e) {
    if (e.name === 'AbortError') return { done: false };
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function waitPoll(jobId, pollToken, mode, timeoutMs, onStatus) {
  const path = `/v1/jobs/${jobId}`;
  const deadline = Date.now() + timeoutMs;
  let delay = 1500;
  let lastStage = null;

  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { done: false };

    const headers = authHeadersFor(mode, pollToken);
    const { text } = await requestWithChannelHeaders(path, mode, headers);
    const j = safeJson(text);
    const data = (j && j.data) || j || {};
    const stage = data.status === 'succeeded' ? 'succeeded'
      : data.status === 'failed' ? 'failed' : (data.status || 'queued');
    if (stage !== lastStage) {
      lastStage = stage;
      if (onStatus) onStatus({ stage, jobId, outputUrl: data.outputUrl, error: data.error });
    }
    if (data.status === 'succeeded' && data.outputUrl) {
      return { done: true, result: { images: [{ image: data.outputUrl }] } };
    }
    if (data.status === 'failed') {
      throw makeErr('JOB_FAILED', data.error || 'Job échoué côté Seedream', 502, true);
    }
    delay = Math.min(3000, Math.floor(delay * 1.4));
    await sleep(delay);
  }
}

export async function pollJobStatus(jobId) {
  const reg = JOB_REGISTRY.get(jobId);
  const mode = reg ? reg.mode : (hasCredentials() ? 'user' : 'guest');
  const pollToken = reg ? reg.pollToken : '';
  const path = `/v1/jobs/${jobId}`;
  const headers = authHeadersFor(mode, pollToken);
  const { text } = await requestWithChannelHeaders(path, mode, headers);
  const j = safeJson(text);
  const data = (j && j.data) || j || {};
  return {
    jobId,
    status: data.status || 'unknown',
    outputUrl: data.outputUrl || null,
    error: data.error || null,
    mode,
    requestId: j && j.requestId,
  };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ─── Rate limiting par uid (fenêtre fixe en mémoire) ─────────────────────────
const WINDOW_MS = 60 * 60 * 1000;
const buckets = new Map(); // uid → {count, windowStart}

export function checkRateLimit(uid) {
  const limit = Number(getEnv('RATE_LIMIT_PER_HOUR', '30'));
  if (!limit || limit <= 0) return { ok: true };
  const now = Date.now();
  if (buckets.size > 10_000) {
    for (const [k, v] of buckets) if (v.windowStart < now - WINDOW_MS) buckets.delete(k);
  }
  let b = buckets.get(uid);
  if (!b || b.windowStart < now - WINDOW_MS) {
    b = { count: 0, windowStart: now };
    buckets.set(uid, b);
  }
  if (b.count >= limit) {
    return { ok: false, retryAfterSeconds: Math.ceil((b.windowStart + WINDOW_MS - now) / 1000) };
  }
  b.count += 1;
  return { ok: true };
}

export function forgetJob(jobId) { JOB_REGISTRY.delete(jobId); }
export { hasCredentials, getGuestContext, getWorkerToken };

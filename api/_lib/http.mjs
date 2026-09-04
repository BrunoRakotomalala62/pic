// http.mjs — Helpers de réponse HTTP communs (CORS, JSON, erreurs structurées).
import { randomUUID } from 'node:crypto';

export function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Uid',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
  };
}

export function newRequestId() {
  return randomUUID().replace(/-/g, '').slice(0, 16);
}

export function respond(res, status, obj, extra = {}) {
  const body = JSON.stringify(obj, null, 2);
  res.statusCode = status;
  for (const [k, v] of Object.entries({ ...corsHeaders(), ...extra })) res.setHeader(k, v);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

// Convertit n'importe quelle erreur en réponse structurée façon Seedream.
export function respondError(res, e, requestId = newRequestId()) {
  if (!e || typeof e !== 'object') {
    e = { code: 'INTERNAL_ERROR', message: String(e === null ? 'Erreur interne inconnue' : e), status: 500, retryable: false, requestId };
  }
  const status = Number(e.status) >= 400 ? Number(e.status) : 500;
  const retryable = !!e.retryable;
  const code = e.code || 'INTERNAL_ERROR';
  const message = e.message || 'Erreur interne';
  const extra = {};
  if (retryable) extra['Retry-After'] = String(e.retryAfterSeconds || 5);
  respond(res, status, {
    ok: false,
    requestId,
    error: { code, message, retryable, status, requestId: e.requestId || requestId },
  }, extra);
}

export function ok(res, data, requestId) {
  respond(res, 200, { ok: true, requestId, data });
}

// Fusionne query string + corps JSON (POST). GET = query uniquement.
export async function readParams(req, query) {
  const params = { ...(query || {}) };
  if (req.method === 'POST') {
    const ct = (req.headers['content-type'] || '').toLowerCase();
    if (ct.includes('application/json')) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw) {
        try { Object.assign(params, JSON.parse(raw)); } catch { /* corps ignoré si invalide */ }
      }
    }
  }
  return params;
}

// Extraits communs : uid + dimensions optionnelles (clamp fait côté lib).
export function baseParams(params) {
  return {
    uid: String(params.uid || params.u || 'anon').slice(0, 64),
    width: params.width != null ? Number(params.width) : 512,
    height: params.height != null ? Number(params.height) : 512,
    negativePrompt: String(params.negative_prompt || params.negativePrompt || '').trim() || undefined,
    waitMs: Math.max(0, Math.min(60_000, Number(params.timeout ?? 45_000))),
  };
}

export function getListParam(params, key) {
  const v = params[key];
  if (v == null) return [];
  return Array.isArray(v) ? v : String(v).split(',').map((s) => s.trim()).filter(Boolean);
}

export function run(handler) {
  return async (req, res) => {
    const requestId = newRequestId();
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      for (const [k, v] of Object.entries(corsHeaders())) res.setHeader(k, v);
      return res.end();
    }
    try {
      const query = {};
      if (req.query) Object.assign(query, req.query);
      else if (req.url) {
        const u = new URL(req.url, 'http://localhost');
        for (const [k, v] of u.searchParams) query[k] = v;
      }
      const params = await readParams(req, query);
      const data = await handler(params, { requestId });
      if (data === undefined) return respond(res, 404, { ok: false, requestId, error: { code: 'NOT_FOUND', message: 'Route inconnue', retryable: false, status: 404, requestId } });
      return respond(res, 200, { ok: true, requestId, data });
    } catch (e) {
      return respondError(res, e, requestId);
    }
  };
}

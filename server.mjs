// server.mjs — Serveur standalone (zéro dépendance) pour lancer l'API en local
// ou sur n'importe quel hébergeur Node (Render, Railway, Fly.io, VPS…).
//
//   node server.mjs            → écoute sur le port $PORT (défaut 8787)
//
// Routes :
//   GET /api/generation   ?prompt=&width=&height=&uid=
//   GET /api/modification ?prompt=&image_url=&uid=   (+ image_url2..4, width, height)
//   GET /api/status       ?job_id=&uid=
//   GET /health
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { handleGeneration, handleModification, handleStatus } from './api/_lib/handlers.mjs';
import { run, respond, corsHeaders } from './api/_lib/http.mjs';

// Charge un éventuel .env (sans dépendance) : lignes KEY=VALUE, ignore les #.
const __dirname = dirname(fileURLToPath(import.meta.url));
try {
  const envFile = join(__dirname, '.env');
  const txt = readFileSync(envFile, 'utf8');
  for (const line of txt.split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) {
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  }
} catch { /* pas de .env, on continue */ }

const routes = {
  '/api/generation': run(handleGeneration),
  '/api/modification': run(handleModification),
  '/api/status': run(handleStatus),
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (path === '/health') {
    return respond(res, 200, { ok: true, uptime: process.uptime() });
  }
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    for (const [k, v] of Object.entries(corsHeaders())) res.setHeader(k, v);
    return res.end();
  }

  const handler = routes[path];
  if (!handler) {
    return respond(res, 404, { ok: false, requestId: 'local', error: { code: 'NOT_FOUND', message: `Route inconnue : ${path}`, retryable: false, status: 404, requestId: 'local' } });
  }
  // req.query simulé pour le wrapper `run`
  req.query = Object.fromEntries(url.searchParams);
  try {
    await handler(req, res);
  } catch (e) {
    // Dernier filet (les handlers gèrent déjà leurs erreurs).
    respond(res, 500, { ok: false, requestId: 'local', error: { code: 'INTERNAL_ERROR', message: String(e && e.message || e), retryable: false, status: 500, requestId: 'local' } });
  }
});

const port = Number(process.env.PORT || 8787);
server.listen(port, () => {
  console.log(`[seedream-api] en écoute sur http://localhost:${port}`);
  console.log('  GET /api/generation   (texte→image, sans compte)');
  console.log('  GET /api/modification (image + prompt, compte seedream.pro requis)');
  console.log('  GET /api/status       (résultat d\'un job)');
});

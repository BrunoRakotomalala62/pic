// handlers.mjs — Logique métier des routes (indépendante de l'hébergeur).
import {
  createImageJob, waitForJob, pollJobStatus, downloadImage, checkRateLimit,
  makeErr, hasCredentials, forgetJob,
} from './seedream.mjs';
import { baseParams, getListParam } from './http.mjs';

const clampWait = (ms) => Math.max(0, Math.min(60_000, ms));

// ─── GET/POST /api/generation — texte → image (sans compte requis) ───────────
export async function handleGeneration(params) {
  const { uid, width, height, negativePrompt, waitMs } = baseParams(params);
  const prompt = String(params.prompt || '').trim();
  if (!prompt) throw makeErr('INVALID_PARAMS', 'Paramètre "prompt" requis (texte de l\'image à générer).', 400);
  const rl = checkRateLimit('gen:' + uid);
  if (!rl.ok) {
    const e = makeErr('QUOTA_EXCEEDED', `Trop de requêtes pour uid=${uid}. Réessaie dans ~${rl.retryAfterSeconds} s.`, 429, true);
    e.retryAfterSeconds = rl.retryAfterSeconds;
    throw e;
  }
  const job = await createImageJob({ prompt, negativePrompt, width, height, mode: 'guest' });
  const out = await waitForJob({ ...job, timeoutMs: clampWait(waitMs), onStatus: () => {} });
  forgetJob(job.jobId);
  if (out.done) {
    return {
      uid, prompt, width: job.width, height: job.height, jobId: job.jobId, mode: 'guest',
      status: 'succeeded', images: out.result.images,
    };
  }
  return { uid, jobId: job.jobId, mode: 'guest', status: 'processing', images: [],
    pollUrl: `/api/status?job_id=${encodeURIComponent(job.jobId)}&uid=${encodeURIComponent(uid)}`,
    message: 'Traitement en cours côté Seedream. Interroge pollUrl dans quelques secondes.' };
}

// ─── GET/POST /api/modification — image source + prompt (compte requis) ──────
export async function handleModification(params) {
  const { uid, width, height, negativePrompt, waitMs } = baseParams(params);
  const prompt = String(params.prompt || '').trim();
  if (!prompt) throw makeErr('INVALID_PARAMS', 'Paramètre "prompt" requis (ex. : changer en bleu le vêtement de cette fille).', 400);

  // image_url + optionnels image_url2..image_url4 (4 max, comme la UI seedream.pro).
  const urls = getListParam(params, 'image_url');
  for (let i = 2; i <= 4; i++) urls.push(...getListParam(params, `image_url${i}`));
  const unique = [...new Set(urls)].slice(0, 4);
  if (unique.length === 0) {
    throw makeErr('INVALID_PARAMS', 'Paramètre "image_url" requis (URL de l\'image à modifier).', 400);
  }

  const rl = checkRateLimit('mod:' + uid);
  if (!rl.ok) {
    const e = makeErr('QUOTA_EXCEEDED', `Trop de requêtes pour uid=${uid}. Réessaie dans ~${rl.retryAfterSeconds} s.`, 429, true);
    e.retryAfterSeconds = rl.retryAfterSeconds;
    throw e;
  }

  if (!hasCredentials()) {
    throw makeErr('AUTH_NOT_CONFIGURED',
      'L\'édition d\'image nécessite un compte seedream.pro. Crée un compte sur https://seedream.pro/register puis configure SEEDREAM_EMAIL / SEEDREAM_PASSWORD (voir .env.example).',
      503, false);
  }

  // 1) Téléchargement des images sources (parallèle).
  const images = await Promise.all(unique.map(async (url, idx) => {
    const img = await downloadImage(url);
    return { ...img, name: `input_${idx}.${img.type === 'image/png' ? 'png' : 'jpg'}` };
  }));

  // 2) Job d'édition (multipart, canal utilisateur) + attente du résultat.
  const job = await createImageJob({ prompt, negativePrompt, width, height, inputImages: images, mode: 'user' });
  const out = await waitForJob({ ...job, timeoutMs: clampWait(waitMs), onStatus: () => {} });
  forgetJob(job.jobId);
  if (out.done) {
    return {
      uid, prompt, width: job.width, height: job.height, jobId: job.jobId, mode: 'user',
      status: 'succeeded', images: out.result.images,
    };
  }
  return {
    uid, jobId: job.jobId, mode: 'user', status: 'processing', images: [],
    pollUrl: `/api/status?job_id=${encodeURIComponent(job.jobId)}&uid=${encodeURIComponent(uid)}`,
    message: 'Traitement en cours côté Seedream. Interroge pollUrl dans quelques secondes.',
  };
}

// ─── GET /api/status — résultat d'un job lancé précédemment ──────────────────
export async function handleStatus(params) {
  const { uid } = baseParams(params);
  const jobId = String(params.job_id || '').trim();
  if (!jobId) throw makeErr('INVALID_PARAMS', 'Paramètre "job_id" requis.', 400);
  const s = await pollJobStatus(jobId);
  const data = { uid, jobId, mode: s.mode, status: s.status, images: s.outputUrl ? [{ image: s.outputUrl }] : [], error: s.error };
  if (s.status === 'succeeded' || s.status === 'failed') forgetJob(jobId);
  return data;
}

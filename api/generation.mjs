// GET /api/generation?prompt=...&width=512&height=512&uid=...
// Texte → image via seedream.pro (fonctionne SANS compte, mode invité).
import { run } from './_lib/http.mjs';
import { handleGeneration } from './_lib/handlers.mjs';

export const config = { maxDuration: 60 };

export default run(handleGeneration);

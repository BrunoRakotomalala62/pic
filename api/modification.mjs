// GET /api/modification?prompt=...&image_url=...&uid=...
// Modifie une image (image source + prompt) via le backend seedream.pro.
// Nécessite SEEDREAM_EMAIL / SEEDREAM_PASSWORD (compte seedream.pro).
import { run } from './_lib/http.mjs';
import { handleModification } from './_lib/handlers.mjs';

export const config = { maxDuration: 60 };

export default run(handleModification);

// GET /api/status?job_id=...&uid=...
// Interroge l'avancement / le résultat d'un job lancé par /api/modification
// ou /api/generation (utile quand la réponse initiale est partie en "processing").
import { run } from './_lib/http.mjs';
import { handleStatus } from './_lib/handlers.mjs';

export const config = { maxDuration: 20 };

export default run(handleStatus);

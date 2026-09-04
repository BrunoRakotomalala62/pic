// test-modification.mjs — Test édition d'image (exige SEEDREAM_EMAIL/SEEDREAM_PASSWORD).
// Usage : node scripts/test-modification.mjs [BASE_URL] [IMAGE_URL] [PROMPT]
const BASE = process.argv[2] || 'http://localhost:8787';
const IMAGE_URL = process.argv[3] || 'https://picsum.photos/seed/seedream-test/768/1024';
const PROMPT = process.argv[4] || 'make the sky turn sunset orange, keep everything else identical';

console.log(`POST ${BASE}/api/modification`);
const t0 = Date.now();
const res = await fetch(`${BASE}/api/modification`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt: PROMPT, image_url: IMAGE_URL, uid: 'test-1', width: 768, height: 1024, timeout: 45_000 }),
});
const json = await res.json();
console.log(`HTTP ${res.status} en ${((Date.now() - t0) / 1000).toFixed(1)} s`);
console.log(JSON.stringify(json, null, 2));

if (json.ok && json.data.status === 'succeeded' && json.data.images?.[0]?.image) {
  console.log('\nImage modifiée :', json.data.images[0].image);
  process.exit(0);
}
process.exit(1);

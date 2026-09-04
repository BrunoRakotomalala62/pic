// test-txt2img.mjs — Test texte→image (mode invité, aucun compte requis).
// Usage : node scripts/test-txt2img.mjs [BASE_URL]  (défaut http://localhost:8787)
const BASE = process.argv[2] || 'http://localhost:8787';

const prompt = process.argv[3] || 'a cute corgi puppy sitting in a garden, photo, soft light';

console.log(`POST ${BASE}/api/generation`);
const t0 = Date.now();
const res = await fetch(`${BASE}/api/generation`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt, width: 512, height: 512, uid: 'test-1', timeout: 45_000 }),
});
const json = await res.json();
console.log(`HTTP ${res.status} en ${((Date.now() - t0) / 1000).toFixed(1)} s`);
console.log(JSON.stringify(json, null, 2));

if (json.ok && json.data.status === 'succeeded' && json.data.images?.[0]?.image) {
  console.log('\nImage générée :', json.data.images[0].image);
  process.exit(0);
}
process.exit(1);

# seedream-api

API REST autour du générateur d'images **Seedream** (seedream.pro) — wrapper du
backend non documenté du site, reverse-engineered (bundles Nuxt + captures réseau).
Zéro dépendance, Node ≥ 18.

## Endpoints

| Route | Description | Compte requis |
|---|---|---|
| `GET /api/modification` | Modifie une image : `prompt` + `image_url` | ✅ |
| `GET /api/generation` | Texte → image | ❌ (invité) |
| `GET /api/status` | Résultat d'un job (`job_id`) lancé précédemment | selon job |

### GET /api/modification

```
GET /api/modification?prompt=changer%20en%20bleu%20le%20v%C3%AAtement%20de%20cette%20fille&image_url=URL_IMAGE_ICI&uid=123
```

Paramètres :

| Param | Défaut | Description |
|---|---|---|
| `prompt` | — | Instruction de modification (requis) |
| `image_url` | — | URL de l'image à modifier (requis ; supporte aussi `image_url2`…`image_url4`, 4 max) |
| `uid` | `anon` | Identifiant utilisateur → quota/rate-limit |
| `width` / `height` | `512` / `512` | Dimensions de sortie (512–1536) |
| `negative_prompt` | — | Ce qu'il faut éviter |
| `timeout` | `45000` | Attente max du résultat en ms (≤ 60000) |

Réponse (succès) :

```json
{
  "ok": true,
  "requestId": "a35f...",
  "data": {
    "uid": "123",
    "jobId": "9cccbfbc-...",
    "mode": "user",
    "status": "succeeded",
    "width": 512,
    "height": 512,
    "images": [{ "image": "https://cdn.seedream.pro/assets/temp/outputs/output_....png" }]
  }
}
```

Si le job n'est pas fini dans `timeout`, la réponse part en `status: "processing"`
avec un `pollUrl` → à interroger via `/api/status?job_id=...&uid=...`.

## Configuration

Copie `.env.example` → `.env` :

| Variable | Obligatoire | Description |
|---|---|---|
| `SEEDREAM_EMAIL` / `SEEDREAM_PASSWORD` | pour `/api/modification` | Compte seedream.pro (voir ci-dessous) |
| `SEEDREAM_COOKIE` | alternative | Cookie de session brut au lieu du mot de passe |
| `RATE_LIMIT_PER_HOUR` | non (30) | Créations max par `uid` et par heure ; `0` = illimité |
| `PORT` | non (8787) | Port du serveur standalone |

### Compte seedream.pro (obligatoire pour la modification d'image)

Le backend refuse l'édition d'image sans compte :
`401 Authentication required to edit images` (testé). Il faut donc :

1. Créer un compte sur https://seedream.pro/register — **à faire à la main dans un
   navigateur** (l'inscription est protégée par un captcha Cloudflare Turnstile).
2. Mettre `SEEDREAM_EMAIL` + `SEEDREAM_PASSWORD` dans `.env` (ou les variables
   d'environnement Vercel).

Le login par mot de passe se fait par API **sans captcha** ; la session est
utilisée pour récupérer un « worker token » (Bearer) régénéré automatiquement.

## Lancer

```bash
# Local (standalone, aucune installation)
cp .env.example .env   # renseigner les identifiants
node server.mjs        # → http://localhost:8787

# Tests
node scripts/test-txt2img.mjs            # sans compte
node scripts/test-modification.mjs       # avec compte
```

## Déploiement Vercel

Projet prêt pour les fonctions serverless Vercel (`api/*.mjs`) :
- `/api/modification`, `/api/generation`, `/api/status`
- `maxDuration` réglé à 60 s (plan Hobby : 60 s max — au-delà, la réponse part en
  `processing` + `pollUrl`).

⚠️ Le rate-limit et le registre de jobs (`/api/status`) sont **en mémoire** :
sur Vercel (instances éphémères multiples) ils sont best-effort. Pour un usage
fiable, préférer le serveur standalone (Render / Railway / Fly.io / VPS) ou
ajouter un stockage persistant (KV) pour le registre des jobs.

> ⚠️ **Vercel = IP bloquée par seedream.pro** (constaté le 2026-09-04) : les
> routes Vercel reçoivent `403 « Just a moment... »` (challenge Cloudflare) sur
> `api.seedream.pro` **et** `auth.seedream.pro`. Le code y est fonctionnel
> (erreurs structurées) mais l'IP/ASN de Vercel est challengée → **préférer
> Render ou un autre hôte** (voir ci-dessous), puis tester la route.

## Déploiement Render (recommandé)

Le repo contient un `Dockerfile` (serveur standalone, zéro dépendance) et un
`render.yaml` (Blueprint). Deux options :

1. **Blueprint (le plus simple)** : sur render.com → *New + → Blueprint* →
   sélectionner le repo `BrunoRakotomalala62/pic`. Render lit `render.yaml`,
   crée le service et **te demande** `SEEDREAM_EMAIL` / `SEEDREAM_PASSWORD`.
2. **Web Service manuel** : *New + → Web Service* → repo → *Runtime: Docker* →
   region (essayer `Oregon`, puis `Frankfurt`/`Singapore` si 403) → variables
   d'environnement `SEEDREAM_EMAIL`, `SEEDREAM_PASSWORD` → *Deploy*.

Le service expose `/health` (utilisé comme healthcheck) et écoute sur `$PORT`.

⚠️ Si les routes répondent `502 — Upstream 403 … Just a moment...`, l'IP de la
région Render est challengée par Cloudflare → recréer le service dans une autre
région (les IP diffèrent).

⚠️ Plan free Render : le service s'endort après ~15 min d'inactivité (premier
appel après réveil plus lent, ~30-60 s).

## Ce qui a été reverse-engineered (2026-09-04)

- `GET https://api.seedream.pro/v1/guest/context` → `{data:{token:JWT, expiresAt}}` (10 min)
- `POST /v1/image/jobs`
  - **guest** (JSON) : `{prompt, negative_prompt?, width, height}` + en-têtes
    `Origin: https://seedream.pro`, `X-Request-Context: <JWT invité>`
  - **user** (multipart) : champs `prompt`, `width`, `height`, `input_image_0`…`3`
    (fichiers) + `Authorization: Bearer <worker token>`
- Résultat : SSE `GET /v1/jobs/{id}/events` (en-têtes `Accept: text/event-stream`,
  `X-Job-Poll-Token`, contexte invité ou Bearer) — événements `status`
  (`queued` → `processing` → `succeeded`/`failed`, champ `outputUrl`) puis `end`.
- Repli : `GET /v1/jobs/{id}` (mêmes en-têtes) → `{data:{status, outputUrl, error}}`
- Auth : `POST {auth}/api/auth/sign-in/email` (Set-Cookie session) →
  `GET {auth}/api/auth/token` → `{token, expiresAt}`
- Sortie : `https://cdn.seedream.pro/assets/temp/outputs/…` (accès public, sans en-tête)

Limites observées :
- **Invité** : quota **journalier par IP** (`429 IMAGE_QUOTA_EXCEEDED — Daily account quota exceeded`,
  constaté après ~10 générations depuis la même IP) + limitation ~1 création/minute
  en rafale (`QUOTA_EXCEEDED — Too many create requests. Try again in about 60 seconds`).
- Le polling `GET /v1/jobs/{id}` exige le `pollToken` du job (401 sinon) : c'est
  pourquoi `/api/status` ne répond que pour les jobs lancés sur la **même instance**
  (registre en mémoire). Fiable en serveur standalone, best-effort sur Vercel.
- Les URLs de sortie sur `cdn.seedream.pro` sont **temporaires** — à re-téléverser
  si besoin d'un stockage durable.

## ⚠️ À savoir (lecture honnête)

- Ce wrapper utilise le backend **non documenté** de seedream.pro : aucun contrat
  de stabilité, les endpoints peuvent changer ou être durcis (déjà : contrôle de
  l'en-tête `Origin` et compteur anti-abus par IP). Prévoir des garde-fous
  (rate-limit par `uid` = inclus, retry sur 429/401 = inclus).
- Les conditions d'utilisation de seedream.pro n'autorisent probablement pas ce
  type d'accès programmatique. Usage personnel / test recommandé ; un usage
  public massif expose au blocage du compte et de l'IP d'hébergement.
- Le site lui-même est un front tiers « Powered by Seedream » — rien ne garantit
  la légalité de son propre usage du modèle ; garde ça en tête pour tes propres
  publications.

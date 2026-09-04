# seedream-api — serveur standalone (zéro dépendance npm)
# Build :  docker build -t seedream-api .
# Run   :  docker run --env-file .env -p 8787:8787 seedream-api
FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

# Aucune dépendance npm à installer : on copie uniquement le code nécessaire.
COPY package.json ./
COPY server.mjs ./
COPY api ./api
COPY scripts ./scripts

# Le port est injecté par l'hébergeur via $PORT (Render le fait automatiquement).
ENV PORT=8787
EXPOSE 8787

# Les identifiants seedream.pro arrivent par les variables d'environnement
# de l'hébergeur (jamais via l'image / .env).
CMD ["node", "server.mjs"]

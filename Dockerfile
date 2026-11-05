# Imagen de renta-ia-backend: la MISMA imagen sirve a la API y al worker; cambia solo el comando.
#   API:    node dist/server.js                              (CMD por defecto)
#   Worker: node dist/workers/documentProcessing.worker.js   (comando de arranque del servicio)
# Siempre "node …" directo: npm no reenvía SIGTERM y se perdería el apagado ordenado (README).
# Ninguna variable de entorno ni secreto va en la imagen: los pone la plataforma (Railway).

# ── Build: dependencias completas, cliente de Prisma y TypeScript compilado ──────────────────
FROM node:20-bookworm-slim AS build
WORKDIR /app
# Prisma necesita OpenSSL para elegir su motor (debian-openssl-3.0.x).
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/*
# Sin NODE_ENV=production aquí: npm ci omitiría las devDependencies (tsc, prisma).
COPY package.json package-lock.json ./
RUN npm ci --no-fund --no-audit
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
 # Quita las devDependencies; el cliente ya generado (node_modules/.prisma) se conserva. El CLI
 # "prisma" queda porque es peer de @prisma/client (npm no lo poda); no se usa al correr.
 && npm prune --omit=dev --no-fund --no-audit

# ── Runtime: solo lo necesario para correr, sin root ─────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
# /app es del usuario node: tesseract.js guarda aquí el idioma (spa.traineddata) que descarga
# la primera vez que hace OCR de una imagen.
RUN chown node:node /app
USER node
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node prisma ./prisma
EXPOSE 4000
CMD ["node", "dist/server.js"]

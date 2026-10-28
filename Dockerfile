# Locus in one container: the web app, the indexer, poppler and tesseract (English + Hindi) -- the same on any OS
# that runs Docker. Build:  docker compose build      Run:  docker compose up -d
FROM node:22-bookworm-slim

# poppler-utils: pdftotext / pdftoppm / pdfinfo / pdfimages. tesseract-ocr + eng + hin: OCR for scanned pages.
# tini: a proper PID 1, so Ctrl+C / docker stop shut the app and the indexer down cleanly.
RUN apt-get update \
 && apt-get install -y --no-install-recommends poppler-utils tesseract-ocr tesseract-ocr-eng tesseract-ocr-hin tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json .nvmrc ./
# better-sqlite3 installs a prebuilt binary for linux x64 and arm64; the full install is kept because the
# indexer and the start script run through tsx.
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

ENV NODE_ENV=production \
    PORT=3000 \
    LOCUS_DATA_DIR=/data/library \
    UPLOADS_DIR=/data/uploads \
    SEARCH_INDEX_PATH=/data/index/search.db \
    OCR_CACHE_PATH=/data/index/ocr-cache.db \
    LOCUS_APP_DIR=/data/app \
    LOCUS_ENABLE_UPLOADS=true \
    LOCUS_LIBRARY_ENABLED=true \
    LOCUS_USERS_ENABLED=true

# Everything Locus writes lives here: mount a volume (docker-compose.yml does).
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--import", "tsx", "scripts/start.ts"]

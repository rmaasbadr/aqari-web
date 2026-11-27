FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY index.html style.css script.js db.js config.js aqari-logo.png ./
ENV NODE_ENV=production HOST=0.0.0.0 AQARI_DB_SKIP_CREATE=true
USER node
CMD ["sh", "-c", "node db.js && node script.js"]

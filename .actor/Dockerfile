FROM apify/actor-node:20

COPY --chown=myuser package*.json ./

RUN npm ci --include=dev

COPY --chown=myuser . ./

RUN npm run build

RUN npm prune --omit=dev

CMD ["node", "dist/main.js"]

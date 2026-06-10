FROM apify/actor-node-playwright-chrome:20

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY --chown=myuser package*.json ./

RUN npm ci --include=dev

COPY --chown=myuser . ./

RUN npm run build

CMD ["node", "dist/main.js"]

# The Roar newsletter admin - plain Node server, no native modules.
# The database (SQLite) and uploaded photos live under DATA_DIR - mount a
# persistent volume there or everything resets on redeploy.
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV PORT=3000
ENV DATA_DIR=/data

EXPOSE 3000
CMD ["node", "server.js"]

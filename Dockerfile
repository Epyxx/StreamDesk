FROM node:20-alpine

WORKDIR /app

# Abhängigkeiten zuerst kopieren/installieren, damit dieser Layer nur bei
# Änderungen an package(-lock).json neu gebaut werden muss.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY src ./src
COPY public ./public

ENV NODE_NO_WARNINGS=1
EXPOSE 3000

CMD ["node", "server.js"]

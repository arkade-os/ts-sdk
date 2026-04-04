FROM node:22-slim AS builder

WORKDIR /app

# Copy the parent ts-sdk (needed as local dependency)
COPY package.json tsconfig.json ./
COPY src/ ./src/

# Copy covclaim
COPY covclaim/ ./covclaim/

# Install ts-sdk deps and build
RUN npm install
RUN npm run build

# Install covclaim deps and build
WORKDIR /app/covclaim
RUN npm install
RUN npm run build

# Runtime
FROM node:22-slim
WORKDIR /app

COPY --from=builder /app/covclaim/dist ./dist
COPY --from=builder /app/covclaim/node_modules ./node_modules
COPY --from=builder /app/covclaim/package.json ./

ENV NODE_ENV=production

EXPOSE 1234

CMD ["node", "dist/index.js"]

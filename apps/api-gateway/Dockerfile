FROM node:20-alpine AS base

WORKDIR /app

RUN corepack enable

COPY apps/api-gateway/package*.json ./apps/api-gateway/
COPY apps/api-gateway/register-node-path.js ./apps/api-gateway/
COPY libs ./libs

RUN npm install --prefix apps/api-gateway

FROM base AS development

ENV NODE_ENV=development

EXPOSE 3000

CMD ["npm", "--prefix", "apps/api-gateway", "run", "start:dev"]

FROM base AS build

COPY . .

RUN ln -s apps/api-gateway/node_modules node_modules
RUN npm --prefix apps/api-gateway run build

FROM node:20-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

RUN corepack enable

COPY apps/api-gateway/package*.json ./apps/api-gateway/
COPY apps/api-gateway/register-node-path.js ./apps/api-gateway/
COPY libs ./libs

RUN npm install --omit=dev --prefix apps/api-gateway

COPY --from=build /app/apps/api-gateway/dist ./apps/api-gateway/dist

EXPOSE 3000

CMD ["npm", "--prefix", "apps/api-gateway", "run", "start:prod"]

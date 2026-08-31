FROM node:20-alpine AS base

WORKDIR /app

RUN corepack enable

COPY apps/catalog-service/package*.json ./apps/catalog-service/
COPY libs ./libs

RUN npm install --prefix apps/catalog-service

FROM base AS development

ENV NODE_ENV=development

EXPOSE 3002

CMD ["npm", "--prefix", "apps/catalog-service", "run", "start:dev"]

FROM base AS build

COPY . .

RUN npm --prefix apps/catalog-service run build

FROM node:20-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

RUN corepack enable

COPY apps/catalog-service/package*.json ./apps/catalog-service/
COPY libs ./libs

RUN npm install --omit=dev --prefix apps/catalog-service

COPY --from=build /app/apps/catalog-service/dist ./apps/catalog-service/dist

EXPOSE 3002

CMD ["npm", "--prefix", "apps/catalog-service", "run", "start:prod"]

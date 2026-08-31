FROM node:20-alpine AS base

WORKDIR /app

RUN corepack enable

COPY apps/inventory-service/package*.json ./apps/inventory-service/
COPY libs ./libs

RUN npm install --prefix apps/inventory-service

FROM base AS development

ENV NODE_ENV=development

EXPOSE 3003

CMD ["npm", "--prefix", "apps/inventory-service", "run", "start:dev"]

FROM base AS build

COPY . .

RUN npm --prefix apps/inventory-service run build

FROM node:20-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

RUN corepack enable

COPY apps/inventory-service/package*.json ./apps/inventory-service/
COPY libs ./libs

RUN npm install --omit=dev --prefix apps/inventory-service

COPY --from=build /app/apps/inventory-service/dist ./apps/inventory-service/dist

EXPOSE 3003

CMD ["npm", "--prefix", "apps/inventory-service", "run", "start:prod"]

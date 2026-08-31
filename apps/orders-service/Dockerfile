FROM node:20-alpine AS base

WORKDIR /app

RUN corepack enable

COPY apps/orders-service/package*.json ./apps/orders-service/
COPY libs ./libs

RUN npm install --prefix apps/orders-service

FROM base AS development

ENV NODE_ENV=development

EXPOSE 3004

CMD ["npm", "--prefix", "apps/orders-service", "run", "start:dev"]

FROM base AS build

COPY . .

RUN npm --prefix apps/orders-service run build

FROM node:20-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

RUN corepack enable

COPY apps/orders-service/package*.json ./apps/orders-service/
COPY libs ./libs

RUN npm install --omit=dev --prefix apps/orders-service

COPY --from=build /app/apps/orders-service/dist ./apps/orders-service/dist

EXPOSE 3004

CMD ["npm", "--prefix", "apps/orders-service", "run", "start:prod"]

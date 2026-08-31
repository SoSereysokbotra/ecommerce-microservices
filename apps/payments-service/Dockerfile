FROM node:20-alpine AS base

WORKDIR /app

RUN corepack enable

COPY apps/payments-service/package*.json ./apps/payments-service/
COPY libs ./libs

RUN npm install --prefix apps/payments-service

FROM base AS development

ENV NODE_ENV=development

EXPOSE 3005

CMD ["npm", "--prefix", "apps/payments-service", "run", "start:dev"]

FROM base AS build

COPY . .

RUN npm --prefix apps/payments-service run build

FROM node:20-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

RUN corepack enable

COPY apps/payments-service/package*.json ./apps/payments-service/
COPY libs ./libs

RUN npm install --omit=dev --prefix apps/payments-service

COPY --from=build /app/apps/payments-service/dist ./apps/payments-service/dist

EXPOSE 3005

CMD ["npm", "--prefix", "apps/payments-service", "run", "start:prod"]

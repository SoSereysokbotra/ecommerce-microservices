FROM node:20-alpine AS base

WORKDIR /app

RUN corepack enable

COPY apps/users-service/package*.json ./apps/users-service/
COPY libs ./libs

RUN npm install --prefix apps/users-service

FROM base AS development

ENV NODE_ENV=development

EXPOSE 3001

CMD ["npm", "--prefix", "apps/users-service", "run", "start:dev"]

FROM base AS build

COPY . .

RUN npm --prefix apps/users-service run build

FROM node:20-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

RUN corepack enable

COPY apps/users-service/package*.json ./apps/users-service/
COPY libs ./libs

RUN npm install --omit=dev --prefix apps/users-service

COPY --from=build /app/apps/users-service/dist ./apps/users-service/dist

EXPOSE 3001

CMD ["npm", "--prefix", "apps/users-service", "run", "start:prod"]

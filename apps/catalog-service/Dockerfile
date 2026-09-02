FROM node:20-alpine AS base

WORKDIR /app

RUN corepack enable

COPY apps/catalog-service/package*.json ./apps/catalog-service/
COPY apps/catalog-service/register-node-path.js ./apps/catalog-service/
COPY libs ./libs

RUN npm install --prefix apps/catalog-service

FROM base AS development

ENV NODE_ENV=development

EXPOSE 3002

CMD ["npm", "--prefix", "apps/catalog-service", "run", "start:dev"]

FROM base AS build

COPY . .

# The compiler needs two dependency sets the runtime does not: the root
# devDependencies, which tsconfig.base.json pins typeorm and @nestjs/* to so
# libs/ and apps/ typecheck against one copy, and each lib's own @types
# packages. .dockerignore keeps every node_modules out of the image and the
# development target only has them because it bind-mounts the host tree, so
# the production build has to install them explicitly.
RUN npm install --ignore-scripts \
 && npm install --ignore-scripts --prefix libs/common \
 && npm install --ignore-scripts --prefix libs/rabbitmq

RUN npm --prefix apps/catalog-service run build

FROM node:20-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

RUN corepack enable

COPY apps/catalog-service/package*.json ./apps/catalog-service/
COPY apps/catalog-service/register-node-path.js ./apps/catalog-service/
COPY libs ./libs

RUN npm install --omit=dev --install-links --prefix apps/catalog-service

COPY --from=build /app/apps/catalog-service/dist ./apps/catalog-service/dist

EXPOSE 3002

CMD ["npm", "--prefix", "apps/catalog-service", "run", "start:prod"]

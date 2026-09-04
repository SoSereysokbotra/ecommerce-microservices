FROM node:20-alpine AS base

WORKDIR /app

RUN corepack enable

COPY apps/pricing-service/package*.json ./apps/pricing-service/
COPY apps/pricing-service/register-node-path.js ./apps/pricing-service/
COPY libs ./libs

RUN npm install --prefix apps/pricing-service

FROM base AS development

ENV NODE_ENV=development

EXPOSE 3007

CMD ["npm", "--prefix", "apps/pricing-service", "run", "start:dev"]

FROM base AS build

COPY . .

# The compiler needs two dependency sets the runtime does not: the root
# devDependencies, which tsconfig.base.json pins typeorm and @nestjs/* to so
# libs/ and apps/ typecheck against one copy, and each lib's own @types
# packages. .dockerignore keeps every node_modules out of the image and the
# development target only has them because it bind-mounts the host tree, so
# the production build has to install them explicitly.
RUN npm install --ignore-scripts \
 && npm install --ignore-scripts --prefix libs/common

RUN npm --prefix apps/pricing-service run build

FROM node:20-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

RUN corepack enable

COPY apps/pricing-service/package*.json ./apps/pricing-service/
COPY apps/pricing-service/register-node-path.js ./apps/pricing-service/
COPY libs ./libs

# --install-links installs the file: workspace libs as real packages so their
# own dependencies resolve; a plain --omit=dev leaves them out entirely.
RUN npm install --omit=dev --install-links --prefix apps/pricing-service

COPY --from=build /app/apps/pricing-service/dist ./apps/pricing-service/dist

EXPOSE 3007

CMD ["npm", "--prefix", "apps/pricing-service", "run", "start:prod"]

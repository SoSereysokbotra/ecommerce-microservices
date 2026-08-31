# ADR-0001 — New repository, reusing infrastructure from `saas-business-platform`

**Date:** 2026-08-31
**Status:** Accepted
**Milestone:** M0

## Context

The goal is to build an order–inventory–payment system in order to learn
distributed-systems techniques — chiefly the saga pattern, the transactional
outbox, and idempotency.

An existing repository, `saas-business-platform`, already contains working
NestJS microservice infrastructure: an API gateway, an authentication service,
RabbitMQ and Redis wiring, per-service databases, TypeORM migrations, Docker
Compose, and a CI workflow. It is public on GitHub and presents itself as a SaaS
project-management platform.

Three options were considered.

1. **Extend `saas-business-platform`.** Add orders, inventory and payments to it.
2. **Build from scratch.** A new repository with nothing carried over.
3. **New repository, reusing the infrastructure.**

## Decision

Option 3. Create `ecommerce-microservices` and copy the infrastructure across.

`saas-business-platform` is left untouched.

## Rationale

Against option 1: that repository already has a public identity as a project
tracker. Adding a shopping domain to it produces one incoherent repository
instead of two clear ones, and makes both harder to explain.

Against option 2: roughly three weeks would go into re-creating a gateway,
authentication, Docker Compose and CI — all of which have already been built once
and taught what they had to teach. The learning in this project lives in
orders-service and payments-service. Time spent re-wiring plumbing is time not
spent on the saga.

Option 3 keeps the domain clean while skipping the work with no remaining
learning value.

## What was copied

`libs/common`, `libs/rabbitmq`, `libs/shared-types`, `api-gateway`,
`users-service`, the Dockerfiles, the TypeORM/migration setup, and the CI
workflow.

## What was deliberately not copied

- **55 empty placeholder files** in the gateway — an entire module tree of
  zero-byte controllers, services, guards, filters and interceptors describing an
  architecture that never existed. All real routing happens in `ProxyController`.
- The project-tracker domain: projects, tasks, and analytics services and types.
- Hand-mirrored frontend types. The storefront will generate its client from the
  gateway's OpenAPI spec instead (M1), because drift between two hand-maintained
  copies of the same contract caused a production 404 in the previous project.

## Defects fixed while copying

- `JWT_SECRET` no longer falls back to the literal `'change-me'`. Both services
  validate their configuration at boot and refuse to start if it is missing.
- The gateway had no timeout, no retry, and no error translation. A restarting
  upstream surfaced to the browser as an unhandled 500 carrying a raw
  `ECONNREFUSED`. It now applies a per-request timeout, retries transport
  failures on idempotent verbs with jittered backoff, and returns 503/504.
- Only RabbitMQ and Redis had Compose health checks, so the gateway started
  before its upstreams could serve. Every service now exposes `/health`
  (liveness) and `/ready` (readiness), and Compose gates startup on readiness.
- The CI test job ran Jest against services with no spec files, which exits 1.
  The pipeline could never pass. Now uses `--passWithNoTests`.
- Requests carried no correlation id, so one user action produced unrelated log
  lines across services. The gateway now issues `x-correlation-id` and forwards
  it downstream.

## Consequences

- Two repositories to maintain. Accepted: they have separate audiences.
- Improvements to shared libraries do not flow back to the old repository.
  Accepted: it is finished and not under active development.
- Roles changed from `admin`/`manager`/`member` to `customer`/`staff`/`admin`,
  which suits a shop. Safe because the database is new.
- **Every environment, including local development, uses Neon PostgreSQL** with
  one database per service. There is no database container in `docker-compose.yml`.

  A local Postgres container was tried first, because it removes an external
  dependency from first-run setup. It was rejected: the project owner prefers a
  single database technology across all environments, so that local behaviour
  matches deployed behaviour and there is no second connection path to maintain.

  The cost is accepted deliberately: a fresh clone cannot run until the developer
  creates the databases in the Neon console and fills in `DATABASE_URL`. Setup
  instructions in the README cover this, and each service fails loudly at boot
  with a clear message when `DATABASE_URL` is missing rather than starting in a
  broken state.

  Integration tests from M3 onward will still use ephemeral Testcontainers
  Postgres instances, which are independent of both choices.

## Related

- ADR-0002 will record the evidence for why a saga is required (M2).

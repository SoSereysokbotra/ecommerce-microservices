# @libs/api-types

**Generated. Do not edit by hand.**

The previous project hand-mirrored backend types into the frontend. The two
copies drifted, and a call to a route that did not exist shipped as a 404.

Here the flow has one source of truth:

```
controllers + DTOs  ->  openapi/<service>.json  ->  libs/api-types/src/<service>.d.ts
```

After changing any controller or DTO:

```bash
docker compose up -d          # the spec comes from the live app
npm run gen:spec              # refresh openapi/*.json
npm run gen:types             # regenerate the .d.ts files
git add openapi libs/api-types
```

CI runs `gen:types` and fails if the result differs from what is committed, so
a stale type file cannot reach main.

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit .next/standalone: a self-contained server.js plus only the traced
  // node_modules. Railway runs that directly, so the runtime image never
  // installs dependencies and honours $PORT / $HOSTNAME without a wrapper.
  output: "standalone",

  // Next's dev server refuses cross-origin requests for its own dev resources,
  // and it treats 127.0.0.1 as a different origin from localhost. The documented
  // Playwright command uses E2E_BASE_URL=http://127.0.0.1:3100 (handoff §5:
  // "localhost and 127.0.0.1 are not interchangeable here"), which meant HMR was
  // blocked, client components never hydrated, and every browser test failed
  // waiting for a button that was never rendered.
  //
  // Development only — it has no effect on the production build.
  allowedDevOrigins: ["127.0.0.1"],

  // There is a lockfile here and another at the repo root, so Next has to guess
  // which directory is the workspace and warns that it might guess wrong. This
  // one is right: the storefront has its own dependencies and is deployed on its
  // own. Saying so removes the guess and the warning.
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;

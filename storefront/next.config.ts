import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit .next/standalone: a self-contained server.js plus only the traced
  // node_modules. Railway runs that directly, so the runtime image never
  // installs dependencies and honours $PORT / $HOSTNAME without a wrapper.
  output: "standalone",
};

export default nextConfig;

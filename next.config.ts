import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  experimental: {
    agentFeedback: true,
  },
  cacheComponents: true,
  partialPrefetching: true,
  // The Agent SDK spawns a vendored CLI binary from its own package dir and
  // must not be bundled — keep it as a runtime require. (Under cacheComponents
  // route handlers may not export `runtime = "nodejs"`; node is the default.)
  serverExternalPackages: ["@anthropic-ai/claude-agent-sdk"],
  reactCompiler: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;

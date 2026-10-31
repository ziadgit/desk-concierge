import type { NextConfig } from "next";

// FastAPI (../app.py) owns the device API and the data. It runs next to
// this server in the same container; Next proxies those paths to it.
// next.config is baked in at build time, so this is a fixed address.
const BACKEND = "http://127.0.0.1:8000";

const nextConfig: NextConfig = {
  output: "standalone",
  async rewrites() {
    return [
      { source: "/api/device/:path*", destination: `${BACKEND}/api/device/:path*` },
      { source: "/api/owner/:path*", destination: `${BACKEND}/api/owner/:path*` },
      { source: "/healthz", destination: `${BACKEND}/healthz` },
    ];
  },
};

export default nextConfig;

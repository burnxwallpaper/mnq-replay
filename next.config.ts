import type { NextConfig } from "next";

const basePath = (process.env.BASE_PATH ?? "").replace(/\/$/, "");

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  ...(basePath ? { basePath, assetPrefix: basePath } : {}),
};

export default nextConfig;

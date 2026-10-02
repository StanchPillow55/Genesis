import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@google/genai", "typescript"],
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;

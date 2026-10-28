/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  devIndicators: false,
  transpilePackages: [
    "@orbitid/ui",
    "@orbitid/react",
    "@orbitid/js",
    "@orbitid/nextjs",
    "@orbitid/backend",
    "@orbitid/shared",
  ],
};

export default nextConfig;

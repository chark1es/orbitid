/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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

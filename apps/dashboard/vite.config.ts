import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

const root = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const ui = root("../../packages/ui/src");

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      // `@orbitid/ui` primitives are consumed as TypeScript source. Their internal imports use the
      // shadcn `@/…` and `cn` aliases, so those must resolve inside packages/ui, not apps/dashboard/src.
      { find: /^cn$/, replacement: `${ui}/lib/utils.ts` },
      { find: /^@orbitid\/ui\/styles\.css$/, replacement: `${ui}/styles.css` },
      { find: /^@orbitid\/ui$/, replacement: `${ui}/index.ts` },
      { find: /^@\/components\/ui\/(.*)$/, replacement: `${ui}/components/ui/$1` },
      { find: /^@\/hooks\/(.*)$/, replacement: `${ui}/hooks/$1` },
      { find: /^@\//, replacement: root("./src/") },
    ],
  },
  server: { port: 5173, strictPort: true },
  build: { outDir: "dist", sourcemap: true },
  test: {
    environment: "jsdom",
    globals: true,
    css: false,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});

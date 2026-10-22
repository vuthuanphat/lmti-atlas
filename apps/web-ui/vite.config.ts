import { defineConfig } from 'vite';
export default defineConfig({
  // The automatic JSX runtime is configured once in tsconfig.json (react-jsx).
  build: { sourcemap: false, manifest: true, assetsInlineLimit: 0 },
  server: { host: '127.0.0.1', fs: { strict: true } }
});

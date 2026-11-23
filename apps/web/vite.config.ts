import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss(), reactRouter()],
  server: {
    port: 4700,
    strictPort: true,
    // Coder's port proxy (https://4700--dev--<workspace>--<owner>.coder.internal.limbic.ai)
    // sends its own host name. Only that domain: the app reads any repository
    // on this machine, so Vite's guard against other hosts stays on.
    allowedHosts: [".coder.internal.limbic.ai"],
  },
  // The server build loads the workspace packages from their own folders
  // (Node runs their TypeScript): bundled, @room/syntax can't find its
  // grammars, which it resolves from its own dependencies.
  environments: { ssr: { build: { rolldownOptions: { external: [/^@room\//] } } } },
});

import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// Vite config — proxies the Pipecat dev runner during `pnpm dev` so the
// React app can call `/api/offer` / `/start` / `/sessions/...` as
// same-origin requests. In production the bot lives behind your own
// reverse proxy (Caddy / nginx / Traefik) and the frontend is served
// from the same origin, so the relative URLs continue to work without
// CORS headaches.

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const botUrl = env.VITE_PIPECAT_BOT_URL ?? "http://localhost:7860";

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        "/api": { target: botUrl, changeOrigin: true },
        "/start": { target: botUrl, changeOrigin: true },
        "/sessions": { target: botUrl, changeOrigin: true },
      },
    },
  };
});

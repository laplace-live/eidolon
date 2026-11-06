import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type ProxyOptions } from "vite";

const BOT = "http://localhost:7860";
const DEV_ORIGIN = "http://127.0.0.1:5173";

// The bot refuses an Origin that isn't its own (`http://` + Host), and changeOrigin makes Host the
// bot's. Only this dev server's own origin is rewritten to match; any other passes through and is
// refused, so the proxy opens no cross-site path to the admin API.
const toBot: ProxyOptions = {
  target: BOT,
  changeOrigin: true,
  configure: (proxy) => {
    proxy.on("proxyReq", (proxyReq, req) => {
      if (req.headers.origin === DEV_ORIGIN) proxyReq.setHeader("origin", BOT);
    });
  },
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": resolve(import.meta.dirname, "src") } },
  server: {
    // Under Bun, "localhost" binds [::1] only, which refuses http://127.0.0.1:5173.
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: { "/api": toBot, "/mcp": toBot },
  },
});

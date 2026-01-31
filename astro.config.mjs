// @ts-check
import { defineConfig } from "astro/config";
import AstroPWA from "@vite-pwa/astro";
import compression from "vite-plugin-compression";

// https://astro.build/config
export default defineConfig({
  server: {
    port: 3000,
  },
  integrations: [
    AstroPWA({
      registerType: "autoUpdate",
      manifest: {
        name: "Terapeuta - Asystent Psycholog-Seksuolog",
        short_name: "Terapeuta",
        description: "Chatbot do porad psychologicznych i seksuologicznych",
        theme_color: "#6366f1",
        background_color: "#fafafa",
        display: "standalone",
        start_url: "/",
        icons: [
          {
            src: "/icons/icon-192.svg",
            sizes: "192x192",
            type: "image/svg+xml",
          },
          {
            src: "/icons/icon-512.svg",
            sizes: "512x512",
            type: "image/svg+xml",
          },
          {
            src: "/icons/icon-512.svg",
            sizes: "512x512",
            type: "image/svg+xml",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff,woff2}"],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/generativelanguage\.googleapis\.com\/.*/i,
            handler: "NetworkOnly",
          },
          {
            urlPattern: /\.(?:wasm|onnx)$/i,
            handler: "CacheFirst",
            options: {
              cacheName: "ml-models-cache",
              expiration: {
                maxEntries: 10,
                maxAgeSeconds: 60 * 60 * 24 * 30, // 30 days
              },
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
        ],
      },
    }),
  ],
  vite: {
    plugins: [
      compression({
        algorithm: "gzip",
        ext: ".gz",
      }),
      compression({
        algorithm: "brotliCompress",
        ext: ".br",
      }),
    ],
    optimizeDeps: {
      exclude: ["@huggingface/transformers"],
    },
    worker: {
      format: "es",
    },
  },
});

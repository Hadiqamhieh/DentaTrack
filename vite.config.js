import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // 'prompt' instead of 'autoUpdate' — autoUpdate reloads silently in
      // the background on its own schedule, which is exactly what let a
      // stale cached bundle keep running past a real deploy. 'prompt' lets
      // us detect a new version is ready and show a visible banner, so an
      // update is never invisible again.
      registerType: 'prompt',
      includeAssets: ['icons/apple-touch-icon.png'],
      manifest: {
        name: 'DentaTrack',
        short_name: 'DentaTrack',
        description: 'Financial tracking for dental associates — real-time P&L, deposit reconciliation, and tax-deductible expense tracking.',
        theme_color: '#0F6E56',
        background_color: '#f8fafc',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/api/'),
            handler: 'NetworkOnly',
          },
        ],
      },
    }),
  ],
});

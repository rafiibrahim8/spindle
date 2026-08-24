import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solid()],
  server: {
    host: '0.0.0.0',
    port: 5174,
    // Anchored patterns, not bare prefixes. A plain '/art' key also matches
    // '/artists', so the dev server would forward that client route to the
    // backend and a hard reload on the Artists page would 404 instead of
    // loading the app. A key beginning with '^' is treated as a RegExp, so
    // these match only the API and art paths themselves.
    proxy: {
      '^/api/': 'http://localhost:3001',
      '^/art/': 'http://localhost:3001'
    }
  }
});

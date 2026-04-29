import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solid()],
  server: {
    host: '0.0.0.0',
    port: 5174,
    proxy: {
      '/api': 'http://localhost:3001',
      '/art': 'http://localhost:3001'
    }
  }
});

import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative base so the static build runs from any sub-path of a static host.
  base: './',
  test: {
    include: ['src/**/*.test.ts'],
  },
});

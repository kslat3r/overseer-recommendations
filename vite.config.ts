/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

// Relative base so the build works from any project-Pages sub-path
// (https://kslat3r.github.io/overseer-recommendations/) or a local file server.
export default defineConfig({
  base: './',
  build: { target: 'es2022', sourcemap: false },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});

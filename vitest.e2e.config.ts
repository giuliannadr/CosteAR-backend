import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { E2E_CON_ROL_DE_APP } from './tests/db-dependent.mjs';

/** Esta suite inicia un proceso compilado; no comparte ciclo de vida con integracion. */
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    globals: true,
    environment: 'node',
    include: E2E_CON_ROL_DE_APP,
    globalSetup: ['./tests/integration/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 90_000,
    hookTimeout: 90_000,
  },
});

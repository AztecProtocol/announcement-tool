import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { pool: 'forks', singleFork: true, testTimeout: 15000 },
});

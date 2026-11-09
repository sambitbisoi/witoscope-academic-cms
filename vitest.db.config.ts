import { defineConfig } from 'vitest/config';

// Database tests: need this repo's local Supabase (`supabase start`) with the
// bootstrap and migrations applied. Run with `npm run test:db`.
export default defineConfig({
  test: {
    include: ['tests/**/*.db.test.ts'],
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});

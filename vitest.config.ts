import { defineConfig } from 'vitest/config';

// Unit tests only; database tests live in *.db.test.ts (vitest.db.config.ts).
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/**/*.db.test.ts', 'node_modules/**'],
  },
});

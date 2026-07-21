import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Delegated-worker worktrees are full repo checkouts — without this exclude,
    // vitest would re-run every test file it finds inside kept worktrees.
    exclude: ['**/node_modules/**', '.delegate/**'],
  },
})

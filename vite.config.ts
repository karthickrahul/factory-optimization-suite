import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Relative base so the app works on GitHub Pages under /<repo>/ and on any static host.
export default defineConfig({
  base: './',
  plugins: [react()],
  test: { include: ['src/**/*.test.ts'] },
})

import { defineConfig } from 'vite'
import { resolve } from 'path'
import { copyFileSync, mkdirSync, readFileSync } from 'fs'

export default defineConfig({
  plugins: [
    {
      name: 'copy-files',
      closeBundle() {
        mkdirSync('dist', { recursive: true })
        copyFileSync('public/manifest.json', 'dist/manifest.json')

        const contentScript = readFileSync('dist/content.js', 'utf8')
        if (/^\s*import\s/.test(contentScript)) {
          throw new Error('dist/content.js must be self-contained because Chrome content_scripts are not ES modules')
        }
      }
    }
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        content: resolve(__dirname, 'src/content/index.ts'),
        background: resolve(__dirname, 'src/background/index.ts'),
        team: resolve(__dirname, 'src/teamPage/index.ts')
      },
      output: {
        entryFileNames: '[name].js'
      }
    }
  }
})

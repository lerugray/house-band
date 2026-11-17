import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const here = fileURLToPath(new URL('.', import.meta.url))
const nm = (p: string) => resolve(here, 'node_modules', p)

const demo = process.env.DEMO || 'samples'

// Own package so the main house-band package stays lean. Pin bare imports for
// the vendored kit, which lives outside this package's node_modules.
// Build one self-contained entry at a time (`DEMO=samples|cowrite`) so the host
// can lazy-load demos/dist/<name>.js + <name>.css with no shared chunks.
export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      'react/jsx-runtime': nm('react/jsx-runtime'),
      'react/jsx-dev-runtime': nm('react/jsx-dev-runtime'),
      'react-dom/client': nm('react-dom/client'),
      'react-dom': nm('react-dom'),
      react: nm('react'),
      'lucide-react': nm('lucide-react'),
    },
  },
  build: {
    target: 'es2022',
    outDir: resolve(here, 'dist'),
    emptyOutDir: demo === 'samples',
    cssCodeSplit: false,
    rollupOptions: {
      input: {
        [demo]: resolve(here, `${demo}/index.tsx`),
      },
      output: {
        entryFileNames: '[name].js',
        assetFileNames: `${demo}[extname]`,
        format: 'es',
        inlineDynamicImports: true,
      },
    },
  },
})

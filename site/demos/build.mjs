import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const viteBin = resolve(here, 'node_modules/vite/bin/vite.js')

for (const demo of ['samples', 'cowrite']) {
  const r = spawnSync(process.execPath, [viteBin, 'build'], {
    cwd: here,
    env: { ...process.env, DEMO: demo },
    stdio: 'inherit',
  })
  if (r.status) process.exit(r.status ?? 1)
}

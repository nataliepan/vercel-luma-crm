// Runs in the test worker process before each test file (via setupFiles in jest.config.ts).
// Why here not globalSetup: globalSetup runs in a separate process — env vars set there
// don't reach test workers. setupFiles runs in the same context as tests, so
// process.env mutations are visible to all imports including SDK clients.
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'

let repoRoot = __dirname
try {
  const commonDir = execSync('git rev-parse --git-common-dir', {
    cwd: __dirname,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
  const absCommonDir = path.isAbsolute(commonDir)
    ? commonDir
    : path.join(__dirname, commonDir)
  repoRoot = path.dirname(absCommonDir)
} catch {
  // Not in a git repo — fall back to __dirname
}

const envPath = path.join(repoRoot, '.env.local')
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const raw = trimmed.slice(eqIdx + 1).trim()
    const val = raw.replace(/^(['"])(.*)\1$/, '$2')
    if (!process.env[key]) process.env[key] = val
  }
}

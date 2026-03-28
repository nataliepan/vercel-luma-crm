import type { Config } from 'jest'
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

// Why fileURLToPath: jest.config.ts is loaded as an ES module (no __dirname).
// import.meta.url gives us the file URL; fileURLToPath converts it to a path.
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Load .env.local from the main repo root into the main Jest process.
// Why here (not setupFiles): Jest workers are forked from the main process and
// inherit its environment. Setting process.env here ensures every worker starts
// with the correct API keys — no per-worker setup file needed.
// Why --git-common-dir: in a worktree __dirname is the worktree root, not the
// main repo root. --git-common-dir points to the shared .git dir; its parent
// is always the main repo root where .env.local lives.
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

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // Why moduleNameMapper: Next.js uses path aliases (@/*). Jest doesn't know
  // about them by default — this maps @/* to the project root.
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
  },
  // Why transform: ts-jest handles TypeScript compilation for tests so we don't
  // need a separate build step.
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: {
        // Override to commonjs for Jest — Next.js uses ESM bundler mode which
        // Jest can't handle natively. Tests run in Node CJS context.
        module: 'commonjs',
        moduleResolution: 'node',
      },
    }],
  },
  testMatch: ['**/__tests__/**/*.test.ts'],
  // Why roots: Jest scans the whole project by default, including .claude/worktrees/*
  // which contain duplicate package.json files causing "Haste module naming collision".
  // Restricting roots to only the directories Jest needs prevents worktree packages
  // from being indexed alongside the main project.
  roots: ['<rootDir>/__tests__', '<rootDir>/lib'],
}

export default config

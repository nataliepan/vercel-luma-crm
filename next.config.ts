import type { NextConfig } from "next";
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

// Always load .env.local from the main repo root, even when Next.js is running
// from a nested git worktree (.claude/worktrees/*).
//
// Why --git-common-dir not --show-toplevel: in a worktree, --show-toplevel
// returns the worktree's own root (e.g. .claude/worktrees/hungry-noether/).
// --git-common-dir returns the *shared* .git directory of the main repo
// (/path/to/repo/.git), so path.dirname() of that is always the true root
// where .env.local lives — regardless of how deeply nested the worktree is.
let repoRoot = __dirname;
try {
  const commonDir = execSync('git rev-parse --git-common-dir', {
    cwd: __dirname,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
  // commonDir is '.git' (relative) in the main repo, absolute path in worktrees
  const absCommonDir = path.isAbsolute(commonDir)
    ? commonDir
    : path.join(__dirname, commonDir);
  repoRoot = path.dirname(absCommonDir);
} catch {
  // Not in a git repo (e.g. CI with shallow clone) — fall back to __dirname
}

const envPath = path.join(repoRoot, '.env.local');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const raw = trimmed.slice(eqIdx + 1).trim();
    // Strip optional surrounding quotes from value
    const val = raw.replace(/^(['"])(.*)\1$/, '$2');
    // Don't overwrite vars already set in the environment (e.g. CI secrets)
    if (!process.env[key]) process.env[key] = val;
  }
}

const nextConfig: NextConfig = {};

export default nextConfig;

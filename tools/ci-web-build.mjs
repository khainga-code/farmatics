import { execSync } from 'node:child_process';

// Workers Builds runs this install with WORKERS_CI=1 and no build command
// configured, so the deploy command would otherwise find no assets to upload.
if (process.env['WORKERS_CI'] === '1') {
  execSync('pnpm --filter @farmatics/web build', { stdio: 'inherit' });
}

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));

function ignored(path: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '--no-index', '-q', path], { cwd: root });
    return true;
  } catch {
    return false;
  }
}

describe('.gitignore', () => {
  it('ignores credential files so they cannot be staged by accident', () => {
    for (const path of ['.env', '.env.production', 'deploy.pem', 'signing.key', '.secrets/token', '.secrets/anything-else']) {
      expect(ignored(path), path).toBe(true);
    }
  });

  it('keeps the example env files and the secrets README trackable', () => {
    for (const path of ['.env.example', '.env.local.example', '.secrets/README.md']) {
      expect(ignored(path), path).toBe(false);
    }
  });
});

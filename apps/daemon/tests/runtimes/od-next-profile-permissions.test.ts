import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveOpenCodeEditBaseDir } from '../../src/runtimes/opencode-permissions.js';
import * as invocation from '../../src/runtimes/invocation.js';

// HTTP launch coverage lives with the isolated public-run fixtures in
// od-next-automatic-simple-server.test.ts, including ordinary/BYOK failures.
describe('OpenCode resource edit base', () => {
  let fixtureDir: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
    fixtureDir = undefined;
  });

  it('resolves the edit base for non-Git projects and nested Git workspaces', async () => {
    fixtureDir = await mkdtemp(path.join(os.tmpdir(), 'od-profile-worktree-'));
    expect(await resolveOpenCodeEditBaseDir(fixtureDir)).toBe(path.parse(fixtureDir).root);
    execFileSync('git', ['init', '--quiet', fixtureDir]);
    const nested = path.join(fixtureDir, 'nested');
    await mkdir(nested);
    expect(await resolveOpenCodeEditBaseDir(nested)).toBe(await realpath(fixtureDir));
  });

  it('does not assume a volume-root edit base when the Git probe fails unexpectedly', async () => {
    vi.spyOn(invocation, 'execAgentFile').mockRejectedValueOnce(new Error('probe failed'));
    await expect(resolveOpenCodeEditBaseDir(os.tmpdir())).rejects.toThrow('probe failed');
  });

  it('does not treat a missing Git executable as proof of a non-Git workspace', async () => {
    const failure = Object.assign(new Error('Git executable missing'), { code: 'ENOENT' });
    vi.spyOn(invocation, 'execAgentFile').mockRejectedValueOnce(failure);
    await expect(resolveOpenCodeEditBaseDir(os.tmpdir())).rejects.toBe(failure);
  });

});

import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { startServer } from '../../src/server.js';
import { writeMemoryConfig } from '../../src/memory.js';
import { resolveOpenCodeEditBaseDir } from '../../src/runtimes/opencode-permissions.js';
import * as invocation from '../../src/runtimes/invocation.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');
const PROFILE_ROOT = path.join(REPO_ROOT, 'plugins/_official/scenarios/od-next-strategy/assets/task-profiles');

type StartedServer = { url: string; server: Server; shutdown?: () => Promise<void> | void };
type Invocation = {
  prompt: string;
  config: { permission?: { external_directory?: Record<string, string>; edit?: Record<string, string> } };
};

describe('OD Next task-profile permissions at the OpenCode launch boundary', () => {
  let started: StartedServer | undefined;
  let fixtureDir: string | undefined;

  afterEach(async () => {
    try {
      await started?.shutdown?.();
      await new Promise<void>((resolve) => started?.server.close(() => resolve()) ?? resolve());
    } finally {
      started = undefined;
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
      fixtureDir = undefined;
    }
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

  it.each([
    ['opencode', true],
    ['byok-opencode', true],
    ['opencode', false],
  ] as const)('%s grants only the task-profile subtree when OD Next is %s', async (agentId, active) => {
    fixtureDir = await mkdtemp(path.join(os.tmpdir(), 'od-profile-permissions-'));
    const logPath = path.join(fixtureDir, 'invocation.json');
    const script = path.join(fixtureDir, 'opencode.cjs');
    const bin = process.platform === 'win32' ? path.join(fixtureDir, 'opencode.cmd') : script;
    await writeFile(script, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('1.18.18'); process.exit(0); }
if (args.includes('--help')) { console.log('opencode run --format json --dir --session --model'); process.exit(0); }
if (args[0] === 'models') { console.log('fixture/test-model'); process.exit(0); }
if (args[0] !== 'run') process.exit(0);
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(logPath)}, JSON.stringify({ prompt, config: JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}') }));
  console.log(JSON.stringify({ type: 'text', part: { text: 'Permission configuration captured.' } }));
  console.log(JSON.stringify({ type: 'step_finish', part: { tokens: { input: 1, output: 1 } } }));
});
`);
    if (process.platform === 'win32') {
      await writeFile(bin, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    } else {
      await chmod(script, 0o755);
    }
    const home = path.join(fixtureDir, 'home');
    await mkdir(home);
    vi.stubEnv('OD_AGENT_HOME', home);
    vi.stubEnv('OPENCODE_BIN', bin);
    vi.stubEnv('OD_NEXT_STRATEGY_ROLLOUT', active ? 'active' : 'off');
    await writeMemoryConfig(process.env.OD_DATA_DIR!, { enabled: false, extraction: null });
    started = await startServer({ port: 0, returnServer: true }) as StartedServer;

    const created = await fetch(`${started.url}/api/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: randomUUID(), name: 'Task-profile permission regression', metadata: { kind: 'prototype' }, conversationMode: 'design', skipDiscoveryBrief: true }),
    });
    const project = await created.json() as { project: { id: string }; conversationId: string };
    expect(created.status, JSON.stringify(project)).toBe(200);
    const response = await fetch(`${started.url}/api/runs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: project.project.id, conversationId: project.conversationId,
        agentId, message: 'Create a prototype.', model: 'test-model',
        ...(agentId === 'byok-opencode' ? { byokProvider: {
          protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: '', requiresApiKey: false, model: 'test-model',
        } } : {}),
      }),
    });
    const run = await response.json() as { runId: string; strategyTask?: unknown };
    expect(response.status, JSON.stringify(run)).toBe(202);
    expect(Boolean(run.strategyTask)).toBe(active);
    await expect.poll(async () => {
      try { return JSON.parse(await readFile(logPath, 'utf8')) as Invocation; } catch { return null; }
    }).not.toBeNull();
    const invocation = JSON.parse(await readFile(logPath, 'utf8')) as Invocation;
    await expect.poll(async () => {
      const status = await fetch(`${started!.url}/api/runs/${run.runId}`);
      return (await status.json() as { status: string }).status;
    }).toMatch(/^(succeeded|failed|canceled)$/);
    const rules = invocation.config.permission?.external_directory ?? {};
    if (active) {
      // The shipped discovery prompt, rather than this fixture, tells the
      // runtime where its rule cards live. Those exact paths must be admitted.
      expect(invocation.prompt).toContain(PROFILE_ROOT);
      expect(await readFile(path.join(PROFILE_ROOT, 'prototype.md'), 'utf8')).not.toBe('');
      for (const entry of [PROFILE_ROOT, path.join(PROFILE_ROOT, '*'), path.join(PROFILE_ROOT, '**')]) {
        expect(rules[entry], `missing permission for advertised task profiles: ${entry}`).toBe('allow');
        expect(invocation.config.permission?.edit?.[entry]).toBe('deny');
      }
      expect(invocation.config.permission?.edit?.[
        path.join(path.relative(path.parse(PROFILE_ROOT).root, PROFILE_ROOT), '**')
      ]).toBe('deny');
    } else {
      expect(rules[PROFILE_ROOT]).toBeUndefined();
      expect(invocation.config.permission?.edit).toBeUndefined();
    }
    // No wildcard, whole plugin, sibling plugin, or arbitrary user directory
    // is authorized as a side effect of admitting this bundled resource.
    for (const outside of ['*', path.dirname(PROFILE_ROOT), path.resolve(PROFILE_ROOT, '../..'), fixtureDir]) {
      expect(rules[outside]).toBeUndefined();
    }
  });
});

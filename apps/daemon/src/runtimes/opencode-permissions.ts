import path from 'node:path';
import { agentCapabilities } from './capabilities.js';
import { execAgentFile } from './invocation.js';
import type { RuntimeAgentDef } from './types.js';

export const OPENCODE_SKIP_PERMISSIONS_FLAG = '--dangerously-skip-permissions';
export const OPENCODE_WORKSPACE_DIR_FLAG = '--dir';

export const OPENCODE_PERMISSION_CAPABILITY = {
  helpArgs: ['run', '--help'],
  capabilityFlags: {
    [OPENCODE_SKIP_PERMISSIONS_FLAG]: 'skipPermissions',
  },
} satisfies Pick<RuntimeAgentDef, 'helpArgs' | 'capabilityFlags'>;

export function appendOpenCodePermissionBypass(args: string[], agentId: string): void {
  if (agentCapabilities.get(agentId)?.skipPermissions) {
    args.push(OPENCODE_SKIP_PERMISSIONS_FLAG);
  }
}

/** OpenCode edit checks use the Git worktree, or the volume root outside Git. */
export async function resolveOpenCodeEditBaseDir(cwd: string): Promise<string> {
  try {
    const { stdout } = await execAgentFile('git', ['rev-parse', '--show-toplevel'], {
      cwd, timeout: 2_000, env: { ...process.env, LC_ALL: 'C' },
    });
    const root = String(stdout).trim();
    if (path.isAbsolute(root)) return root;
    throw new Error('Git did not return an absolute OpenCode edit base.');
  } catch (error) {
    const failure = error as { code?: unknown; stderr?: unknown };
    if (failure.code !== 'ENOENT' && !String(failure.stderr ?? '').includes('not a git repository')) {
      // An unknown worktree must not produce a resource grant with edit rules
      // based on an unrelated root. The caller retains its no-config failure.
      throw error;
    }
  }
  return path.parse(path.resolve(cwd)).root;
}

/**
 * Pin OpenCode's workspace to the resolved project directory.
 *
 * OpenCode does not treat its process cwd as the project: it walks up to the
 * nearest enclosing git root and adopts THAT as the worktree (verified with
 * `opencode debug scrap`, whose every registered project is a git root). A
 * managed project directory is not a git repository, and a development install
 * keeps the daemon data directory under the repository root — so OpenCode walks
 * past the project and adopts the whole Open Design checkout.
 *
 * The consequences are all silent: the agent names the repository root as its
 * workspace and writes the deliverable there, the project directory stays
 * empty, `snapshotProjectArtifactsAsync(cwd)` sees nothing, and the Run reports
 * `no_artifact`. `permission.external_directory` cannot catch it either — once
 * the repository is the worktree, writing inside it is an in-project write.
 *
 * Sent unconditionally, matching the BYOK OpenCode definition that already
 * carried this workaround. Gating it on the `--help` capability probe would
 * turn a missing flag back into the silent data-loss bug; an OpenCode build
 * without `--dir` should fail loudly at spawn instead.
 */
export function appendOpenCodeWorkspaceDir(
  args: string[],
  cwd: string | null | undefined,
): void {
  if (typeof cwd !== 'string' || cwd.length === 0) return;
  args.push(OPENCODE_WORKSPACE_DIR_FLAG, cwd);
}

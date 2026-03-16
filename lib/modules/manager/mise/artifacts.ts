import { isNonEmptyArray, isString } from '@sindresorhus/is';
import upath from 'upath';
import { TEMPORARY_ERROR } from '../../../constants/error-messages.ts';
import { logger } from '../../../logger/index.ts';
import { exec } from '../../../util/exec/index.ts';
import type { ExecOptions, ToolConstraint } from '../../../util/exec/types.ts';
import {
  deleteLocalFile,
  ensureCacheDir,
  getSiblingFileName,
  readLocalFile,
  writeLocalFile,
} from '../../../util/fs/index.ts';
import { find } from '../../../util/host-rules.ts';
import type { UpdateArtifact, UpdateArtifactsResult } from '../types.ts';
import type { MiseFile, MiseMinVersion } from './schema.ts';
import { parseTomlFile } from './utils.ts';

/**
 * Backends that require an external CLI to resolve versions during `mise lock`.
 * Maps the mise backend prefix to the containerbase tool name.
 * @link https://mise.jdx.dev/dev-tools/backends/
 */
const backendToolMap: Record<string, string> = {
  npm: 'node',
  pipx: 'python',
  cargo: 'rust',
  gem: 'ruby',
  go: 'golang',
  dotnet: 'dotnet',
  spm: 'swift',
};

function getBackendToolConstraints(
  miseConfig: MiseFile | null,
): ToolConstraint[] {
  if (!miseConfig?.tools) {
    return [];
  }
  return [
    ...new Set(
      Object.keys(miseConfig.tools)
        .filter((key) => key.includes(':'))
        .map((key) => backendToolMap[key.substring(0, key.indexOf(':'))])
        .filter(isString),
    ),
  ].map((toolName) => ({ toolName }));
}

function getMiseConstraint(
  minVersion: MiseMinVersion | undefined,
): string | undefined {
  if (!minVersion) {
    return undefined;
  }
  if (typeof minVersion === 'string') {
    return `>= ${minVersion}`;
  }
  const version = minVersion.hard ?? minVersion.soft;
  return version ? `>= ${version}` : undefined;
}

export async function updateArtifacts({
  packageFileName,
  updatedDeps,
  newPackageFileContent,
  config,
}: UpdateArtifact): Promise<UpdateArtifactsResult[] | null> {
  logger.debug(`mise.updateArtifacts(${packageFileName})`);

  if (!isNonEmptyArray(updatedDeps) && !config.isLockFileMaintenance) {
    logger.debug('No updated mise deps - returning null');
    return null;
  }

  const lockFileName = getSiblingFileName(packageFileName, 'mise.lock');
  const existingLockFileContent = await readLocalFile(lockFileName, 'utf8');
  if (!existingLockFileContent) {
    logger.debug('No mise.lock found');
    return null;
  }

  try {
    await writeLocalFile(packageFileName, newPackageFileContent);

    // `mise lock` is non-deterministic -- it appends to the lockfile, leaving
    // behind old versions.
    await deleteLocalFile(lockFileName);

    const miseConfig = parseTomlFile(newPackageFileContent, packageFileName);
    const constraint =
      config.constraints?.mise ?? getMiseConstraint(miseConfig?.min_version);

    const MISE_CACHE_DIR = await ensureCacheDir('mise');

    const githubToken = find({
      hostType: 'github',
      url: 'https://api.github.com/',
    })?.token;

    const execOptions: ExecOptions = {
      cwdFile: packageFileName,
      docker: {},
      toolConstraints: [
        ...getBackendToolConstraints(miseConfig),
        { toolName: 'mise', constraint },
      ],
      extraEnv: {
        // Preserve internal cache to speed up lockfile regeneration
        // See https://mise.jdx.dev/configuration.html#mise-cache-dir
        MISE_CACHE_DIR,

        // Automatically answer yes to prompts (to trust mise.toml files)
        // See https://mise.jdx.dev/configuration/settings.html#yes
        MISE_YES: '1',

        // Explicitly use `cwdFile` to support config files with differing names
        // See https://mise.jdx.dev/configuration/settings.html#override_config_filenames
        MISE_OVERRIDE_CONFIG_FILENAMES: upath.basename(packageFileName),

        // Pass GitHub token to avoid rate limiting during version resolution
        // See https://mise.jdx.dev/configuration.html#mise-github-token
        MISE_GITHUB_TOKEN: githubToken,
      },
    };

    await exec('mise lock', execOptions);

    const newLockFileContent = await readLocalFile(lockFileName, 'utf8');
    if (!newLockFileContent || existingLockFileContent === newLockFileContent) {
      return null;
    }

    return [
      {
        file: {
          type: 'addition',
          path: lockFileName,
          contents: newLockFileContent,
        },
      },
    ];
  } catch (err) {
    if (err.message === TEMPORARY_ERROR) {
      throw err;
    }
    logger.warn({ err }, 'Failed to update mise.lock');
    return [
      {
        artifactError: {
          lockFile: lockFileName,
          stderr: err.message,
        },
      },
    ];
  }
}

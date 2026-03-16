import { mockDeep } from 'vitest-mock-extended';
import { envMock, mockExecAll } from '~test/exec-util.ts';
import { env, fs, hostRules } from '~test/util.ts';
import { GlobalConfig } from '../../../config/global.ts';
import type { RepoGlobalConfig } from '../../../config/types.ts';
import { TEMPORARY_ERROR } from '../../../constants/error-messages.ts';
import * as docker from '../../../util/exec/docker/index.ts';
import { ExecError } from '../../../util/exec/exec-error.ts';
import * as _datasource from '../../datasource/index.ts';
import type { UpdateArtifact } from '../types.ts';
import { updateArtifacts } from './artifacts.ts';

vi.mock('../../../util/exec/env.ts');
vi.mock('../../../util/fs/index.ts');
vi.mock('../../../util/host-rules.ts');
vi.mock('../../datasource/index.ts', () => mockDeep());

process.env.CONTAINERBASE = 'true';

const datasource = vi.mocked(_datasource);

const adminConfig: RepoGlobalConfig = {
  localDir: '/tmp/github/some/repo',
  cacheDir: '/tmp/cache',
  containerbaseDir: '/tmp/cache/containerbase',
  dockerSidecarImage: 'ghcr.io/renovatebot/base-image',
};

describe('modules/manager/mise/artifacts', () => {
  describe('updateArtifacts()', () => {
    let updateArtifact: UpdateArtifact;

    beforeEach(() => {
      env.getChildProcessEnv.mockReturnValue(envMock.basic);
      GlobalConfig.set(adminConfig);
      docker.resetPrefetchedImages();
      hostRules.find.mockReturnValue({ token: 'ghp_test-token' });
      updateArtifact = {
        packageFileName: 'mise.toml',
        newPackageFileContent: '[tools]\nnode = "22.0.0"\n',
        config: {},
        updatedDeps: [{ depName: 'node' }],
      };
    });

    it('returns null if no updatedDeps and not lock file maintenance', async () => {
      expect(
        await updateArtifacts({
          ...updateArtifact,
          updatedDeps: [],
        }),
      ).toBeNull();
    });

    it('returns null if no mise.lock found', async () => {
      fs.getSiblingFileName.mockReturnValueOnce('mise.lock');
      fs.readLocalFile.mockResolvedValueOnce(null);
      expect(await updateArtifacts(updateArtifact)).toBeNull();
    });

    it('returns null if lockfile unchanged after exec', async () => {
      fs.getSiblingFileName.mockReturnValueOnce('mise.lock');
      fs.readLocalFile.mockResolvedValueOnce('existing lock content');
      fs.ensureCacheDir.mockResolvedValueOnce('/tmp/cache/others/mise');
      mockExecAll();
      fs.readLocalFile.mockResolvedValueOnce('existing lock content');
      expect(await updateArtifacts(updateArtifact)).toBeNull();
    });

    it('returns updated mise.lock when content changes', async () => {
      fs.getSiblingFileName.mockReturnValueOnce('mise.lock');
      fs.readLocalFile.mockResolvedValueOnce('old lock content');
      fs.ensureCacheDir.mockResolvedValueOnce('/tmp/cache/others/mise');
      const execSnapshots = mockExecAll();
      fs.readLocalFile.mockResolvedValueOnce('new lock content');

      expect(await updateArtifacts(updateArtifact)).toEqual([
        {
          file: {
            type: 'addition',
            path: 'mise.lock',
            contents: 'new lock content',
          },
        },
      ]);
      expect(fs.writeLocalFile).toHaveBeenCalledWith(
        'mise.toml',
        '[tools]\nnode = "22.0.0"\n',
      );
      expect(fs.deleteLocalFile).toHaveBeenCalledWith('mise.lock');
      expect(execSnapshots).toMatchObject([
        {
          cmd: 'mise lock',
          options: {
            env: {
              MISE_YES: '1',
              MISE_OVERRIDE_CONFIG_FILENAMES: 'mise.toml',
              MISE_GITHUB_TOKEN: 'ghp_test-token',
            },
          },
        },
      ]);
    });

    it('returns updated mise.lock for lock file maintenance', async () => {
      fs.getSiblingFileName.mockReturnValueOnce('mise.lock');
      fs.readLocalFile.mockResolvedValueOnce('old lock content');
      fs.ensureCacheDir.mockResolvedValueOnce('/tmp/cache/others/mise');
      const execSnapshots = mockExecAll();
      fs.readLocalFile.mockResolvedValueOnce('new lock content');

      expect(
        await updateArtifacts({
          ...updateArtifact,
          config: { isLockFileMaintenance: true },
        }),
      ).toEqual([
        {
          file: {
            type: 'addition',
            path: 'mise.lock',
            contents: 'new lock content',
          },
        },
      ]);
      expect(fs.deleteLocalFile).toHaveBeenCalledWith('mise.lock');
      expect(execSnapshots).toMatchObject([
        {
          cmd: 'mise lock',
          options: {
            env: {
              MISE_YES: '1',
              MISE_OVERRIDE_CONFIG_FILENAMES: 'mise.toml',
              MISE_GITHUB_TOKEN: 'ghp_test-token',
            },
          },
        },
      ]);
    });

    it('resolves lockfile in subdirectory', async () => {
      fs.getSiblingFileName.mockReturnValueOnce('sub/mise.lock');
      fs.readLocalFile.mockResolvedValueOnce('old lock content');
      fs.ensureCacheDir.mockResolvedValueOnce('/tmp/cache/others/mise');
      mockExecAll();
      fs.readLocalFile.mockResolvedValueOnce('new lock content');

      expect(
        await updateArtifacts({
          ...updateArtifact,
          packageFileName: 'sub/mise.toml',
        }),
      ).toEqual([
        {
          file: {
            type: 'addition',
            path: 'sub/mise.lock',
            contents: 'new lock content',
          },
        },
      ]);
    });

    it('returns artifact error on exec failure', async () => {
      fs.getSiblingFileName.mockReturnValueOnce('mise.lock');
      fs.readLocalFile.mockResolvedValueOnce('old lock content');
      fs.ensureCacheDir.mockResolvedValueOnce('/tmp/cache/others/mise');
      mockExecAll(new Error('mise lock failed'));

      expect(await updateArtifacts(updateArtifact)).toEqual([
        {
          artifactError: {
            lockFile: 'mise.lock',
            stderr: 'mise lock failed',
          },
        },
      ]);
    });

    it('rethrows temporary error', async () => {
      fs.getSiblingFileName.mockReturnValueOnce('mise.lock');
      fs.readLocalFile.mockResolvedValueOnce('old lock content');
      fs.ensureCacheDir.mockResolvedValueOnce('/tmp/cache/others/mise');
      const execError = new ExecError(TEMPORARY_ERROR, {
        cmd: '',
        stdout: '',
        stderr: '',
        options: {},
      });
      mockExecAll(execError);

      await expect(updateArtifacts(updateArtifact)).rejects.toThrow(
        TEMPORARY_ERROR,
      );
    });

    it('passes mise constraint to exec', async () => {
      fs.getSiblingFileName.mockReturnValueOnce('mise.lock');
      fs.readLocalFile.mockResolvedValueOnce('old lock content');
      fs.ensureCacheDir.mockResolvedValueOnce('/tmp/cache/others/mise');
      const execSnapshots = mockExecAll();
      fs.readLocalFile.mockResolvedValueOnce('new lock content');

      await updateArtifacts({
        ...updateArtifact,
        config: { constraints: { mise: '2025.1.0' } },
      });

      expect(execSnapshots).toMatchObject([
        {
          cmd: 'mise lock',
          options: {
            env: {
              MISE_YES: '1',
              MISE_OVERRIDE_CONFIG_FILENAMES: 'mise.toml',
              MISE_GITHUB_TOKEN: 'ghp_test-token',
            },
          },
        },
      ]);
    });

    it('extracts min_version string as constraint', async () => {
      GlobalConfig.set({ ...adminConfig, binarySource: 'install' });
      fs.getSiblingFileName.mockReturnValueOnce('mise.lock');
      fs.readLocalFile.mockResolvedValueOnce('old lock content');
      fs.ensureCacheDir.mockResolvedValueOnce('/tmp/cache/others/mise');
      const execSnapshots = mockExecAll();
      fs.readLocalFile.mockResolvedValueOnce('new lock content');
      datasource.getPkgReleases.mockResolvedValueOnce({
        releases: [
          { version: '2024.9.0' },
          { version: '2024.11.1' },
          { version: '2025.1.0' },
        ],
      });

      await updateArtifacts({
        ...updateArtifact,
        newPackageFileContent:
          'min_version = "2024.11.1"\n\n[tools]\nnode = "22.0.0"\n',
      });

      expect(execSnapshots).toMatchObject([
        { cmd: 'install-tool mise 2025.1.0' },
        { cmd: 'mise lock' },
      ]);
    });

    it('extracts min_version.hard as constraint', async () => {
      GlobalConfig.set({ ...adminConfig, binarySource: 'install' });
      fs.getSiblingFileName.mockReturnValueOnce('mise.lock');
      fs.readLocalFile.mockResolvedValueOnce('old lock content');
      fs.ensureCacheDir.mockResolvedValueOnce('/tmp/cache/others/mise');
      const execSnapshots = mockExecAll();
      fs.readLocalFile.mockResolvedValueOnce('new lock content');
      datasource.getPkgReleases.mockResolvedValueOnce({
        releases: [
          { version: '2024.9.0' },
          { version: '2024.11.1' },
          { version: '2025.1.0' },
        ],
      });

      await updateArtifacts({
        ...updateArtifact,
        newPackageFileContent:
          'min_version = { hard = "2024.11.1", soft = "2024.9.0" }\n\n[tools]\nnode = "22.0.0"\n',
      });

      expect(execSnapshots).toMatchObject([
        { cmd: 'install-tool mise 2025.1.0' },
        { cmd: 'mise lock' },
      ]);
    });

    it('prefers config.constraints.mise over min_version', async () => {
      GlobalConfig.set({ ...adminConfig, binarySource: 'install' });
      fs.getSiblingFileName.mockReturnValueOnce('mise.lock');
      fs.readLocalFile.mockResolvedValueOnce('old lock content');
      fs.ensureCacheDir.mockResolvedValueOnce('/tmp/cache/others/mise');
      const execSnapshots = mockExecAll();
      fs.readLocalFile.mockResolvedValueOnce('new lock content');
      datasource.getPkgReleases.mockResolvedValueOnce({
        releases: [
          { version: '2024.9.0' },
          { version: '2024.11.1' },
          { version: '2025.1.0' },
        ],
      });

      await updateArtifacts({
        ...updateArtifact,
        newPackageFileContent:
          'min_version = "2024.11.1"\n\n[tools]\nnode = "22.0.0"\n',
        config: { constraints: { mise: '2024.9.0' } },
      });

      expect(execSnapshots).toMatchObject([
        { cmd: 'install-tool mise 2024.9.0' },
        { cmd: 'mise lock' },
      ]);
    });

    it('returns null if lockfile is null after exec', async () => {
      fs.getSiblingFileName.mockReturnValueOnce('mise.lock');
      fs.readLocalFile.mockResolvedValueOnce('old lock content');
      fs.ensureCacheDir.mockResolvedValueOnce('/tmp/cache/others/mise');
      mockExecAll();
      fs.readLocalFile.mockResolvedValueOnce(null);

      expect(await updateArtifacts(updateArtifact)).toBeNull();
    });

    it('returns updated mise.lock using docker', async () => {
      GlobalConfig.set({ ...adminConfig, binarySource: 'docker' });
      fs.getSiblingFileName.mockReturnValueOnce('mise.lock');
      fs.readLocalFile.mockResolvedValueOnce('old lock content');
      fs.ensureCacheDir.mockResolvedValueOnce('/tmp/cache/others/mise');
      const execSnapshots = mockExecAll();
      fs.readLocalFile.mockResolvedValueOnce('new lock content');
      datasource.getPkgReleases.mockResolvedValueOnce({
        releases: [{ version: '2025.1.0' }],
      });

      expect(await updateArtifacts(updateArtifact)).toEqual([
        {
          file: {
            type: 'addition',
            path: 'mise.lock',
            contents: 'new lock content',
          },
        },
      ]);
      expect(execSnapshots).toMatchObject([
        { cmd: 'docker pull ghcr.io/renovatebot/base-image' },
        { cmd: 'docker ps --filter name=renovate_sidecar -aq' },
        {
          cmd:
            'docker run --rm --name=renovate_sidecar --label=renovate_child ' +
            '-v "/tmp/github/some/repo":"/tmp/github/some/repo" ' +
            '-v "/tmp/cache":"/tmp/cache" ' +
            '-e MISE_CACHE_DIR ' +
            '-e MISE_YES ' +
            '-e MISE_OVERRIDE_CONFIG_FILENAMES ' +
            '-e MISE_GITHUB_TOKEN ' +
            '-e CONTAINERBASE_CACHE_DIR ' +
            '-w "/tmp/github/some/repo" ' +
            'ghcr.io/renovatebot/base-image ' +
            'bash -l -c "' +
            'install-tool mise 2025.1.0 ' +
            '&& ' +
            'mise lock' +
            '"',
        },
      ]);
    });

    it('returns updated mise.lock using install mode', async () => {
      GlobalConfig.set({ ...adminConfig, binarySource: 'install' });
      fs.getSiblingFileName.mockReturnValueOnce('mise.lock');
      fs.readLocalFile.mockResolvedValueOnce('old lock content');
      fs.ensureCacheDir.mockResolvedValueOnce('/tmp/cache/others/mise');
      const execSnapshots = mockExecAll();
      fs.readLocalFile.mockResolvedValueOnce('new lock content');
      datasource.getPkgReleases.mockResolvedValueOnce({
        releases: [{ version: '2025.1.0' }],
      });

      expect(await updateArtifacts(updateArtifact)).toEqual([
        {
          file: {
            type: 'addition',
            path: 'mise.lock',
            contents: 'new lock content',
          },
        },
      ]);
      expect(execSnapshots).toMatchObject([
        { cmd: 'install-tool mise 2025.1.0' },
        { cmd: 'mise lock' },
      ]);
    });

    it('adds node tool constraint for npm backend', async () => {
      GlobalConfig.set({ ...adminConfig, binarySource: 'install' });
      fs.getSiblingFileName.mockReturnValueOnce('mise.lock');
      fs.readLocalFile.mockResolvedValueOnce('old lock content');
      fs.ensureCacheDir.mockResolvedValueOnce('/tmp/cache/others/mise');
      const execSnapshots = mockExecAll();
      fs.readLocalFile.mockResolvedValueOnce('new lock content');
      datasource.getPkgReleases
        .mockResolvedValueOnce({ releases: [{ version: '22.0.0' }] })
        .mockResolvedValueOnce({ releases: [{ version: '2025.1.0' }] });

      await updateArtifacts({
        ...updateArtifact,
        newPackageFileContent:
          '[tools]\n"npm:prettier" = "3.0.0"\nnode = "22.0.0"\n',
      });

      expect(execSnapshots).toMatchObject([
        { cmd: 'install-tool node 22.0.0' },
        { cmd: 'install-tool mise 2025.1.0' },
        { cmd: 'mise lock' },
      ]);
    });

    it('adds multiple backend tool constraints', async () => {
      GlobalConfig.set({ ...adminConfig, binarySource: 'install' });
      fs.getSiblingFileName.mockReturnValueOnce('mise.lock');
      fs.readLocalFile.mockResolvedValueOnce('old lock content');
      fs.ensureCacheDir.mockResolvedValueOnce('/tmp/cache/others/mise');
      const execSnapshots = mockExecAll();
      fs.readLocalFile.mockResolvedValueOnce('new lock content');
      datasource.getPkgReleases
        .mockResolvedValueOnce({ releases: [{ version: '22.0.0' }] })
        .mockResolvedValueOnce({ releases: [{ version: '3.13.0' }] })
        .mockResolvedValueOnce({ releases: [{ version: '2025.1.0' }] });

      await updateArtifacts({
        ...updateArtifact,
        newPackageFileContent:
          '[tools]\n"npm:prettier" = "3.0.0"\n"pipx:black" = "24.0.0"\n',
      });

      expect(execSnapshots).toMatchObject([
        { cmd: 'install-tool node 22.0.0' },
        { cmd: 'install-tool python 3.13.0' },
        { cmd: 'install-tool mise 2025.1.0' },
        { cmd: 'mise lock' },
      ]);
    });

    it('deduplicates backend tool constraints', async () => {
      GlobalConfig.set({ ...adminConfig, binarySource: 'install' });
      fs.getSiblingFileName.mockReturnValueOnce('mise.lock');
      fs.readLocalFile.mockResolvedValueOnce('old lock content');
      fs.ensureCacheDir.mockResolvedValueOnce('/tmp/cache/others/mise');
      const execSnapshots = mockExecAll();
      fs.readLocalFile.mockResolvedValueOnce('new lock content');
      datasource.getPkgReleases
        .mockResolvedValueOnce({ releases: [{ version: '22.0.0' }] })
        .mockResolvedValueOnce({ releases: [{ version: '2025.1.0' }] });

      await updateArtifacts({
        ...updateArtifact,
        newPackageFileContent:
          '[tools]\n"npm:prettier" = "3.0.0"\n"npm:eslint" = "9.0.0"\n',
      });

      expect(execSnapshots).toMatchObject([
        { cmd: 'install-tool node 22.0.0' },
        { cmd: 'install-tool mise 2025.1.0' },
        { cmd: 'mise lock' },
      ]);
    });
  });
});

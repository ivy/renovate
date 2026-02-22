import { mockExecAll } from '~test/exec-util.ts';
import { fs } from '~test/util.ts';
import { GlobalConfig } from '../../../config/global.ts';
import type { RepoGlobalConfig } from '../../../config/types.ts';
import { TEMPORARY_ERROR } from '../../../constants/error-messages.ts';
import { ExecError } from '../../../util/exec/exec-error.ts';
import type { UpdateArtifact } from '../types.ts';
import { updateArtifacts } from './artifacts.ts';

vi.mock('../../../util/exec/env.ts');
vi.mock('../../../util/fs/index.ts');

const globalConfig: RepoGlobalConfig = {
  localDir: '',
};

describe('modules/manager/mise/artifacts', () => {
  describe('updateArtifacts()', () => {
    let updateArtifact: UpdateArtifact;

    beforeEach(() => {
      GlobalConfig.set(globalConfig);
      updateArtifact = {
        packageFileName: 'mise.toml',
        newPackageFileContent: '[tools]\nnode = "22.0.0"\n',
        config: {},
        updatedDeps: [],
      };
    });

    it('returns null if no mise.lock found', async () => {
      fs.getSiblingFileName.mockReturnValueOnce('mise.lock');
      fs.readLocalFile.mockResolvedValueOnce(null);
      expect(await updateArtifacts(updateArtifact)).toBeNull();
    });

    it('returns null if lockfile unchanged after exec', async () => {
      fs.getSiblingFileName.mockReturnValueOnce('mise.lock');
      const lockContent = Buffer.from('existing lock content');
      fs.readLocalFile.mockResolvedValueOnce(lockContent as never);
      mockExecAll();
      fs.readLocalFile.mockResolvedValueOnce(lockContent as never);
      expect(await updateArtifacts(updateArtifact)).toBeNull();
    });

    it('returns updated mise.lock when content changes', async () => {
      fs.getSiblingFileName.mockReturnValueOnce('mise.lock');
      const oldLockContent = Buffer.from('old lock content');
      const newLockContent = Buffer.from('new lock content');
      fs.readLocalFile.mockResolvedValueOnce(oldLockContent as never);
      const execSnapshots = mockExecAll();
      fs.readLocalFile.mockResolvedValueOnce(newLockContent as never);

      expect(await updateArtifacts(updateArtifact)).toEqual([
        {
          file: {
            type: 'addition',
            path: 'mise.lock',
            contents: newLockContent,
          },
        },
      ]);
      expect(fs.writeLocalFile).toHaveBeenCalledWith(
        'mise.toml',
        '[tools]\nnode = "22.0.0"\n',
      );
      expect(execSnapshots).toMatchObject([
        {
          cmd: 'mise lock',
          options: {
            env: { MISE_YES: '1' },
          },
        },
      ]);
    });

    it('returns updated mise.lock for lock file maintenance', async () => {
      fs.getSiblingFileName.mockReturnValueOnce('mise.lock');
      const oldLockContent = Buffer.from('old lock content');
      const newLockContent = Buffer.from('new lock content');
      fs.readLocalFile.mockResolvedValueOnce(oldLockContent as never);
      const execSnapshots = mockExecAll();
      fs.readLocalFile.mockResolvedValueOnce(newLockContent as never);

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
            contents: newLockContent,
          },
        },
      ]);
      expect(execSnapshots).toMatchObject([
        {
          cmd: 'mise lock',
          options: {
            env: { MISE_YES: '1' },
          },
        },
      ]);
    });

    it('resolves lockfile in subdirectory', async () => {
      fs.getSiblingFileName.mockReturnValueOnce('sub/mise.lock');
      const oldLockContent = Buffer.from('old lock content');
      const newLockContent = Buffer.from('new lock content');
      fs.readLocalFile.mockResolvedValueOnce(oldLockContent as never);
      mockExecAll();
      fs.readLocalFile.mockResolvedValueOnce(newLockContent as never);

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
            contents: newLockContent,
          },
        },
      ]);
    });

    it('returns artifact error on exec failure', async () => {
      fs.getSiblingFileName.mockReturnValueOnce('mise.lock');
      const oldLockContent = Buffer.from('old lock content');
      fs.readLocalFile.mockResolvedValueOnce(oldLockContent as never);
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
      const oldLockContent = Buffer.from('old lock content');
      fs.readLocalFile.mockResolvedValueOnce(oldLockContent as never);
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
      const oldLockContent = Buffer.from('old lock content');
      const newLockContent = Buffer.from('new lock content');
      fs.readLocalFile.mockResolvedValueOnce(oldLockContent as never);
      const execSnapshots = mockExecAll();
      fs.readLocalFile.mockResolvedValueOnce(newLockContent as never);

      await updateArtifacts({
        ...updateArtifact,
        config: { constraints: { mise: '2025.1.0' } },
      });

      expect(execSnapshots).toMatchObject([
        {
          cmd: 'mise lock',
          options: {
            env: { MISE_YES: '1' },
          },
        },
      ]);
    });

    it('returns null if lockfile is null after exec', async () => {
      fs.getSiblingFileName.mockReturnValueOnce('mise.lock');
      const oldLockContent = Buffer.from('old lock content');
      fs.readLocalFile.mockResolvedValueOnce(oldLockContent as never);
      mockExecAll();
      fs.readLocalFile.mockResolvedValueOnce(null);

      expect(await updateArtifacts(updateArtifact)).toBeNull();
    });
  });
});

jest.mock('@aws-sdk/client-s3', () => {
  const actual = jest.requireActual('@aws-sdk/client-s3');
  return { ...actual, S3Client: jest.fn() };
});

import { S3Client } from '@aws-sdk/client-s3';
import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { DISABLED_MESSAGE, register } from '../../src/commands/sync';

describe('gpb sync et gpb resume : désactivées', () => {
  let errors: string[];

  beforeEach(() => {
    errors = [];
    jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void errors.push(args.join(' ')));
    process.exitCode = undefined;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.exitCode = undefined;
  });

  it.each([[['sync']], [['sync', '--dry-run', '--concurrent', '5']], [['resume']]])(
    'gpb %j refuse, code 1, sans créer de client S3',
    async (args) => {
      const program = new Command().exitOverride();
      register(program);
      await program.parseAsync(['node', 'gpb', ...args]);
      expect(process.exitCode).toBe(1);
      expect(errors.join('\n')).toContain(DISABLED_MESSAGE);
      expect(errors.join('\n')).toContain('désactivée : l\'archivage des nouveaux Takeout sera reconstruit sur le point d\'accès en écriture (epic 4)');
      expect(S3Client).not.toHaveBeenCalled();
    },
  );

  it('restent visibles dans l\'aide avec la mention « (désactivée) »', () => {
    const program = new Command();
    register(program);
    expect(program.commands.map((c) => [c.name(), c.description().startsWith('(désactivée)')])).toEqual([
      ['sync', true],
      ['resume', true],
    ]);
  });

  it('le code d\'envoi hérité a disparu (aucun gestionnaire de synchronisation ni client d\'envoi)', () => {
    const src = path.join(__dirname, '../../src');
    expect(fs.existsSync(path.join(src, 'sync/sync-manager.ts'))).toBe(false);
    expect(fs.existsSync(path.join(src, 'clients/cubbit.ts'))).toBe(false);
    expect(fs.readFileSync(path.join(src, 'commands/sync.ts'), 'utf8')).not.toMatch(/clients|sync-manager|@aws-sdk/);
  });
});

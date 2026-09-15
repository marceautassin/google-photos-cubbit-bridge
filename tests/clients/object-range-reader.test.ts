import { GetObjectCommand } from '@aws-sdk/client-s3';
import { S3ObjectRangeReader } from '../../src/clients/object-range-reader';

describe('S3ObjectRangeReader (lecture seule, GET partiel)', () => {
  it("n'envoie qu'un GetObject avec l'en-tête Range et renvoie les octets", async () => {
    const client = {
      send: jest.fn(async () => ({ Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) } })),
    };
    const reader = new S3ObjectRangeReader(client as never, 'marceau');

    await expect(reader.readRange('photos/IMG_0005.JPG', 0, 131071)).resolves.toEqual(new Uint8Array([1, 2, 3]));

    expect(client.send).toHaveBeenCalledTimes(1);
    const command = (client.send.mock.calls[0] as unknown[])[0];
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect((command as GetObjectCommand).input).toEqual({
      Bucket: 'marceau',
      Key: 'photos/IMG_0005.JPG',
      Range: 'bytes=0-131071',
    });
  });

  it('refuse une réponse sans corps', async () => {
    const reader = new S3ObjectRangeReader({ send: jest.fn(async () => ({})) } as never, 'marceau');
    await expect(reader.readRange('a.jpg', 0, 10)).rejects.toThrow('corps absent');
  });

  it("le module n'importe aucune commande d'écriture", async () => {
    const source = await import('fs').then((fs) =>
      fs.readFileSync(require.resolve('../../src/clients/object-range-reader.ts'), 'utf8'),
    );
    const imported = source.match(/import \{([^}]*)\} from '@aws-sdk\/client-s3'/)?.[1];
    expect(imported?.split(',').map((name) => name.trim())).toEqual(['GetObjectCommand', 'S3Client']);
  });
});

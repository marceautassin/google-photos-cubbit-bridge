import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { S3BucketLister } from '../../src/clients/bucket-lister';
import { scanBucket } from '../../src/inventory/inventory';

describe('S3BucketLister (lecture seule)', () => {
  const pages = [
    {
      Contents: [
        { Key: 'backup_google_photos/photos/2019/IMG_20190101_120000.jpg', Size: 100, ETag: '"abc"', LastModified: new Date('2024-01-29T00:00:00Z') },
        { Key: '1_Professionel/contrat.pdf', Size: 5 },
      ],
      IsTruncated: true,
      NextContinuationToken: 'jeton-2',
    },
    {
      Contents: [{ Key: '2_Personnel/Photos/google_photos/mariage/DSC_0001.JPG', Size: 300, ETag: '"d41d-2"' }],
      IsTruncated: true,
      NextContinuationToken: 'jeton-3',
    },
    { Contents: [{ Key: 'racine.jpg', Size: 7 }], IsTruncated: false },
  ];

  function mockClient() {
    let call = 0;
    return { send: jest.fn(async () => pages[call++]) };
  }

  it("parcourt toutes les pages du bucket sans préfixe et n'envoie que des ListObjectsV2", async () => {
    const client = mockClient();
    const objects = await scanBucket(new S3BucketLister(client as never, 'marceau'));

    expect(objects.map((o) => o.key)).toEqual([
      'backup_google_photos/photos/2019/IMG_20190101_120000.jpg',
      '1_Professionel/contrat.pdf',
      '2_Personnel/Photos/google_photos/mariage/DSC_0001.JPG',
      'racine.jpg',
    ]);
    expect(client.send).toHaveBeenCalledTimes(3);

    const commands = client.send.mock.calls.map((args: unknown[]) => args[0]);
    for (const command of commands) {
      // Garde-fou lecture seule : aucune autre commande S3 (Put, Copy, Delete…) n'est émise.
      expect(command).toBeInstanceOf(ListObjectsV2Command);
      const input = (command as ListObjectsV2Command).input;
      expect(input.Bucket).toBe('marceau');
      expect(input.Prefix).toBeUndefined();
    }
    expect(commands.map((c) => (c as ListObjectsV2Command).input.ContinuationToken)).toEqual([
      undefined,
      'jeton-2',
      'jeton-3',
    ]);
  });

  it('conserve clé, taille, date de modification et ETag sans guillemets', async () => {
    const page = await new S3BucketLister(mockClient() as never, 'marceau').listPage();
    expect(page.objects[0]).toEqual({
      key: 'backup_google_photos/photos/2019/IMG_20190101_120000.jpg',
      size: 100,
      lastModified: new Date('2024-01-29T00:00:00Z'),
      etag: 'abc',
    });
    expect(page.objects[1]).toEqual({ key: '1_Professionel/contrat.pdf', size: 5, lastModified: null, etag: null });
    expect(page.nextToken).toBe('jeton-2');
    expect(page.isTruncated).toBe(true);
  });

  /** Client mocké renvoyant les réponses données, dans l'ordre. */
  function clientWith(...responses: object[]) {
    let call = 0;
    return { send: jest.fn(async () => responses[call++]) };
  }
  const lister = (client: { send: jest.Mock }) => new S3BucketLister(client as never, 'marceau');

  it("s'arrête sur IsTruncated faux même si un jeton est présent", async () => {
    const client = clientWith({ Contents: [{ Key: 'a.jpg', Size: 1 }], IsTruncated: false, NextContinuationToken: 'x' });
    await expect(scanBucket(lister(client))).resolves.toHaveLength(1);
    expect(client.send).toHaveBeenCalledTimes(1);
  });

  it('refuse une réponse sans champ IsTruncated (fin du listing indécidable)', async () => {
    const client = clientWith({ Contents: [{ Key: 'a.jpg', Size: 1 }], NextContinuationToken: 'x' });
    await expect(scanBucket(lister(client))).rejects.toThrow('IsTruncated absent');
  });

  it('refuse une page tronquée sans jeton de continuation (inventaire tronqué)', async () => {
    const client = clientWith({ Contents: [{ Key: 'a.jpg', Size: 1 }], IsTruncated: true });
    await expect(scanBucket(lister(client))).rejects.toThrow('tronquée sans jeton');
  });

  it('refuse un jeton de continuation déjà reçu (boucle)', async () => {
    const client = clientWith(
      { Contents: [{ Key: 'a.jpg', Size: 1 }], IsTruncated: true, NextContinuationToken: 'j1' },
      { Contents: [{ Key: 'b.jpg', Size: 1 }], IsTruncated: true, NextContinuationToken: 'j2' },
      { Contents: [{ Key: 'c.jpg', Size: 1 }], IsTruncated: true, NextContinuationToken: 'j1' },
    );
    await expect(scanBucket(lister(client))).rejects.toThrow('déjà reçu');
    expect(client.send).toHaveBeenCalledTimes(3);
  });

  it('accepte une page sans Contents (bucket vide ou page vide intermédiaire)', async () => {
    const vide = clientWith({ IsTruncated: false, KeyCount: 0 });
    await expect(scanBucket(lister(vide))).resolves.toEqual([]);

    const intermediaire = clientWith(
      { IsTruncated: true, NextContinuationToken: 'j1' },
      { Contents: [{ Key: 'a.jpg', Size: 1 }], IsTruncated: false },
    );
    await expect(scanBucket(lister(intermediaire))).resolves.toHaveLength(1);
  });

  it.each([
    ['sans clé', { Size: 1 }],
    ['sans taille', { Key: 'a.jpg' }],
  ])('refuse un objet %s au lieu de l\'ignorer', async (_cas, object) => {
    const client = clientWith({ Contents: [object], IsTruncated: false });
    await expect(scanBucket(lister(client))).rejects.toThrow('Réponse S3 incomplète');
  });
});

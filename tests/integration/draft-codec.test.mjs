// Persisted draft format: what's saved, what's restored, and corrupt data.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { parseDraft, serializeDraft } = await import('@/lib/storage/draftCodec');

const image = (id) => ({
  id,
  name: `${id}.jpg`,
  uri: `file:///old-container/${id}.jpg`,
  sourceKey: `asset-${id}`,
  fileName: `${id}.jpg`,
  mimeType: 'image/jpeg',
  width: 10,
  height: 20,
  file: new Blob(['x']),
});
const draft = {
  brand: 'Cat',
  model: '320',
  images: [image('a'), image('b')],
  resume: { fingerprint: 'fp', idempotencyKey: 'k', uploadId: 'u1', sentIds: ['a'], queued: true },
};
const resolveAll = (i) => ({ ...i, uri: `file:///new-container/${i.name}` });

describe('draft persistence format', () => {
  test('round trip: absolute paths are not stored; URIs are rebuilt from file names', () => {
    const raw = serializeDraft(draft, true);
    assert.ok(!raw.includes('old-container'));
    const { draft: back, missingImages } = parseDraft(raw, resolveAll);
    assert.equal(missingImages, 0);
    assert.deepEqual(back.images.map((i) => i.uri), ['file:///new-container/a.jpg', 'file:///new-container/b.jpg']);
    assert.equal(back.images[0].file, undefined);
    assert.deepEqual(back.resume, draft.resume);
    assert.equal(back.brand, 'Cat');
  });

  test('a photo whose file is gone is dropped and counted', () => {
    const r = parseDraft(serializeDraft(draft, true), (i) => (i.id === 'b' ? null : resolveAll(i)));
    assert.equal(r.missingImages, 1);
    assert.deepEqual(r.draft.images.map((i) => i.id), ['a']);
  });

  test('web keeps only brand and model', () => {
    const { draft: web } = parseDraft(serializeDraft(draft, false), resolveAll);
    assert.deepEqual(web.images, []);
    assert.equal(web.resume, null);
    assert.equal(web.model, '320');
  });

  test('corrupt or partial data degrades safely instead of crashing', () => {
    for (const bad of [null, '', '{', 'null', '42', '[]', '{"brand":5,"images":"x","resume":{"fingerprint":1}}']) {
      const r = parseDraft(bad, resolveAll);
      assert.equal(typeof r.draft.brand, 'string');
      assert.ok(Array.isArray(r.draft.images));
    }
    const odd = parseDraft(
      '{"images":[null,{"id":"x"},{"id":"y","name":"y.jpg","sourceKey":"s","width":"wide"}],"resume":{"fingerprint":"f","idempotencyKey":"k","sentIds":[1,"a"]}}',
      resolveAll,
    );
    assert.deepEqual(odd.draft.images.map((i) => [i.id, i.width]), [['y', 0]]);
    assert.deepEqual(odd.draft.resume.sentIds, ['a']);
    assert.equal(odd.draft.resume.queued, false);
  });
});

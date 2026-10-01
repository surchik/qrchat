import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getPath, asText, fillTemplate, mapJsonItems, autodetectMapping } from '../extension/src/lib/jsonpath.js';

test('getPath supports dots, indexes and alternatives', () => {
  const o = { a: { b: [{ c: 1 }] }, x: '', y: 'yes' };
  assert.equal(getPath(o, 'a.b.0.c'), 1);
  assert.equal(getPath(o, 'a.b[0].c'), 1);
  assert.equal(getPath(o, 'x|y'), 'yes');
  assert.equal(getPath(o, 'nope.deeper'), undefined);
  assert.equal(getPath(o, ''), o);
});

test('asText flattens artist arrays and objects', () => {
  assert.equal(asText([{ name: 'A' }, { name: 'B' }]), 'A, B');
  assert.equal(asText({ name: 'Solo' }), 'Solo');
  assert.equal(asText(128), '128');
  assert.equal(asText(null), '');
});

test('fillTemplate encodes values and reads raw.*', () => {
  assert.equal(fillTemplate('https://x/dl/{id}?f={raw.fmt}', { id: 'a b', raw: { fmt: 'wav' } }), 'https://x/dl/a%20b?f=wav');
});

const SAMPLE = {
  status: 'ok',
  meta: { total: 2 },
  data: {
    genres: [{ id: 1, name: 'House' }],
    results: [
      { track_id: 11, title: 'Saving Up', artists: [{ name: 'Dom Dolla' }], version: 'Extended Mix', bpm: 126, key: '8A', download_url: '/api/download/11' },
      { track_id: 12, title: 'Saving Up', artists: [{ name: 'Dom Dolla' }], version: 'Clean', bpm: 126, key: '8A', download_url: '/api/download/12' },
    ],
  },
};

test('autodetectMapping finds the track array and its fields', () => {
  const m = autodetectMapping(SAMPLE);
  assert.equal(m.itemsPath, 'data.results');
  assert.equal(m.fields.title, 'title');
  assert.equal(m.fields.artist, 'artists');
  assert.equal(m.fields.version, 'version');
  assert.equal(m.fields.id, 'track_id');
  assert.equal(m.fields.download, 'download_url');
  assert.equal(m.fields.bpm, 'bpm');
  assert.equal(m.fields.key, 'key');
});

test('autodetected mapping feeds mapJsonItems end to end', () => {
  const m = autodetectMapping(SAMPLE);
  const items = mapJsonItems(SAMPLE, { itemsPath: m.itemsPath, ...m.fields }, 'https://pool.example');
  assert.equal(items.length, 2);
  assert.equal(items[0].artist, 'Dom Dolla');
  assert.equal(items[0].downloadUrl, 'https://pool.example/api/download/11');
  assert.equal(items[1].version, 'Clean');
});

test('autodetectMapping works when the response is a bare array', () => {
  const m = autodetectMapping([{ name: 'Song', artist: 'X' }]);
  assert.equal(m.itemsPath, '');
  assert.equal(m.fields.title, 'name');
});

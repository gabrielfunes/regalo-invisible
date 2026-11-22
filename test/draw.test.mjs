import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hacerSorteo } from '../src/worker.js';

const users = (...names) => names.map(n => ({ id: 'id-' + n.toLowerCase(), name: n }));

test('el sorteo reparte a todos sin auto-regalos', () => {
  const u = users('María', 'Iván', 'Carmen', 'Pablo', 'Lucía');
  for (let i = 0; i < 50; i++) {
    const r = hacerSorteo(u, []);
    assert.ok(r, 'debe encontrar combinación');
    assert.equal(r.size, u.length);
    const targets = new Set(r.values());
    assert.equal(targets.size, u.length, 'cada uno recibe exactamente un regalo');
    for (const [g, t] of r) assert.notEqual(g, t, 'nadie se regala a sí mismo');
  }
});

test('no repite las parejas del año pasado, ignorando mayúsculas', () => {
  const u = users('María', 'Iván', 'Carmen', 'Pablo', 'Lucía');
  const lastYear = [['maría', 'Iván'], ['PABLO', 'carmen']];
  for (let i = 0; i < 50; i++) {
    const r = hacerSorteo(u, lastYear);
    assert.ok(r);
    assert.notEqual(r.get('id-maría'), 'id-iván');
    assert.notEqual(r.get('id-pablo'), 'id-carmen');
  }
});

test('nombres del año pasado que ya no participan se ignoran', () => {
  const u = users('María', 'Iván', 'Carmen');
  const r = hacerSorteo(u, [['Abuela', 'María'], ['María', 'Abuela']]);
  assert.ok(r);
});

test('devuelve null si no hay combinación posible', () => {
  const u = users('María', 'Iván');
  // Con dos personas y una pareja prohibida en ambos sentidos no hay derangement posible
  assert.equal(hacerSorteo(u, [['María', 'Iván']]), null);
  assert.equal(hacerSorteo(u, [['Iván', 'María']]), null);
});

test('devuelve null con menos de dos participantes', () => {
  assert.equal(hacerSorteo([], []), null);
  assert.equal(hacerSorteo(users('Solo'), []), null);
});

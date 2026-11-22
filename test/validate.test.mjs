import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWishlist } from '../src/worker.js';

test('lista de deseos válida con y sin enlaces', () => {
  const items = validateWishlist([{ text: 'Bufanda', link: '' }, { text: 'Libro', link: 'https://example.com/x' }]);
  assert.equal(items.length, 2);
  assert.ok(items[0].id);
  assert.equal(items[1].link, 'https://example.com/x');
});

test('recorta espacios', () => {
  const [item] = validateWishlist([{ text: '  Calcetines  ', link: ' ' }]);
  assert.equal(item.text, 'Calcetines');
  assert.equal(item.link, '');
});

test('rechaza textos vacíos, largos y enlaces no https', () => {
  assert.throws(() => validateWishlist([{ text: '', link: '' }]));
  assert.throws(() => validateWishlist([{ text: 'x'.repeat(201), link: '' }]));
  assert.throws(() => validateWishlist([{ text: 'ok', link: 'http://inseguro.com' }]));
  assert.throws(() => validateWishlist([{ text: 'ok', link: 'javascript:alert(1)' }]));
});

test('máximo 20 deseos', () => {
  assert.throws(() => validateWishlist(Array.from({ length: 21 }, (_, i) => ({ text: 'deseo ' + i, link: '' }))));
  assert.equal(validateWishlist(Array.from({ length: 20 }, (_, i) => ({ text: 'deseo ' + i, link: '' }))).length, 20);
});

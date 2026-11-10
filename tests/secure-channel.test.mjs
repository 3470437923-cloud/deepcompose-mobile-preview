import test from 'node:test';
import assert from 'node:assert/strict';
import { randomSecret, createCodec } from '../lib/secure-channel.mjs';

const encode = bytes => Buffer.from(bytes).toString('base64url');
const decode = text => Buffer.from(text, 'base64url');
const text = new TextEncoder();
const MAX = 192 * 1024;

async function atTime(now, operation) {
  const original = Date.now;
  Date.now = () => now;
  try { return await operation(); } finally { Date.now = original; }
}

// Independently construct valid authenticated wire data to test receive validation.
async function fixture(secret, body, issuedAt = Date.now()) {
  const material = await crypto.subtle.importKey('raw', decode(secret), 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256',
    salt: text.encode('deepcompose-mobile/secure-channel/v1'),
    info: text.encode(JSON.stringify(['key', 'c2d', 'pair'])) }, material,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce,
    additionalData: text.encode(JSON.stringify([1, 'c2d', 'pair', issuedAt])), tagLength: 128 }, key, text.encode(JSON.stringify(body)));
  return JSON.stringify({ v: 1, issuedAt, nonce: encode(nonce), ciphertext: encode(ciphertext) });
}

test('secret has 32 random bytes, topic is stable across contexts and independent of other secrets', async () => {
  const secret = randomSecret();
  assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(decode(secret).length, 32);
  assert.notEqual(secret, randomSecret());
  const a = await createCodec(secret);
  assert.match(a.topicId, /^[a-f0-9]{32}$/);
  assert.equal(a.topicId, (await createCodec(secret, 'session-1')).topicId);
  assert.notEqual(a.topicId, (await createCodec(randomSecret())).topicId);
});

test('separate endpoints round trip Unicode objects in both directions', async () => {
  const secret = randomSecret();
  const a = await createCodec(secret, 'session-1');
  const b = await createCodec(secret, 'session-1');
  for (const direction of ['c2d', 'd2c']) {
    const body = { id: 'request-1', text: '中文 😀', result: [{ name: 'chapter' }] };
    assert.deepEqual(await b.open(direction, await a.seal(direction, body)), body);
  }
});

test('wrong secret, context, direction and altered authenticated fields fail', async () => {
  const secret = randomSecret();
  const codec = await createCodec(secret);
  const wire = await codec.seal('c2d', { ok: true });
  await assert.rejects((await createCodec(randomSecret())).open('c2d', wire));
  await assert.rejects((await createCodec(secret, 'another')).open('c2d', wire));
  await assert.rejects(codec.open('d2c', wire));
  const envelope = JSON.parse(wire);
  for (const field of ['nonce', 'ciphertext']) {
    const bytes = decode(envelope[field]); bytes[0] ^= 1;
    await assert.rejects(codec.open('c2d', JSON.stringify({ ...envelope, [field]: encode(bytes) })));
  }
  await assert.rejects(codec.open('c2d', JSON.stringify({ ...envelope, issuedAt: envelope.issuedAt + 1 })));
});

test('authenticated timestamps enforce 120s old and 30s future limits inclusively', async () => {
  const codec = await createCodec(randomSecret());
  const now = 1800000000000;
  for (const [offset, allowed] of [[-120000, true], [-120001, false], [30000, true], [30001, false]]) {
    const wire = await atTime(now + offset, () => codec.seal('c2d', {}));
    await atTime(now, async () => {
      if (allowed) assert.deepEqual(await codec.open('c2d', wire), {});
      else await assert.rejects(codec.open('c2d', wire), /time/i);
    });
  }
});

test('each sealing uses a fresh 12-byte nonce', async () => {
  const codec = await createCodec(randomSecret());
  const nonces = new Set();
  for (let i = 0; i < 64; i++) {
    const { nonce } = JSON.parse(await codec.seal('c2d', {}));
    assert.equal(decode(nonce).length, 12); nonces.add(nonce);
  }
  assert.equal(nonces.size, 64);
});

test('reject noncanonical secrets, invalid contexts and directions', async () => {
  for (const secret of ['', null, 12, 'a'.repeat(42), 'a'.repeat(44), 'A'.repeat(42) + 'B', 'A'.repeat(42) + '=', ' '.repeat(43)]) {
    await assert.rejects(createCodec(secret));
  }
  for (const context of ['', null, [], 'x'.repeat(1025)]) await assert.rejects(createCodec(randomSecret(), context));
  const codec = await createCodec(randomSecret());
  for (const direction of ['', 'up', '__proto__', null]) {
    await assert.rejects(codec.seal(direction, {}));
    await assert.rejects(codec.open(direction, '{}'));
  }
});

test('only JSON object roots accepted, including after serialization and decryption', async () => {
  const secret = randomSecret();
  const codec = await createCodec(secret);
  for (const body of [null, [], 'text', 1, true, undefined, { toJSON: () => [] }, { toJSON: () => null }]) {
    await assert.rejects(codec.seal('c2d', body));
  }
  for (const body of [null, [], 'text', 1]) await assert.rejects(codec.open('c2d', await fixture(secret, body)));
  assert.deepEqual(await codec.open('c2d', await fixture(secret, { independent: true })), { independent: true });
});

test('plaintext byte limit applies to Unicode and independently encrypted input', async () => {
  const secret = randomSecret();
  const codec = await createCodec(secret);
  const exact = { text: 'x'.repeat(MAX - 11) };
  const wire = await codec.seal('c2d', exact);
  assert.deepEqual(await codec.open('c2d', wire), exact);
  await assert.rejects(codec.seal('c2d', { text: 'x'.repeat(MAX - 10) }), /size|large/i);
  await assert.rejects(codec.seal('c2d', { text: '中'.repeat(MAX / 3) }), /size|large/i);
  await assert.rejects(codec.open('c2d', await fixture(secret, { text: 'x'.repeat(MAX) })), /size|large/i);
  await assert.rejects(codec.open('c2d', 'x'.repeat(300 * 1024 + 1)), /size|large/i);
});

test('reject malformed envelopes, unknown fields and noncanonical base64url', async () => {
  const codec = await createCodec(randomSecret());
  const envelope = JSON.parse(await codec.seal('c2d', {}));
  for (const wire of [null, {}, '[]', 'null', 'invalid', JSON.stringify({ ...envelope, v: 2 }),
    JSON.stringify({ ...envelope, extra: true }), JSON.stringify({ ...envelope, issuedAt: '1' }),
    JSON.stringify({ ...envelope, nonce: envelope.nonce + '=' }),
    JSON.stringify({ ...envelope, nonce: encode(new Uint8Array(11)) }),
    JSON.stringify({ ...envelope, ciphertext: '' }),
    JSON.stringify({ ...envelope, ciphertext: envelope.ciphertext + '=' })]) {
    await assert.rejects(codec.open('c2d', wire));
  }
});

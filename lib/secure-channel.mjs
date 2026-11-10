// Native WebCrypto only: usable as an ESM module in modern browsers and Node.
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const SALT = encoder.encode('deepcompose-mobile/secure-channel/v1');
const MAX_PLAINTEXT = 192 * 1024;
const MAX_WIRE = 300 * 1024;

function encode(bytes) {
  let binary = '';
  // Avoid argument-spread limits on maximum-sized messages.
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decode(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    throw new Error('Invalid base64url');
  }
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  if (encode(bytes) !== value) throw new Error('Noncanonical base64url');
  return bytes;
}

function requireObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('JSON body must be an object');
  }
  return value;
}

function requireDirection(direction) {
  if (direction !== 'c2d' && direction !== 'd2c') throw new Error('Invalid direction');
}

function aad(direction, context, issuedAt) {
  // Include timestamp: otherwise a broker could refresh an expired envelope.
  return encoder.encode(JSON.stringify([1, direction, context, issuedAt]));
}

export function randomSecret() {
  return encode(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * Context must be the host's fresh, in-memory session ID for business messages.
 * "pair" is only for handshake messages. This codec authenticates and checks
 * freshness; callers must enforce session existence and request-ID deduplication.
 */
export async function createCodec(secret, context = 'pair') {
  if (typeof secret !== 'string' || secret.length !== 43) throw new Error('Invalid secret');
  const secretBytes = decode(secret);
  if (secretBytes.length !== 32) throw new Error('Invalid secret');
  if (typeof context !== 'string' || context.length === 0 || context.length > 1024) {
    throw new Error('Invalid context');
  }
  const subtle = globalThis.crypto.subtle;
  const material = await subtle.importKey('raw', secretBytes, 'HKDF', false, ['deriveBits', 'deriveKey']);
  secretBytes.fill(0);
  const parameters = label => ({
    name: 'HKDF', hash: 'SHA-256', salt: SALT, info: encoder.encode(JSON.stringify(label)),
  });
  const topicBytes = new Uint8Array(await subtle.deriveBits(parameters(['topic']), material, 128));
  const topicId = Array.from(topicBytes, byte => byte.toString(16).padStart(2, '0')).join('');
  const keys = Object.create(null);
  for (const direction of ['c2d', 'd2c']) {
    keys[direction] = await subtle.deriveKey(parameters(['key', direction, context]), material,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  return Object.freeze({
    topicId,
    async seal(direction, payload) {
      requireDirection(direction);
      requireObject(payload);
      const serialized = JSON.stringify(payload);
      // toJSON can replace an object root with an array or primitive.
      if (typeof serialized !== 'string') throw new Error('JSON body must be an object');
      const plaintext = encoder.encode(serialized);
      if (plaintext.length > MAX_PLAINTEXT) throw new Error('Plaintext too large');
      requireObject(JSON.parse(serialized));
      const issuedAt = Date.now();
      const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
      const encrypted = await subtle.encrypt({ name: 'AES-GCM', iv: nonce,
        additionalData: aad(direction, context, issuedAt), tagLength: 128 }, keys[direction], plaintext);
      const wire = JSON.stringify({ v: 1, issuedAt, nonce: encode(nonce), ciphertext: encode(new Uint8Array(encrypted)) });
      if (wire.length > MAX_WIRE) throw new Error('Wire too large');
      return wire;
    },
    async open(direction, wire) {
      requireDirection(direction);
      if (typeof wire !== 'string') throw new Error('Wire must be a string');
      if (wire.length > MAX_WIRE || encoder.encode(wire).length > MAX_WIRE) throw new Error('Wire too large');
      const envelope = requireObject(JSON.parse(wire));
      const { v, issuedAt, nonce, ciphertext } = envelope;
      if (Object.keys(envelope).length !== 4 || v !== 1 || !Number.isSafeInteger(issuedAt) || issuedAt < 0) {
        throw new Error('Invalid envelope');
      }
      const iv = decode(nonce);
      const encrypted = decode(ciphertext);
      if (iv.length !== 12 || encrypted.length < 16) throw new Error('Invalid envelope');
      // Bound allocations before authentication; check exact plaintext limit after it.
      if (encrypted.length > MAX_PLAINTEXT + 16) throw new Error('Ciphertext too large');
      const plaintext = await subtle.decrypt({ name: 'AES-GCM', iv,
        additionalData: aad(direction, context, issuedAt), tagLength: 128 }, keys[direction], encrypted);
      const now = Date.now();
      if (issuedAt < now - 120000 || issuedAt > now + 30000) throw new Error('Message outside time window');
      if (plaintext.byteLength > MAX_PLAINTEXT) throw new Error('Plaintext too large');
      return requireObject(JSON.parse(decoder.decode(plaintext)));
    },
  });
}

import { base64FromBytes } from './remoteBytes';
import type { ActionPackLockLevel, ActionPackLockState } from './types';

const PBKDF2_ITERATIONS = 210_000;
const PBKDF2_HASH_BITS = 256;
const LOCK_CHALLENGE_PREFIX = 'UNLOCK';

function bytesFromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function arrayBufferFromBytes(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function challengeTextForPack(packName: string): string {
  return `${LOCK_CHALLENGE_PREFIX} ${packName.trim() || 'ACTION PACK'}`;
}

export function createChallengeLockState(packName: string, level: Extract<ActionPackLockLevel, 1 | 3>, note?: string): ActionPackLockState {
  const now = Date.now();
  return {
    locked: level > 0,
    level,
    createdAt: now,
    updatedAt: now,
    challengeText: challengeTextForPack(packName),
    note,
  };
}

export async function createPasswordLockState(password: string, note?: string): Promise<ActionPackLockState> {
  const trimmed = password.trim();
  if (trimmed.length < 8) {
    throw new Error('Level 2 locks require a password of at least 8 characters.');
  }

  const now = Date.now();
  const salt = randomBytes(16);
  return {
    locked: true,
    level: 2,
    createdAt: now,
    updatedAt: now,
    passwordSaltBase64: base64FromBytes(salt),
    passwordHashBase64: await derivePasswordHashBase64(trimmed, salt),
    note,
  };
}

export function unlockedLockState(previous?: ActionPackLockState): ActionPackLockState {
  const now = Date.now();
  return {
    locked: false,
    level: 0,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    note: previous?.note,
  };
}

export async function verifyPasswordLock(lockState: ActionPackLockState, password: string): Promise<boolean> {
  if (!lockState.passwordSaltBase64 || !lockState.passwordHashBase64) {
    return false;
  }

  const candidate = await derivePasswordHashBase64(password.trim(), bytesFromBase64(lockState.passwordSaltBase64));
  return constantTimeEqual(candidate, lockState.passwordHashBase64);
}

async function derivePasswordHashBase64(password: string, salt: Uint8Array): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: arrayBufferFromBytes(salt),
      iterations: PBKDF2_ITERATIONS,
    },
    keyMaterial,
    PBKDF2_HASH_BITS,
  );
  return base64FromBytes(new Uint8Array(bits));
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

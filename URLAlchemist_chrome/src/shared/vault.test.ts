import { describe, expect, it } from 'vitest';

import { MAX_ACTION_PACK_BINARY_BYTES, VAULT_MAGIC, VAULT_SCHEMA_VERSION } from './constants';
import { importActionPackBinary } from './vault';

describe('vault', () => {
  it('rejects oversized binary imports before decoding', async () => {
    const bytes = new Uint8Array(MAX_ACTION_PACK_BINARY_BYTES + 1);
    bytes.set(new TextEncoder().encode(VAULT_MAGIC), 0);
    bytes[VAULT_MAGIC.length] = VAULT_SCHEMA_VERSION;

    await expect(importActionPackBinary(bytes)).rejects.toThrow('larger than 1MB');
  });
});

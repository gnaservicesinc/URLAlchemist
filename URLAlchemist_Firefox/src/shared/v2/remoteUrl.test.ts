import { describe, expect, it } from 'vitest';

import { validateRemoteUrl } from './remoteUrl';

describe('validateRemoteUrl', () => {
  it('allows public HTTPS URLs', () => {
    expect(validateRemoteUrl('https://example.com/data.json')).toBe('https://example.com/data.json');
  });

  it('rejects non-HTTPS and credentialed URLs', () => {
    expect(() => validateRemoteUrl('http://example.com/data.json')).toThrow('only allow HTTPS');
    expect(() => validateRemoteUrl('https://user:pass@example.com/data.json')).toThrow('cannot include credentials');
  });

  it('rejects local, private, and reserved network hosts', () => {
    [
      'https://localhost/data.json',
      'https://127.0.0.1/data.json',
      'https://10.0.0.1/data.json',
      'https://172.16.0.1/data.json',
      'https://192.168.1.1/data.json',
      'https://169.254.169.254/latest/meta-data',
      'https://100.64.0.1/data.json',
      'https://[::1]/data.json',
      'https://[::ffff:127.0.0.1]/data.json',
    ].forEach((url) => {
      expect(() => validateRemoteUrl(url)).toThrow('cannot access local, private, or reserved network hosts');
    });
  });
});

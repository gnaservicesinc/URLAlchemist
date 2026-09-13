import { describe, expect, it } from 'vitest';

import { validateRemoteUrl } from './remoteUrl';

describe('validateRemoteUrl', () => {
  it('allows public HTTPS URLs', () => {
    expect(validateRemoteUrl('https://example.com/data.json')).toBe('https://example.com/data.json');
  });

  it('does not mistake domain prefixes for private IPv6 addresses', () => {
    for (const host of ['fcdomain.com', 'fddomain.com', 'ffdomain.com', '[2606:4700:4700::1111]']) {
      expect(validateRemoteUrl(`https://${host}/`)).toBe(`https://${host}/`);
    }
  });

  it('rejects non-HTTPS and credentialed URLs', () => {
    expect(() => validateRemoteUrl('http://example.com/data.json')).toThrow('only allow HTTPS');
    expect(() => validateRemoteUrl('https://user:pass@example.com/data.json')).toThrow('cannot include credentials');
  });

  it.each(['0177.0.0.1', '2130706433', '0x7f000001', '127.1'])(
    'rejects canonical loopback before fetching an alternative IPv4 form: %s', (host) => {
      const url = `https://${host}/data.json`;
      expect(new URL(url).hostname).toBe('127.0.0.1');
      expect(() => validateRemoteUrl(url)).toThrow('cannot access local, private, or reserved network hosts');
    },
  );

  it('rejects local, private, and reserved network hosts', () => {
    [
      'https://localhost/data.json',
      'https://localhost./data.json',
      'https://sub.localhost/data.json',
      'https://printer.local./data.json',
      'https://[fe90::1]/data.json',
      'https://[febf::1]/data.json',
      'https://[fc00::1]/data.json',
      'https://[fd12::1]/data.json',
      'https://[ff02::1]/data.json',
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

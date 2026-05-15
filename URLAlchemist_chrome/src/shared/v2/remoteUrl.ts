function parseIpv4Address(hostname: string): number[] | null {
  const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) {
    return null;
  }

  const octets = match.slice(1).map((entry) => Number.parseInt(entry, 10));
  return octets.some((entry) => entry < 0 || entry > 255) ? [] : octets;
}

function isPrivateOrReservedIpv4(octets: number[]): boolean {
  if (octets.length !== 4) {
    return true;
  }

  const [first, second, third] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 192 && second === 88 && third === 99) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  );
}

function parseIpv4MappedIpv6(hostname: string): number[] | null {
  const dotted = hostname.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) {
    return parseIpv4Address(dotted[1]);
  }

  const compressed = hostname.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!compressed) {
    return null;
  }

  const high = Number.parseInt(compressed[1], 16);
  const low = Number.parseInt(compressed[2], 16);
  if (!Number.isFinite(high) || !Number.isFinite(low) || high > 0xffff || low > 0xffff) {
    return [];
  }

  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

export function isPrivateOrLocalRemoteHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!normalized || normalized === 'localhost' || normalized.endsWith('.local')) {
    return true;
  }

  if (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fe80:') ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('ff')
  ) {
    return true;
  }

  const ipv4 = parseIpv4MappedIpv6(normalized) ?? parseIpv4Address(normalized);
  return ipv4 ? isPrivateOrReservedIpv4(ipv4) : false;
}

export function validateRemoteUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Remote data URL must be a valid absolute URL');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('Remote data blocks only allow HTTPS URLs');
  }

  if (parsed.username || parsed.password) {
    throw new Error('Remote data URLs cannot include credentials');
  }

  if (isPrivateOrLocalRemoteHost(parsed.hostname)) {
    throw new Error('Remote data blocks cannot access local, private, or reserved network hosts');
  }

  return parsed.toString();
}

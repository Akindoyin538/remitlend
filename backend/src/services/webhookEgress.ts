import { lookup } from 'node:dns/promises';
import https from 'node:https';
import { isIP } from 'node:net';

export class WebhookEgressPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookEgressPolicyError';
  }
}

function ipv4ToNumber(address: string): number {
  return address.split('.').reduce((value, octet) => (value * 256 + Number(octet)) >>> 0, 0);
}

function isPublicIpv4(address: string): boolean {
  const value = ipv4ToNumber(address);
  const blockedRanges: Array<[number, number]> = [
    [0x00000000, 8],
    [0x0a000000, 8],
    [0x64400000, 10],
    [0x7f000000, 8],
    [0xa9fe0000, 16],
    [0xac100000, 12],
    [0xc0000000, 24],
    [0xc0000200, 24],
    [0xc0586300, 24],
    [0xc0a80000, 16],
    [0xc6120000, 15],
    [0xc6336400, 24],
    [0xcb007100, 24],
    [0xe0000000, 4],
    [0xf0000000, 4],
  ];

  return !blockedRanges.some(([network, prefix]) => {
    const mask = (0xffffffff << (32 - prefix)) >>> 0;
    return (value & mask) === network;
  });
}

function ipv6ToBigInt(address: string): bigint {
  const halves = address.toLowerCase().split('::');
  if (halves.length > 2) {
    throw new WebhookEgressPolicyError('Invalid IPv6 address');
  }

  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const groups =
    halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;

  if (groups.length !== 8 || groups.some((group) => !/^[\da-f]{1,4}$/.test(group))) {
    throw new WebhookEgressPolicyError('Invalid IPv6 address');
  }

  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

function isPublicIpv6(address: string): boolean {
  const value = ipv6ToBigInt(address);
  const globalUnicastPrefix = value >> 125n;
  const documentationPrefix = BigInt('0x20010db8') << 96n;
  const documentationMask = ((1n << 32n) - 1n) << 96n;
  const documentationRangePrefix = BigInt('0x3fff') << 112n;
  const documentationRangeMask = ((1n << 20n) - 1n) << 108n;
  const transitionPrefix = BigInt('0x20010000') << 96n;
  const transitionMask = ((1n << 23n) - 1n) << 96n;

  return (
    globalUnicastPrefix === 1n &&
    (value & documentationMask) !== documentationPrefix &&
    (value & documentationRangeMask) !== documentationRangePrefix &&
    (value & transitionMask) !== transitionPrefix &&
    (value >> 112n) !== 0x2002n
  );
}

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

function parseWebhookUrl(callbackUrl: string): URL {
  let url: URL;
  try {
    url = new URL(callbackUrl);
  } catch {
    throw new WebhookEgressPolicyError('callbackUrl must be a valid URL');
  }

  if (
    url.protocol !== 'https:' ||
    (url.port !== '' && url.port !== '443') ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new WebhookEgressPolicyError(
      'callbackUrl must use HTTPS on port 443 without credentials or a fragment',
    );
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    !hostname ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    throw new WebhookEgressPolicyError('callbackUrl hostname is not allowed');
  }

  return url;
}

async function resolvePublicAddresses(hostname: string): Promise<Array<{ address: string; family: number }>> {
  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await lookup(hostname, { all: true, verbatim: true });

  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new WebhookEgressPolicyError(
      'callbackUrl must resolve exclusively to globally routable IP addresses',
    );
  }

  return addresses;
}

export async function validateWebhookUrl(callbackUrl: string): Promise<void> {
  const url = parseWebhookUrl(callbackUrl);
  await resolvePublicAddresses(url.hostname.replace(/^\[|\]$/g, ''));
}

export interface WebhookHttpResponse {
  ok: boolean;
  status: number;
  statusText: string;
}

export async function sendWebhookRequest(
  callbackUrl: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<WebhookHttpResponse> {
  const url = parseWebhookUrl(callbackUrl);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await resolvePublicAddresses(hostname);
  const destination = addresses[0];

  if (!destination) {
    throw new WebhookEgressPolicyError('callbackUrl did not resolve to an address');
  }

  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: destination.address,
        family: destination.family,
        port: 443,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        agent: false,
        servername: isIP(hostname) ? undefined : hostname,
        headers: {
          ...headers,
          host: url.host,
        },
      },
      (response) => {
        response.resume();
        response.once('end', () => {
          clearTimeout(timeoutHandle);
          const status = response.statusCode ?? 0;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            statusText: response.statusMessage ?? '',
          });
        });
      },
    );

    const timeoutHandle = setTimeout(() => {
      request.destroy(new Error(`Webhook request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timeoutHandle.unref?.();
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Webhook request timed out after ${timeoutMs}ms`));
    });
    request.once('error', (error) => {
      clearTimeout(timeoutHandle);
      reject(error);
    });
    request.end(body);
  });
}

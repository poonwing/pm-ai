import os from 'os';
import { PORT } from '../shared/schemas.js';

/** Server bind address. Use `0.0.0.0` to allow LAN access. */
export const BIND_HOST = process.env.HOST?.trim() || '127.0.0.1';

/** Optional explicit LAN IP for URLs (preview, settings display). */
export const LAN_HOST = process.env.PM_AI_LAN_HOST?.trim() || '';

export function isLanMode(): boolean {
  return BIND_HOST === '0.0.0.0' || BIND_HOST === '::';
}

function hostnameFromHostHeader(host: string): string {
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end >= 0 ? host.slice(1, end).toLowerCase() : host.toLowerCase();
  }
  return host.split(':')[0].toLowerCase();
}

export function isPrivateOrLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  const m = h.match(/^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (m) {
    const second = parseInt(m[1], 10);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

export function isAllowedRequestHost(hostHeader: string): boolean {
  if (!hostHeader) return false;
  const hostname = hostnameFromHostHeader(hostHeader);
  if (isPrivateOrLocalHost(hostname)) return true;
  if (isLanMode() && LAN_HOST && hostname === LAN_HOST.toLowerCase()) return true;
  return false;
}

export function getLanAddresses(): string[] {
  if (LAN_HOST) return [LAN_HOST];
  const addrs: string[] = [];
  for (const iface of Object.values(os.networkInterfaces())) {
    if (!iface) continue;
    for (const info of iface) {
      if (info.family === 'IPv4' && !info.internal) {
        addrs.push(info.address);
      }
    }
  }
  return [...new Set(addrs)];
}

export function getPublicHostForUrls(port = PORT): string {
  if (!isLanMode()) return '127.0.0.1';
  const addrs = getLanAddresses();
  return addrs[0] ?? '127.0.0.1';
}

export function buildAccessUrls(port: number): { local: string; lan: string[] } {
  const local = `http://127.0.0.1:${port}`;
  if (!isLanMode()) return { local, lan: [] };
  const lan = getLanAddresses().map((addr) => `http://${addr}:${port}`);
  return { local, lan };
}

export function isAllowedCorsOrigin(origin: string, port: number): boolean {
  try {
    const url = new URL(origin);
    const allowedPorts = new Set([String(port), '5173']);
    if (!allowedPorts.has(url.port)) return false;
    return isPrivateOrLocalHost(url.hostname);
  } catch {
    return false;
  }
}

export function getPreviewBindHost(): string {
  return isLanMode() ? '0.0.0.0' : '127.0.0.1';
}

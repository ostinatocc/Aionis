import { isIP } from "node:net";

export function normalizeIp(input: unknown): string {
  let raw = String(input ?? "").trim().toLowerCase();
  if (!raw) return "";
  if (raw.startsWith("[")) {
    const idx = raw.indexOf("]");
    raw = idx > 0 ? raw.slice(1, idx) : raw;
  }
  const zoneIdx = raw.indexOf("%");
  if (zoneIdx > 0) raw = raw.slice(0, zoneIdx);
  if (raw.startsWith("::ffff:")) raw = raw.slice(7);
  if (raw.includes(".") && raw.includes(":") && isIP(raw) !== 6) {
    raw = raw.split(":")[0];
  }
  return raw;
}

export function parseIpv4Int(input: string): number | null {
  const ip = normalizeIp(input);
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out = (out << 8) | n;
  }
  return out >>> 0;
}

export function isIpv4InCidr(ip: string, cidr: string): boolean {
  const [baseRaw, prefixRaw] = String(cidr ?? "").split("/");
  const base = parseIpv4Int(baseRaw);
  const ipInt = parseIpv4Int(ip);
  const prefix = Number(prefixRaw);
  if (base == null || ipInt == null) return false;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (base & mask) === (ipInt & mask);
}

function ipv4TailToHextets(value: string): string[] | null {
  const parsed = parseIpv4Int(value);
  if (parsed == null) return null;
  return [
    ((parsed >>> 16) & 0xffff).toString(16),
    (parsed & 0xffff).toString(16),
  ];
}

function ipv6Groups(input: string): number[] | null {
  const ip = normalizeIp(input);
  if (isIP(ip) !== 6) return null;
  const halves = ip.split("::");
  if (halves.length > 2) return null;

  const parseSide = (side: string): string[] | null => {
    if (!side) return [];
    const pieces = side.split(":").filter((piece) => piece.length > 0);
    const out: string[] = [];
    for (const piece of pieces) {
      if (piece.includes(".")) {
        const tail = ipv4TailToHextets(piece);
        if (!tail) return null;
        out.push(...tail);
      } else {
        out.push(piece);
      }
    }
    return out;
  };

  const left = parseSide(halves[0] ?? "");
  const right = parseSide(halves[1] ?? "");
  if (!left || !right) return null;
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (missing < 0) return null;
  const groups = halves.length === 2
    ? [...left, ...Array.from({ length: missing }, () => "0"), ...right]
    : left;
  if (groups.length !== 8) return null;

  const out: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    const value = Number.parseInt(group, 16);
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) return null;
    out.push(value);
  }
  return out;
}

export function parseIpv6BigInt(input: string): bigint | null {
  const groups = ipv6Groups(input);
  if (!groups) return null;
  let out = 0n;
  for (const group of groups) {
    out = (out << 16n) | BigInt(group);
  }
  return out;
}

export function isIpInCidr(ip: string, cidr: string): boolean {
  const [baseRaw, prefixRaw] = String(cidr ?? "").split("/");
  const normalizedIp = normalizeIp(ip);
  const baseIp = normalizeIp(baseRaw);
  const prefix = Number(prefixRaw);
  const ipFamily = isIP(normalizedIp);
  const baseFamily = isIP(baseIp);

  if (ipFamily === 4 && baseFamily === 4) {
    return isIpv4InCidr(normalizedIp, `${baseIp}/${prefixRaw}`);
  }

  if (ipFamily === 6 && baseFamily === 6) {
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) return false;
    if (prefix === 0) return true;
    const ipInt = parseIpv6BigInt(normalizedIp);
    const baseInt = parseIpv6BigInt(baseIp);
    if (ipInt == null || baseInt == null) return false;
    const hostBits = BigInt(128 - prefix);
    const mask = ((1n << 128n) - 1n) ^ ((1n << hostBits) - 1n);
    return (baseInt & mask) === (ipInt & mask);
  }

  return false;
}

function normalizeTrustedProxyRule(input: unknown): string {
  const raw = String(input ?? "").trim().toLowerCase();
  if (!raw) return "";
  const slash = raw.lastIndexOf("/");
  if (slash > 0 && slash < raw.length - 1) {
    const base = normalizeIp(raw.slice(0, slash));
    const prefix = raw.slice(slash + 1).trim();
    return base && prefix ? `${base}/${prefix}` : "";
  }
  return normalizeIp(raw);
}

export function parseTrustedProxyCidrs(raw: string): string[] {
  return String(raw ?? "")
    .split(",")
    .map((value) => normalizeTrustedProxyRule(value))
    .filter(Boolean);
}

export function ipAllowed(ip: string, allowlist: string[]): boolean {
  const normalizedIp = normalizeIp(ip);
  if (!normalizedIp) return false;
  for (const entryRaw of allowlist) {
    const entry = normalizeIp(entryRaw);
    if (!entry) continue;
    if (entry.includes("/")) {
      if (isIpInCidr(normalizedIp, entry)) return true;
      continue;
    }
    if (entry === normalizedIp) return true;
  }
  return false;
}

export function forwardedClientIp(headers: Record<string, unknown>): string {
  const xff = headers["x-forwarded-for"];
  const xffValue =
    typeof xff === "string"
      ? xff
      : Array.isArray(xff) && typeof xff[0] === "string"
        ? xff[0]
        : "";
  if (xffValue.trim().length > 0) {
    const first = xffValue.split(",")[0];
    const ip = normalizeIp(first);
    if (ip) return ip;
  }
  const xri = headers["x-real-ip"];
  const xriValue =
    typeof xri === "string"
      ? xri
      : Array.isArray(xri) && typeof xri[0] === "string"
        ? xri[0]
        : "";
  return normalizeIp(xriValue);
}

export function resolveTrustedClientIp(input: {
  remoteAddress: string | undefined;
  headers: Record<string, unknown>;
  trustedProxyCidrs: string[];
}): string {
  const remoteIp = normalizeIp(input.remoteAddress);
  if (!remoteIp) return "";
  if (ipAllowed(remoteIp, input.trustedProxyCidrs)) {
    const forwarded = forwardedClientIp(input.headers);
    if (forwarded) return forwarded;
  }
  return remoteIp;
}

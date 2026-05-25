import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

export type ParsedCidr = {
  family: 4 | 6;
  prefix: number;
  network: bigint;
  mask: bigint;
};

export function sandboxRemoteHostAllowed(hostname: string, allowlist: Set<string>): boolean {
  const host = hostname.trim().toLowerCase();
  if (!host) return false;
  if (allowlist.size === 0) return false;
  for (const raw of allowlist.values()) {
    const rule = raw.trim().toLowerCase();
    if (!rule) continue;
    if (rule.startsWith("*.")) {
      const suffix = rule.slice(2);
      if (!suffix) continue;
      if (host === suffix || host.endsWith(`.${suffix}`)) return true;
      continue;
    }
    if (host === rule) return true;
  }
  return false;
}

export function trimTrailingSlash(v: string): string {
  return v.replace(/\/+$/g, "");
}

export function sha256Text(v: string): string {
  return createHash("sha256").update(v, "utf8").digest("hex");
}

function normalizeIpv4(ip: string): string | null {
  const parts = ip.trim().split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (!Number.isFinite(n) || n < 0 || n > 255) return null;
    octets.push(n);
  }
  return octets.join(".");
}

function parseIpv6ToHextets(raw: string): number[] | null {
  const input = raw.trim().toLowerCase();
  if (!input) return null;
  const zone = input.indexOf("%");
  const stripped = zone >= 0 ? input.slice(0, zone) : input;
  const hasDouble = stripped.includes("::");
  if (hasDouble && stripped.indexOf("::") !== stripped.lastIndexOf("::")) return null;
  const [leftRaw, rightRaw] = hasDouble ? stripped.split("::") : [stripped, ""];
  const left = leftRaw.length > 0 ? leftRaw.split(":") : [];
  const right = rightRaw.length > 0 ? rightRaw.split(":") : [];

  const parsePart = (part: string): number[] | null => {
    if (!part) return [];
    if (part.includes(".")) {
      const normalized = normalizeIpv4(part);
      if (!normalized) return null;
      const octets = normalized.split(".").map((x) => Number(x));
      return [((octets[0] << 8) | octets[1]) & 0xffff, ((octets[2] << 8) | octets[3]) & 0xffff];
    }
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
    return [Number.parseInt(part, 16)];
  };

  const leftNums: number[] = [];
  for (const part of left) {
    const parsed = parsePart(part);
    if (!parsed) return null;
    leftNums.push(...parsed);
  }
  const rightNums: number[] = [];
  for (const part of right) {
    const parsed = parsePart(part);
    if (!parsed) return null;
    rightNums.push(...parsed);
  }

  if (hasDouble) {
    const zeros = 8 - (leftNums.length + rightNums.length);
    if (zeros < 0) return null;
    return [...leftNums, ...new Array(zeros).fill(0), ...rightNums];
  }
  if (leftNums.length !== 8) return null;
  return leftNums;
}

function ipToBigInt(ipRaw: string): { family: 4 | 6; value: bigint } | null {
  const ip = ipRaw.trim();
  const family = isIP(ip);
  if (family === 4) {
    const normalized = normalizeIpv4(ip);
    if (!normalized) return null;
    const value = normalized
      .split(".")
      .map((x) => BigInt(Number(x)))
      .reduce((acc, oct) => (acc << 8n) + oct, 0n);
    return { family: 4, value };
  }
  if (family === 6) {
    const hextets = parseIpv6ToHextets(ip);
    if (!hextets || hextets.length !== 8) return null;
    let value = 0n;
    for (const h of hextets) value = (value << 16n) + BigInt(h);
    return { family: 6, value };
  }
  return null;
}

export function parseCidrRule(raw: string): ParsedCidr | null {
  const v = String(raw ?? "").trim();
  if (!v) return null;
  const slash = v.lastIndexOf("/");
  if (slash <= 0 || slash >= v.length - 1) return null;
  const ipPart = v.slice(0, slash).trim();
  const prefixRaw = v.slice(slash + 1).trim();
  const ip = ipToBigInt(ipPart);
  if (!ip) return null;
  const bits = ip.family === 4 ? 32 : 128;
  const prefix = Number(prefixRaw);
  if (!Number.isFinite(prefix) || Math.trunc(prefix) !== prefix || prefix < 0 || prefix > bits) return null;
  const shift = BigInt(bits - prefix);
  const fullMask = (1n << BigInt(bits)) - 1n;
  const mask = prefix === 0 ? 0n : (fullMask << shift) & fullMask;
  return {
    family: ip.family,
    prefix,
    network: ip.value & mask,
    mask,
  };
}

export function ipInCidrs(ip: string, cidrs: readonly ParsedCidr[]): boolean {
  const parsedIp = ipToBigInt(ip);
  if (!parsedIp) return false;
  for (const cidr of cidrs) {
    if (cidr.family !== parsedIp.family) continue;
    if ((parsedIp.value & cidr.mask) === cidr.network) return true;
  }
  return false;
}

export function sandboxRemoteEgressAllowed(resolvedIps: readonly string[], cidrs: readonly ParsedCidr[]): boolean {
  if (cidrs.length === 0 || resolvedIps.length === 0) return false;
  return resolvedIps.every((ip) => ipInCidrs(ip, cidrs));
}

export function isPrivateOrLocalIp(ipRaw: string): boolean {
  const parsed = ipToBigInt(ipRaw);
  if (!parsed) return true;
  if (parsed.family === 4) {
    const n = Number(parsed.value);
    const b1 = (n >>> 24) & 0xff;
    const b2 = (n >>> 16) & 0xff;
    if (b1 === 10) return true;
    if (b1 === 127) return true;
    if (b1 === 0) return true;
    if (b1 === 169 && b2 === 254) return true;
    if (b1 === 172 && b2 >= 16 && b2 <= 31) return true;
    if (b1 === 192 && b2 === 168) return true;
    if (b1 >= 224) return true;
    return false;
  }
  const ip = parseIpv6ToHextets(ipRaw);
  if (!ip || ip.length !== 8) return true;
  if (ip.every((x) => x === 0)) return true;
  if (ip[0] === 0 && ip[1] === 0 && ip[2] === 0 && ip[3] === 0 && ip[4] === 0 && ip[5] === 0 && ip[6] === 0 && ip[7] === 1) return true;
  if ((ip[0] & 0xfe00) === 0xfc00) return true;
  if ((ip[0] & 0xffc0) === 0xfe80) return true;
  if (ip[0] === 0xff00) return true;
  if (
    ip[0] === 0
    && ip[1] === 0
    && ip[2] === 0
    && ip[3] === 0
    && ip[4] === 0
    && ip[5] === 0xffff
  ) {
    const b1 = (ip[6] >>> 8) & 0xff;
    const b2 = ip[6] & 0xff;
    const b3 = (ip[7] >>> 8) & 0xff;
    const b4 = ip[7] & 0xff;
    return isPrivateOrLocalIp(`${b1}.${b2}.${b3}.${b4}`);
  }
  return false;
}

export async function postJsonWithTls(
  target: URL,
  payload: string,
  headers: Record<string, string>,
  timeoutMs: number,
  signal: AbortSignal,
  tls: {
    certPem: string;
    keyPem: string;
    caPem: string;
    serverName: string;
  },
  opts?: {
    resolvedAddress?: string | null;
    maxBodyBytes?: number;
  },
): Promise<{ status: number; bodyText: string }> {
  const isHttps = target.protocol === "https:";
  const defaultPort = isHttps ? 443 : 80;
  const path = `${target.pathname}${target.search}`;
  const maxBodyBytes = Math.max(1024, Math.trunc(Number(opts?.maxBodyBytes ?? 512 * 1024)));
  const forcedAddress = typeof opts?.resolvedAddress === "string" ? opts.resolvedAddress.trim() : "";
  const normalizedForcedAddress = forcedAddress.length > 0 ? forcedAddress : null;
  const forcedFamily = normalizedForcedAddress ? isIP(normalizedForcedAddress) : 0;
  const forcedLookup =
    normalizedForcedAddress && (forcedFamily === 4 || forcedFamily === 6)
      ? (_hostname: string, optionsOrCallback: unknown, callbackMaybe?: unknown) => {
          const options =
            optionsOrCallback && typeof optionsOrCallback === "object" && !Array.isArray(optionsOrCallback)
              ? (optionsOrCallback as Record<string, unknown>)
              : null;
          const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : callbackMaybe;
          if (typeof callback !== "function") return;
          if (options?.all === true) {
            callback(null, [{ address: normalizedForcedAddress, family: forcedFamily }]);
            return;
          }
          callback(null, normalizedForcedAddress, forcedFamily);
        }
      : undefined;

  return await new Promise((resolve, reject) => {
    let settled = false;
    let abortHandler: (() => void) | null = null;
    let req: ReturnType<typeof httpRequest> | ReturnType<typeof httpsRequest> | null = null;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (abortHandler) signal.removeEventListener("abort", abortHandler);
      fn();
    };
    const onAbort = () => done(() => reject(new Error("aborted")));
    if (signal.aborted) {
      onAbort();
      return;
    }

    const onResponse = (res: NodeJS.ReadableStream & { statusCode?: number; destroy(error?: Error): void; on(event: string, listener: (...args: any[]) => void): void; }) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      res.on("data", (chunk: Buffer | string) => {
        const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        totalBytes += part.length;
        if (totalBytes > maxBodyBytes) {
          try {
            res.destroy(new Error("response_too_large"));
          } catch {
            // ignore best-effort stream abort errors
          }
          done(() => reject(new Error("response_too_large")));
          return;
        }
        chunks.push(part);
      });
      res.on("end", () => {
        const bodyText = Buffer.concat(chunks).toString("utf8");
        done(() => resolve({ status: Number(res.statusCode ?? 0), bodyText }));
      });
      res.on("error", (err: unknown) => done(() => reject(err as Error)));
    };

    req = isHttps
      ? httpsRequest(
          {
            protocol: target.protocol,
            hostname: target.hostname,
            port: target.port ? Number(target.port) : defaultPort,
            method: "POST",
            path,
            headers,
            timeout: timeoutMs,
            lookup: forcedLookup,
            cert: tls.certPem || undefined,
            key: tls.keyPem || undefined,
            ca: tls.caPem || undefined,
            servername: tls.serverName || target.hostname,
            rejectUnauthorized: true,
          },
          onResponse,
        )
      : httpRequest(
          {
            protocol: target.protocol,
            hostname: target.hostname,
            port: target.port ? Number(target.port) : defaultPort,
            method: "POST",
            path,
            headers,
            timeout: timeoutMs,
            lookup: forcedLookup,
          },
          onResponse,
        );
    abortHandler = () => {
      try {
        req?.destroy(new Error("aborted"));
      } catch {
        // ignore
      }
      onAbort();
    };
    signal.addEventListener("abort", abortHandler);
    req.on("timeout", () => {
      try {
        req?.destroy(new Error("request_timeout"));
      } catch {
        // ignore
      }
    });
    req.on("error", (err: unknown) => done(() => reject(err as Error)));
    req.write(payload, "utf8");
    req.end();
  });
}

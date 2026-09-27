import { isIP } from "node:net";
import type { ProxyTrust } from "./config.js";

type HeaderValue = string | string[] | undefined;

function normalizedIp(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (value.startsWith("::ffff:")) {
    const ipv4 = value.slice("::ffff:".length);
    if (isIP(ipv4) === 4) return ipv4;
  }
  return isIP(value) === 0 ? undefined : value;
}

function firstHeader(value: HeaderValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isLoopback(address: string | undefined): boolean {
  const ip = normalizedIp(address);
  return ip === "::1" || ip?.startsWith("127.") === true;
}

/**
 * Expands an IPv6 literal into its eight 16-bit groups, lowercase and without
 * leading zeros. The caller has already validated the syntax with isIP, so the
 * only shapes here are a full address, one "::" run, and the trailing
 * dotted-quad form.
 */
function ipv6Groups(value: string): string[] | undefined {
  const halves = value.split("::");
  if (halves.length > 2) return undefined;
  const parse = (part: string): string[] => {
    if (part === "") return [];
    const groups: string[] = [];
    for (const token of part.split(":")) {
      if (token.includes(".")) {
        const octets = token.split(".").map((octet) => Number(octet));
        const valid =
          octets.length === 4 &&
          octets.every((octet) => octet >= 0 && octet <= 255);
        if (!valid) return [];
        groups.push((((octets[0] ?? 0) << 8) | (octets[1] ?? 0)).toString(16));
        groups.push((((octets[2] ?? 0) << 8) | (octets[3] ?? 0)).toString(16));
        continue;
      }
      groups.push(Number.parseInt(token, 16).toString(16));
    }
    return groups;
  };
  const head = parse(halves[0] ?? "");
  if (halves.length === 1) return head.length === 8 ? head : undefined;
  const tail = parse(halves[1] ?? "");
  const gap = 8 - head.length - tail.length;
  if (gap < 1) return undefined;
  return [...head, ...Array.from({ length: gap }, () => "0"), ...tail];
}

/**
 * The key a per-source budget is counted against. IPv4 addresses key on
 * themselves, which is how they were always counted. IPv6 addresses key on
 * their /64 prefix, because a single residential or hosted assignment is a /64
 * or larger: keying on the full address would hand one holder billions of
 * separate budgets, which is the same as having none. IPv4-mapped addresses
 * were already reduced to their IPv4 form before this point.
 *
 * The book uses this key for every per-source budget it keeps, so the grouping
 * is consistent across the HTTP rate limiter, the body-read bound, the SSE
 * connection count, the federation lanes and the store's hashed taker source.
 */
export function clientSourceKey(ip: string): string {
  // An IPv4-mapped literal is an IPv4 source. resolveClientIp already reduces
  // the ones it parses, and doing it here as well keeps any other caller from
  // filing every mapped address under the same ::/64 bucket.
  const mapped = normalizedIp(ip);
  const value = mapped ?? ip;
  if (isIP(value) !== 6) return value;
  const groups = ipv6Groups(value);
  if (groups === undefined) return value;
  return `${groups.slice(0, 4).join(":")}::/64`;
}

export function resolveClientIp(
  remoteAddress: string | undefined,
  headers: { "cf-connecting-ip"?: HeaderValue; "x-forwarded-for"?: HeaderValue },
  proxyTrust: ProxyTrust,
): string {
  if (proxyTrust === "all" || (proxyTrust === "loopback" && isLoopback(remoteAddress))) {
    const cloudflare = normalizedIp(firstHeader(headers["cf-connecting-ip"]));
    if (cloudflare !== undefined) return clientSourceKey(cloudflare);

    const forwarded = firstHeader(headers["x-forwarded-for"])?.split(",", 1)[0];
    const forwardedIp = normalizedIp(forwarded);
    if (forwardedIp !== undefined) return clientSourceKey(forwardedIp);
  }

  const direct = normalizedIp(remoteAddress);
  return direct === undefined ? "unknown" : clientSourceKey(direct);
}

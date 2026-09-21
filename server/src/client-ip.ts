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

export function resolveClientIp(
  remoteAddress: string | undefined,
  headers: { "cf-connecting-ip"?: HeaderValue; "x-forwarded-for"?: HeaderValue },
  proxyTrust: ProxyTrust,
): string {
  if (proxyTrust === "all" || (proxyTrust === "loopback" && isLoopback(remoteAddress))) {
    const cloudflare = normalizedIp(firstHeader(headers["cf-connecting-ip"]));
    if (cloudflare !== undefined) return cloudflare;

    const forwarded = firstHeader(headers["x-forwarded-for"])?.split(",", 1)[0];
    const forwardedIp = normalizedIp(forwarded);
    if (forwardedIp !== undefined) return forwardedIp;
  }

  return normalizedIp(remoteAddress) ?? "unknown";
}

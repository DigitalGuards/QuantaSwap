// Synthetic source addresses for the harness. Makers and takers use the RFC
// 5737 IPv4 documentation blocks (identity.ts), while readers, stream
// subscribers and the harness's own probes use the RFC 3849 IPv6
// documentation prefix. Keeping every role in a distinct address space means
// no two roles ever share a per-source budget by accident.

const READER_PREFIX = "2001:db8:1::";
const SUBSCRIBER_PREFIX = "2001:db8:2::";

/** Source address used by the health probe sampler. */
export const PROBE_IP = "2001:db8:9::1";
/** Source address used by the end-of-scenario invariant checks. */
export const AUDIT_IP = "2001:db8:9::2";
/** The one address every client shares in the shared-source scenario. */
export const SHARED_IP = "203.0.113.200";

export function readerIp(index: number): string {
  return `${READER_PREFIX}${(index + 1).toString(16)}`;
}

export function subscriberIp(index: number): string {
  return `${SUBSCRIBER_PREFIX}${(index + 1).toString(16)}`;
}

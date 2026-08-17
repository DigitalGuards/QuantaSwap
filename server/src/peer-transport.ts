import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import { Readable } from "node:stream";
import { SocksProxyAgent } from "socks-proxy-agent";
import { isLocalOnionProxyHost, V3_ONION_HOST_RE } from "./config.js";

export type FederationFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

interface FederationPeerTransportOptions {
  directFetch?: FederationFetch;
  connectTimeoutMs?: number;
}

function validatedProxyUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("federation onion proxy is invalid");
  }
  if (
    url.protocol !== "socks5h:" ||
    url.hostname === "" ||
    !isLocalOnionProxyHost(url.hostname) ||
    url.port === "" ||
    url.username !== "" ||
    url.password !== "" ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("federation onion proxy must be a local plain socks5h URL");
  }
  return url.toString().replace(/\/$/, "");
}

function requestUrl(input: string | URL): URL {
  const url = input instanceof URL ? input : new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("federation transport only supports HTTP(S) URLs");
  }
  return url;
}

function copiedHeaders(init: HeadersInit | undefined): Record<string, string> {
  const copied: Record<string, string> = {};
  new Headers(init ?? {}).forEach((value, key) => {
    copied[key] = value;
  });
  return copied;
}

function responseHeaders(rawHeaders: string[]): Headers {
  const headers = new Headers();
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (name !== undefined && value !== undefined) headers.append(name, value);
  }
  return headers;
}

export class FederationPeerTransport {
  private readonly onionProxy: string | null;
  private readonly agents = new Map<string, SocksProxyAgent>();
  private readonly directFetch: FederationFetch;
  private readonly connectTimeoutMs: number;
  private closed = false;

  constructor(onionProxy: string | null, options: FederationPeerTransportOptions = {}) {
    this.onionProxy = onionProxy === null ? null : validatedProxyUrl(onionProxy);
    this.directFetch = options.directFetch ?? globalThis.fetch.bind(globalThis);
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    if (
      !Number.isSafeInteger(this.connectTimeoutMs) ||
      this.connectTimeoutMs < 1 ||
      this.connectTimeoutMs > 120_000
    ) {
      throw new Error("federation onion proxy timeout is invalid");
    }
  }

  readonly fetch: FederationFetch = async (input, init) => {
    if (this.closed) throw new Error("federation peer transport is closed");
    const url = requestUrl(input);
    if (!V3_ONION_HOST_RE.test(url.hostname)) {
      return this.directFetch(input, init);
    }
    if (this.onionProxy === null) {
      throw new Error("federation onion peer has no SOCKS route");
    }
    if (init?.body !== undefined && init.body !== null) {
      throw new Error("federation onion transport does not accept request bodies");
    }
    if (init?.method !== undefined && init.method.toUpperCase() !== "GET") {
      throw new Error("federation onion transport only accepts GET requests");
    }
    if (init?.redirect !== undefined && init.redirect !== "error") {
      throw new Error("federation onion transport requires redirect rejection");
    }

    let agent = this.agents.get(url.origin);
    if (agent === undefined) {
      agent = new SocksProxyAgent(this.onionProxy, {
        keepAlive: true,
        maxSockets: 1,
        timeout: this.connectTimeoutMs,
      });
      this.agents.set(url.origin, agent);
    }

    try {
      return await new Promise<Response>((resolve, reject) => {
        const request = (url.protocol === "https:" ? requestHttps : requestHttp)(
          url,
          {
            agent,
            headers: copiedHeaders(init?.headers),
            method: "GET",
            ...(init?.signal === undefined || init.signal === null
              ? {}
              : { signal: init.signal }),
          },
          (incoming) => {
            const status = incoming.statusCode;
            if (status === undefined || status < 200 || status > 599) {
              incoming.destroy();
              reject(new Error("federation onion peer returned an invalid HTTP status"));
              return;
            }
            try {
              const body =
                status === 204 || status === 304
                  ? null
                  : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>);
              resolve(
                new Response(body, {
                  headers: responseHeaders(incoming.rawHeaders),
                  status,
                  ...(incoming.statusMessage === undefined
                    ? {}
                    : { statusText: incoming.statusMessage }),
                }),
              );
            } catch (error) {
              incoming.destroy();
              reject(error);
            }
          },
        );
        request.once("error", reject);
        request.end();
      });
    } catch (error) {
      if (this.agents.get(url.origin) === agent) this.agents.delete(url.origin);
      agent.destroy();
      throw error;
    }
  };

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const agents = [...this.agents.values()];
    this.agents.clear();
    for (const agent of agents) agent.destroy();
  }
}

import { strict as assert } from "node:assert";
import { createServer as createHttpServer } from "node:http";
import {
  connect as connectTcp,
  createServer as createTcpServer,
  type Server as TcpServer,
} from "node:net";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { FederationPeerTransport } from "./peer-transport.js";

const ONION_HOST = `${"a".repeat(56)}.onion`;

async function listen(server: TcpServer | ReturnType<typeof createHttpServer>): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return (server.address() as AddressInfo).port;
}

async function closeServer(server: TcpServer | ReturnType<typeof createHttpServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

interface SocksObservation {
  host: string;
  port: number;
  addressType: number;
}

function fakeSocksServer(
  upstreamPort: number,
  observed: (observation: SocksObservation) => void,
): TcpServer {
  return createTcpServer((client) => {
    let pending = Buffer.alloc(0);
    let stage: "greeting" | "connect" | "stream" = "greeting";
    const fail = (error: unknown): void => {
      client.destroy(error instanceof Error ? error : new Error(String(error)));
    };
    const processPending = (): void => {
      try {
        if (stage === "greeting") {
          if (pending.length < 2) return;
          const methodCount = pending[1] ?? 0;
          const messageLength = 2 + methodCount;
          if (pending.length < messageLength) return;
          assert.equal(pending[0], 5);
          pending = pending.subarray(messageLength);
          client.write(Buffer.from([5, 0]));
          stage = "connect";
        }
        if (stage !== "connect" || pending.length < 5) return;
        assert.equal(pending[0], 5);
        assert.equal(pending[1], 1);
        const addressType = pending[3] ?? 0;
        assert.equal(addressType, 3);
        const hostLength = pending[4] ?? 0;
        const messageLength = 7 + hostLength;
        if (pending.length < messageLength) return;
        const host = pending.subarray(5, 5 + hostLength).toString("utf8");
        const port = pending.readUInt16BE(5 + hostLength);
        pending = pending.subarray(messageLength);
        observed({ host, port, addressType });

        const upstream = connectTcp(upstreamPort, "127.0.0.1");
        upstream.once("error", fail);
        upstream.once("connect", () => {
          client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          if (pending.length > 0) upstream.write(pending);
          pending = Buffer.alloc(0);
          stage = "stream";
          client.pipe(upstream).pipe(client);
        });
      } catch (error) {
        fail(error);
      }
    };
    client.on("data", (chunk: Buffer) => {
      if (stage === "stream") return;
      pending = Buffer.concat([pending, chunk]);
      processPending();
    });
  });
}

describe("federation onion transport", () => {
  it("sends the canonical onion hostname to SOCKS as a domain", async () => {
    const target = createHttpServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"status":"ok"}');
    });
    const targetPort = await listen(target);
    let observation: SocksObservation | undefined;
    const proxy = fakeSocksServer(targetPort, (value) => {
      observation = value;
    });
    const proxyPort = await listen(proxy);
    const transport = new FederationPeerTransport(`socks5h://127.0.0.1:${proxyPort}`);
    try {
      const response = await transport.fetch(
        `http://${ONION_HOST}:${targetPort}/api/federation/v1/events`,
        { headers: { Accept: "application/json" }, redirect: "error" },
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { status: "ok" });
      assert.deepEqual(observation, {
        host: ONION_HOST,
        port: targetPort,
        addressType: 3,
      });
    } finally {
      await transport.close();
      await closeServer(proxy);
      await closeServer(target);
    }
  });

  it("leaves clearnet peers on the direct transport", async () => {
    const requested: string[] = [];
    const directFetch = async (input: string | URL): Promise<Response> => {
      requested.push(String(input));
      return new Response("{}", { headers: { "Content-Type": "application/json" } });
    };
    const transport = new FederationPeerTransport(
      "socks5h://127.0.0.1:1",
      { directFetch },
    );
    try {
      const response = await transport.fetch("https://book.example/api/health");
      assert.equal(response.status, 200);
      assert.deepEqual(requested, ["https://book.example/api/health"]);
    } finally {
      await transport.close();
    }
  });

  it("fails closed without a SOCKS route and after transport shutdown", async () => {
    const transport = new FederationPeerTransport(null);
    await assert.rejects(
      transport.fetch(`http://${ONION_HOST}/api/federation/v1/events`),
      /no SOCKS route/,
    );
    await transport.close();
    await assert.rejects(
      transport.fetch("https://book.example/api/health"),
      /transport is closed/,
    );
  });

  it("rejects proxy schemes that permit local target lookup", () => {
    assert.throws(
      () => new FederationPeerTransport("socks5://127.0.0.1:9050"),
      /plain socks5h URL/,
    );
    assert.throws(
      () => new FederationPeerTransport("socks5h://proxy.example:9050"),
      /local plain socks5h URL/,
    );
  });

  it("closes a stalled SOCKS connection after the request deadline", async () => {
    const sockets = new Set<import("node:net").Socket>();
    const proxy = createTcpServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.on("data", () => {
        // Deliberately never complete the SOCKS greeting.
      });
    });
    const proxyPort = await listen(proxy);
    const transport = new FederationPeerTransport(`socks5h://127.0.0.1:${proxyPort}`, {
      connectTimeoutMs: 50,
    });
    try {
      await assert.rejects(
        transport.fetch(`http://${ONION_HOST}/api/federation/v1/events`, {
          redirect: "error",
          signal: AbortSignal.timeout(25),
        }),
      );
      await transport.close();
      for (let attempt = 0; attempt < 20 && sockets.size > 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(sockets.size, 0);
    } finally {
      await transport.close();
      for (const socket of sockets) socket.destroy();
      await closeServer(proxy);
    }
  });
});

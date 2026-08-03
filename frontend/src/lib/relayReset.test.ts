import { describe, expect, it } from "vitest";
import {
  activateExtensionAfterRelayRetirement,
  ConnectionAttemptGuard,
  RelayResetGuard,
  shouldIgnoreRelayResetEvent,
} from "./relayReset";

describe("relay reset event generation", () => {
  it("ignores the SDK teardown sequence only during an explicit rotation", () => {
    const guard = new RelayResetGuard();
    expect(shouldIgnoreRelayResetEvent(guard, "accounts")).toBe(false);
    expect(shouldIgnoreRelayResetEvent(guard, "disconnect")).toBe(false);

    const generation = guard.begin();
    expect(shouldIgnoreRelayResetEvent(guard, "accounts")).toBe(true);
    expect(shouldIgnoreRelayResetEvent(guard, "disconnect")).toBe(true);
    expect(shouldIgnoreRelayResetEvent(guard, "status")).toBe(true);

    expect(guard.finish(generation)).toBe(true);
    expect(shouldIgnoreRelayResetEvent(guard, "accounts")).toBe(false);
  });

  it("does not let a stale reset completion clear a newer rotation", () => {
    const guard = new RelayResetGuard();
    const first = guard.begin();
    const second = guard.begin();

    expect(guard.finish(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);
    expect(shouldIgnoreRelayResetEvent(guard, "disconnect")).toBe(true);
    expect(guard.finish(second)).toBe(true);
  });

  it("invalidates late work after a lifecycle reset", () => {
    const guard = new RelayResetGuard();
    const generation = guard.begin();
    guard.invalidate();

    expect(guard.isCurrent(generation)).toBe(false);
    expect(guard.finish(generation)).toBe(false);
    expect(guard.active).toBe(false);
  });

  it("serializes picker attempts and rejects stale async completions", () => {
    const guard = new ConnectionAttemptGuard();
    const extension = guard.begin("extension");
    expect(extension).not.toBeNull();
    expect(guard.isPending("extension")).toBe(true);
    expect(guard.begin("relay")).toBeNull();

    expect(guard.finish(extension as number)).toBe(true);
    const relay = guard.begin("relay");
    expect(relay).not.toBeNull();
    expect(guard.finish(extension as number)).toBe(false);
    expect(guard.isCurrent(relay as number)).toBe(true);
    guard.invalidate();
    expect(guard.isCurrent(relay as number)).toBe(false);
  });

  it("retires relay state before extension approval and activation", async () => {
    const order: string[] = [];
    const result = await activateExtensionAfterRelayRetirement(
      async () => {
        order.push("retire relay");
        return null;
      },
      async () => {
        order.push("request approval");
        return ["account"];
      },
      (accounts) => {
        order.push("activate extension");
        return accounts[0];
      },
    );

    expect(order).toEqual(["retire relay", "request approval", "activate extension"]);
    expect(result).toEqual({ ok: true, value: "account" });
  });

  it("blocks extension approval and activation when relay retirement fails", async () => {
    const retirementError = new Error("relay still live");
    let requested = false;
    let activated = false;
    const result = await activateExtensionAfterRelayRetirement(
      async () => retirementError,
      async () => {
        requested = true;
        return ["account"];
      },
      () => {
        activated = true;
      },
    );

    expect(requested).toBe(false);
    expect(activated).toBe(false);
    expect(result).toEqual({ ok: false, retirementError });
  });

  it("does not activate extension transport after rejected approval", async () => {
    const order: string[] = [];
    await expect(
      activateExtensionAfterRelayRetirement(
        async () => {
          order.push("retire relay");
          return null;
        },
        async () => {
          order.push("request approval");
          throw new Error("user rejected");
        },
        () => {
          order.push("activate extension");
        },
      ),
    ).rejects.toThrow("user rejected");
    expect(order).toEqual(["retire relay", "request approval"]);
  });
});

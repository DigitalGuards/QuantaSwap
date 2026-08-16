import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { ApiError, OrderStore } from "./store.js";

const tempDirectories: string[] = [];
const makeTemp = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "quantaswap-store-test-"));
  tempDirectories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const ONE = (10n ** 18n).toString();
const orderBody = (index = 1): Record<string, unknown> => ({
  direction: "eth->qrl",
  fromAmount: ONE,
  toAmount: ONE,
  makerEthAccount: `0x${index.toString(16).padStart(40, "0")}`,
  makerQrlAccount: `Q${index.toString(16).padStart(40, "0")}`,
});

describe("order-store persistence", () => {
  it("allows a missing first-boot file and creates private durable state", () => {
    const dataFile = join(makeTemp(), "nested", "orders.json");
    const store = new OrderStore(dataFile);
    assert.equal(store.storageReady(), true);
    const created = store.create(orderBody(), "203.0.113.1");
    assert.equal("creatorIpHash" in created.order, false);
    assert.equal(statSync(dataFile).mode & 0o777, 0o600);
    const persisted = JSON.parse(readFileSync(dataFile, "utf8")) as Array<Record<string, unknown>>;
    assert.match(String(persisted[0]?.["creatorIpHash"]), /^[0-9a-f]{64}$/);
  });

  it("refuses corrupt or structurally invalid state without replacing it", () => {
    const directory = makeTemp();
    const corrupt = join(directory, "corrupt.json");
    writeFileSync(corrupt, "not-json");
    assert.throws(() => new OrderStore(corrupt), /not valid JSON/);
    assert.equal(readFileSync(corrupt, "utf8"), "not-json");

    const wrongShape = join(directory, "wrong-shape.json");
    writeFileSync(wrongShape, JSON.stringify({ orders: [] }));
    assert.throws(() => new OrderStore(wrongShape), /must contain an array/);

    const malformedRow = join(directory, "malformed-row.json");
    writeFileSync(malformedRow, JSON.stringify([{ id: "wrong" }]));
    assert.throws(() => new OrderStore(malformedRow), /invalid direction/);

    const duplicate = join(directory, "duplicate.json");
    const source = new OrderStore(duplicate);
    source.create(orderBody(), "203.0.113.1");
    const rows = JSON.parse(readFileSync(duplicate, "utf8")) as unknown[];
    writeFileSync(duplicate, JSON.stringify([rows[0], rows[0]]));
    assert.throws(() => new OrderStore(duplicate), /duplicate id/);
  });

  it("caps unsigned open listings per maker and source", () => {
    const makerStore = new OrderStore(join(makeTemp(), "maker.json"));
    for (let index = 0; index < 40; index += 1) {
      makerStore.create(orderBody(1), `203.0.113.${index + 1}`);
    }
    assert.throws(
      () => makerStore.create(orderBody(1), "198.51.100.1"),
      (error) => error instanceof ApiError && error.status === 429,
    );

    const sourceStore = new OrderStore(join(makeTemp(), "source.json"));
    for (let index = 1; index <= 50; index += 1) {
      sourceStore.create(orderBody(index), "198.51.100.2");
    }
    assert.throws(
      () => sourceStore.create(orderBody(51), "198.51.100.2"),
      (error) => error instanceof ApiError && error.status === 429,
    );
  });

  it("reports an unwritable storage directory as not ready", () => {
    const directory = makeTemp();
    const nested = join(directory, "state");
    mkdirSync(nested);
    const dataFile = join(nested, "orders.json");
    const store = new OrderStore(dataFile);
    rmSync(nested, { recursive: true, force: true });
    assert.equal(store.storageReady(), false);
  });
});

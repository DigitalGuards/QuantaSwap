import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { BoundedSseWriter } from "./stream.js";

class FakeResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  acceptWrites = true;
  writes: string[] = [];

  write(chunk: string): boolean {
    this.writes.push(chunk);
    return this.acceptWrites;
  }

  destroy(): this {
    this.destroyed = true;
    return this;
  }

  end(): this {
    this.writableEnded = true;
    return this;
  }
}

describe("bounded SSE writer", () => {
  it("resumes after a client drains its one buffered write", () => {
    const response = new FakeResponse();
    let closed = 0;
    const writer = new BoundedSseWriter(response, 1000, () => {
      closed += 1;
    });

    response.acceptWrites = false;
    assert.equal(writer.write("first"), true);
    response.acceptWrites = true;
    response.emit("drain");
    assert.equal(writer.write("second"), true);
    assert.deepEqual(response.writes, ["first", "second"]);
    assert.equal(closed, 0);
    writer.close();
    assert.equal(closed, 1);
  });

  it("disconnects a client that accumulates another event while blocked", () => {
    const response = new FakeResponse();
    response.acceptWrites = false;
    let closed = 0;
    const writer = new BoundedSseWriter(response, 1000, () => {
      closed += 1;
    });

    assert.equal(writer.write("first"), true);
    assert.equal(writer.write("second"), false);
    assert.equal(response.destroyed, true);
    assert.equal(closed, 1);
  });

  it("disconnects a client that never drains", async () => {
    const response = new FakeResponse();
    response.acceptWrites = false;
    let closed = 0;
    const writer = new BoundedSseWriter(response, 5, () => {
      closed += 1;
    });

    writer.write("blocked");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(response.destroyed, true);
    assert.equal(closed, 1);
  });
});

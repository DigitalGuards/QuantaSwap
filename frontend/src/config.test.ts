import { describe, expect, it } from "vitest";
import { parseConfiguredMirrors } from "./config";

describe("order book mirror configuration", () => {
  it("normalizes reviewed HTTP origins", () => {
    expect(
      parseConfiguredMirrors(
        JSON.stringify([
          { id: "operator-a", apiBase: "https://book.example/api/" },
          { id: "operator-b", apiBase: "http://127.0.0.1:8092/api" },
        ]),
      ),
    ).toEqual([
      { id: "operator-a", apiBase: "https://book.example/api" },
      { id: "operator-b", apiBase: "http://127.0.0.1:8092/api" },
    ]);
  });

  it("rejects duplicate ids and normalized API bases", () => {
    expect(() =>
      parseConfiguredMirrors(
        JSON.stringify([
          { id: "operator-a", apiBase: "https://book.example/api" },
          { id: "operator-a", apiBase: "https://other.example/api" },
        ]),
      ),
    ).toThrow(/duplicate ids/);
    expect(() =>
      parseConfiguredMirrors(
        JSON.stringify([
          { id: "operator-a", apiBase: "https://book.example:443/api/" },
          { id: "operator-b", apiBase: "https://book.example/api" },
        ]),
      ),
    ).toThrow(/duplicate API bases/);
  });

  it("caps fanout and requires an exact entry shape", () => {
    expect(() =>
      parseConfiguredMirrors(
        JSON.stringify(
          Array.from({ length: 16 }, (_value, index) => ({
            id: `operator-${index}`,
            apiBase: `https://book-${index}.example/api`,
          })),
        ),
      ),
    ).toThrow(/more than 15 entries/);
    expect(() =>
      parseConfiguredMirrors(
        JSON.stringify([
          {
            id: "operator-a",
            apiBase: "https://book.example/api",
            label: "duplicate",
          },
        ]),
      ),
    ).toThrow(/unexpected fields/);
  });
});

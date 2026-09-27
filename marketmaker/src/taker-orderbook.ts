// Taker-side order book client. It reuses the maker transport in
// orderbook.ts (bounded reads, media-type checks, error mapping) and adds
// the three taker routes: read the public book, propose a signed fill, and
// reveal the walk-away secret. Nothing returned here is trusted for fund
// movement: taker-proofs.ts authenticates every row.

import { OrderBookClient, record, exactKeys } from "./orderbook.js";
import type { SelectedFillIntentV1 } from "./policy.js";
import type { SignedFillIntentV1 } from "./protocol-signing.js";
import { computeFillIntentDigest } from "./protocol-signing.js";
import {
  parseBookOrderRow,
  parseSelectedIntent,
  sameSignedIntent,
  type BookOrderRow,
} from "./taker-proofs.js";

/** Rows a single book read may return before it is refused outright. */
const MAX_LISTED_ROWS = 200;

export interface ListedBook {
  rows: BookOrderRow[];
  /** Rows whose shape this client refuses to interpret. */
  skipped: number;
}

export type ReleaseReference =
  | { intentDigest: string }
  | { fillDigest: string };

export class TakerBookClient extends OrderBookClient {
  /** The open public book. A malformed row is skipped and counted. */
  async listOpen(): Promise<ListedBook> {
    const payload = await this.api<{ orders?: unknown }>("GET", "/orders");
    if (!Array.isArray(payload.orders)) {
      throw new Error("order book returned an invalid order list");
    }
    if (payload.orders.length > MAX_LISTED_ROWS) {
      throw new Error("order book returned too many orders");
    }
    const rows: BookOrderRow[] = [];
    let skipped = 0;
    const seen = new Set<string>();
    for (const raw of payload.orders) {
      let row: BookOrderRow;
      try {
        row = parseBookOrderRow(raw);
      } catch {
        skipped += 1;
        continue;
      }
      if (seen.has(row.id)) {
        throw new Error("order book returned duplicate order ids");
      }
      seen.add(row.id);
      rows.push(row);
    }
    return { rows, skipped };
  }

  async getRow(id: string): Promise<BookOrderRow> {
    const payload = await this.api<unknown>(
      "GET",
      `/orders/${encodeURIComponent(id)}`,
    );
    const response = record(payload, "order response");
    exactKeys(response, ["order"], "order response");
    const row = parseBookOrderRow(response["order"]);
    if (row.id !== id) {
      throw new Error("order book returned a different order id");
    }
    return row;
  }

  /**
   * Publish a signed proposal. The response must echo the exact proposal
   * and its digest; a book that altered either is refused, so a rewritten
   * proposal can never become the one a maker fills.
   */
  async submitIntent(
    id: string,
    signed: SignedFillIntentV1,
  ): Promise<SelectedFillIntentV1> {
    const payload = await this.api<unknown>(
      "POST",
      `/orders/${encodeURIComponent(id)}/intents`,
      signed,
    );
    const response = record(payload, "intent response");
    exactKeys(response, ["intent"], "intent response");
    const accepted = parseSelectedIntent(response["intent"], "intent response");
    if (
      accepted.intentDigest !== computeFillIntentDigest(signed.intent, signed.auth) ||
      !sameSignedIntent(accepted, signed)
    ) {
      throw new Error(
        "the order book did not preserve the signed FillIntentV2 request",
      );
    }
    return accepted;
  }

  /** Reveal the committed walk-away secret. Idempotent on the server. */
  async release(
    id: string,
    releaseSecret: string,
    reference: ReleaseReference,
  ): Promise<BookOrderRow> {
    const payload = await this.api<unknown>(
      "POST",
      `/orders/${encodeURIComponent(id)}/release`,
      { releaseSecret, ...reference },
    );
    const response = record(payload, "release response");
    exactKeys(response, ["order"], "release response");
    return parseBookOrderRow(response["order"]);
  }
}

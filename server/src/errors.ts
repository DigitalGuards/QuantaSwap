/** Error type carried through the HTTP layer: `status` becomes the
 *  response code and `message` the JSON error body. Lives in its own
 *  module so both the store and the asset registry can throw it without
 *  importing each other. */
export class ApiError extends Error {
  /**
   * True when this refusal was produced before any signature was verified.
   * The HTTP layer reports it in a response header, so a client or a load
   * harness can tell a cheap refusal from one that paid full verification
   * without parsing the message text.
   */
  shedBeforeVerification = false;

  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: "federation_dependency" | "transient_capacity",
  ) {
    super(message);
  }

  /** Marks this refusal as answered before verification. */
  shed(): this {
    this.shedBeforeVerification = true;
    return this;
  }
}

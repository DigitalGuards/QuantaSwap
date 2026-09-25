/** Error type carried through the HTTP layer: `status` becomes the
 *  response code and `message` the JSON error body. Lives in its own
 *  module so both the store and the asset registry can throw it without
 *  importing each other. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: "federation_dependency" | "transient_capacity",
  ) {
    super(message);
  }
}

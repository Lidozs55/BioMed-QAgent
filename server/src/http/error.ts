/**
 * Shared HTTP error type for the application host's native API surface.
 * Every handler maps internal failures to this shape (status + message);
 * route dispatchers translate it into ``{"detail": message}`` responses.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}
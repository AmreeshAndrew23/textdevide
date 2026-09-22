import type { FastifyRequest } from "fastify";

// Real, best-effort request cancellation: when the client disconnects (a "Stop" button closing
// the connection, a tab close, etc.), this signal fires — threaded into the OpenAI fetch() call
// so an abandoned generation actually stops running upstream instead of finishing on a connection
// nobody is listening on anymore. Guarded so a NORMAL close (after the response was already sent)
// never fires it — only checked by callers before/while still awaiting an in-flight step.
export function requestAbortSignal(req: FastifyRequest): AbortSignal {
  const controller = new AbortController();
  // Fires when the underlying connection closes, whether that's the client disconnecting mid-
  // request (a genuine cancel) or a normal close after the response was already sent (a no-op —
  // nothing awaits the signal by then, so aborting late has no observable effect).
  req.raw.once("close", () => controller.abort());
  return controller.signal;
}

export class RequestAbortedError extends Error {
  constructor() {
    super("Request was cancelled");
  }
}

// Rejects with RequestAbortedError the moment `signal` aborts, otherwise resolves/rejects with
// `promise`'s own outcome — lets a caller stop awaiting a step it can't itself cancel (e.g. an
// in-flight Neo4j driver call) as soon as the client disconnects, without leaving the HTTP
// response hanging until that step would have finished on its own.
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new RequestAbortedError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new RequestAbortedError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e) => { signal.removeEventListener("abort", onAbort); reject(e); }
    );
  });
}

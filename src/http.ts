import type { Request, Response, NextFunction, RequestHandler } from "express";
import { reportError } from "./logger.js";
import { config } from "./config.js";

// Express 4 does not catch a rejected promise from an async handler. Without
// this wrapper the rejection is unhandled, and Node's default since v15 is to
// terminate the process - so one Prisma timeout in one canvas request took the
// whole server down. Every async handler goes through this.
//
// Express 5 forwards rejections on its own, which would make this unnecessary;
// it is not worth absorbing that upgrade's breaking changes in the same pass as
// everything else here.
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

// Mounted last, after every route. Express's own default handler writes the
// stack trace into the response body whenever NODE_ENV is not "production",
// which is exactly the misconfiguration this codebase is most exposed to - so
// the body here never depends on the environment.
export function errorMiddleware(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  reportError(error, { requestId: req.id, method: req.method, url: req.url });

  if (res.headersSent) {
    // A failure partway through a response body. Nothing useful left to say;
    // destroying the socket at least stops a truncated payload being read as
    // complete.
    res.destroy();
    return;
  }

  res.status(500).json({ error: "Something went wrong." });
}

// 404 for unmatched API paths. Without it an unknown /api route falls through
// to express.static and then to Express's HTML 404 page, which a fetch() caller
// tries to parse as JSON.
export function notFoundJson(_req: Request, res: Response): void {
  res.status(404).json({ error: "Not found" });
}

// Last line of defence. Something got past every catch - log it, report it, and
// exit non-zero so the platform restarts a clean process rather than leaving a
// half-initialised one answering health checks.
export function installProcessHandlers(shutdown: (code: number) => void): void {
  process.on("unhandledRejection", (reason) => {
    reportError(reason, { fatal: true, source: "unhandledRejection" });
    shutdown(1);
  });

  process.on("uncaughtException", (error) => {
    reportError(error, { fatal: true, source: "uncaughtException" });
    shutdown(1);
  });

  if (!config.isProduction) {
    // Locally, an exit on every stray rejection makes debugging worse than the
    // bug. The handlers above still log and report; they just do not kill the
    // dev server mid-edit.
    process.removeAllListeners("unhandledRejection");
    process.on("unhandledRejection", (reason) => {
      reportError(reason, { source: "unhandledRejection" });
    });
  }
}

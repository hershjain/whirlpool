import type { Request, Response, NextFunction, RequestHandler } from "express";
import { config } from "./config.js";
import { sessionFromToken } from "./auth.js";

export const SESSION_COOKIE = "wp_session";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      // Set by requireSession. Present on every /api handler and nowhere else.
      phone?: string;
    }
  }
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true, // script on the page can never read it, so XSS cannot exfiltrate it
    secure: config.isProduction, // false locally, where there is no https
    // Lax, not None: the cookie is not sent on cross-site POSTs, which is
    // most of CSRF defence for this app. Not Strict, because the login page
    // links out to the canvas and Strict would drop the cookie on that first
    // top-level navigation and bounce the user straight back to /login.
    sameSite: "lax",
    path: "/",
    // No maxAge and no expires, deliberately: that makes this a session
    // cookie, which the browser drops when it quits. Whatever the browser
    // chooses to preserve, the row itself expires after SESSION_TTL_MS, so
    // nothing here is the only thing standing between a closed laptop and
    // somebody's saved reading.
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

export function tokenFrom(req: Request): string | undefined {
  return req.cookies?.[SESSION_COOKIE] as string | undefined;
}

// 401s rather than redirecting: every caller is fetch() from canvas.js, which
// turns a 401 into the redirect itself. An HTML redirect here would show up
// as a successful response containing a login page, which is worse to debug.
export const requireSession: RequestHandler = async (req, res, next) => {
  const session = await sessionFromToken(tokenFrom(req));
  if (!session) {
    res.status(401).json({ error: "Not signed in" });
    return;
  }
  req.phone = session.phone;
  next();
};

// Defence in depth behind SameSite=Lax, which already blocks the cookie on a
// cross-site POST. Belt and braces because the cost is four lines and the
// failure mode is somebody's saved items being deleted by a page they visited.
//
// Sec-Fetch-Site is the reliable signal in current browsers; Origin is the
// fallback for anything that does not send it. A request with neither is a
// non-browser client (curl, a health check), which carries no ambient cookie
// and so cannot be the confused deputy this guards against.
export function rejectCrossSite(req: Request, res: Response, next: NextFunction): void {
  const fetchSite = req.header("Sec-Fetch-Site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    res.status(403).json({ error: "Cross-site request refused" });
    return;
  }

  const origin = req.header("Origin");
  if (origin && origin !== config.publicBaseUrl && origin !== `http://localhost:${config.port}`) {
    res.status(403).json({ error: "Cross-site request refused" });
    return;
  }

  next();
}

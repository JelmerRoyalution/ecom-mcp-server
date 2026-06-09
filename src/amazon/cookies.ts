import type { Either } from "functype"
import { Left, Right } from "functype"

import { buildCookieHeader, parseCookieString } from "../facebook/cookies"
import type { AmazonSession } from "./types"

/** Amazon cookies that indicate a usable (ideally logged-in) session for deeper review pages. */
const SESSION_COOKIE_NAMES = ["session-id", "at-main", "x-main", "sess-at-main", "ubid-main"]

/**
 * Build a validated {@link AmazonSession} from a raw Cookie header. Amazon shows only a handful
 * of "featured" reviews to logged-out visitors; replaying a logged-in session's cookies lets the
 * scraper page deeper. Validation is lenient: any cookie header carrying a recognizable Amazon
 * session cookie is accepted (the exact set varies by marketplace).
 */
export function buildAmazonSessionFromCookie(raw: string): Either<Error, AmazonSession> {
  const cookies = parseCookieString(raw)
  const names = Object.keys(cookies)
  const hasSessionCookie = SESSION_COOKIE_NAMES.some((name) => names.includes(name))

  if (names.length === 0) {
    return Left(
      new Error(
        "Invalid Amazon cookie: no cookies parsed. Paste the full Cookie header from a logged-in amazon.com " +
          "browser tab (DevTools → Application → Cookies, or the Network request 'cookie' header).",
      ),
    )
  }
  if (!hasSessionCookie) {
    return Left(
      new Error(
        `Invalid Amazon session: none of the expected cookies (${SESSION_COOKIE_NAMES.join(", ")}) were found. ` +
          "Copy the full Cookie header from a logged-in amazon.com browser tab.",
      ),
    )
  }

  return Right({ cookieHeader: buildCookieHeader(cookies) })
}

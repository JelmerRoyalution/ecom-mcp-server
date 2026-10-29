import type { Either } from "functype"
import { Left, Right } from "functype"

import { buildCookieHeader, parseCookieString } from "../facebook/cookies"
import type { QuoraSession } from "./types"

/** Quora cookies that indicate a usable (ideally logged-in) session. */
const SESSION_COOKIE_NAMES = ["m-b", "m-s", "m-uid", "m-login", "m-css_v"]

/**
 * Build a {@link QuoraSession} from a raw Cookie header. Quora gates anything past a question's
 * first answers behind a login wall; replaying a logged-in session's cookies lets the scraper read
 * deeper. Validation is lenient: any non-empty `quora.com` cookie header is accepted (a session
 * smooths anti-bot defences but the question pages themselves are partly public), so we only reject
 * an empty/garbled header.
 */
export function buildQuoraSessionFromCookie(raw: string): Either<Error, QuoraSession> {
  const cookies = parseCookieString(raw)
  const names = Object.keys(cookies)

  if (names.length === 0) {
    return Left(
      new Error(
        "Invalid Quora cookie: no cookies parsed. Paste the full Cookie header from a logged-in quora.com browser " +
          "tab (DevTools → Application → Cookies, or the Network request 'cookie' header).",
      ),
    )
  }
  // Not a hard requirement, but warn-by-accepting: if none of the usual session cookies are present
  // the header may be stale, yet it can still help, so we keep it rather than reject.
  const hasSessionCookie = SESSION_COOKIE_NAMES.some((name) => names.includes(name))
  if (!hasSessionCookie && names.length < 2) {
    return Left(
      new Error(
        "Invalid Quora session: the cookie header looks incomplete. Copy the full Cookie header from a logged-in " +
          "quora.com browser tab.",
      ),
    )
  }

  return Right({ cookieHeader: buildCookieHeader(cookies) })
}

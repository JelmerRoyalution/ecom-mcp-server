import type { Either } from "functype"
import { Left, Right } from "functype"

import { buildCookieHeader, parseCookieString } from "../facebook/cookies"
import type { MetaAdsSession } from "./types"

/**
 * Build a {@link MetaAdsSession} from a raw Cookie header. The Ad Library is a PUBLIC transparency
 * tool, so a session is optional - it only smooths Meta's anti-bot defences. Validation is therefore
 * lenient: any non-empty `facebook.com` cookie header is accepted (unlike the Facebook module, which
 * hard-requires `c_user`+`xs` to reach private groups).
 */
export function buildMetaAdsSessionFromCookie(raw: string): Either<Error, MetaAdsSession> {
  const cookies = parseCookieString(raw)
  if (Object.keys(cookies).length === 0) {
    return Left(
      new Error(
        "Invalid Meta cookie: no cookies parsed. Paste the full Cookie header from a logged-in facebook.com browser " +
          "tab (DevTools → Application → Cookies, or the Network request 'cookie' header).",
      ),
    )
  }
  return Right({ cookieHeader: buildCookieHeader(cookies) })
}

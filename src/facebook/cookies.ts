import type { Either } from "functype"
import { Left, Right } from "functype"

import type { FacebookSession } from "./types"

/**
 * Parse a raw Cookie header (or a `cookies.txt`-style blob) into a key→value map.
 *
 * Accepts the common shapes users actually paste:
 *  - a browser "Cookie" request header: `c_user=123; xs=abc; datr=xyz`
 *  - newline-separated `key=value` pairs
 * Values may themselves contain `=` (e.g. base64 padding in `xs`), so only the
 * first `=` is treated as the separator.
 */
export function parseCookieString(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  const segments = raw
    .split(/[;\n\r]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  for (const segment of segments) {
    const eq = segment.indexOf("=")
    if (eq <= 0) {
      continue
    }
    const name = segment.slice(0, eq).trim()
    const value = segment.slice(eq + 1).trim()
    if (name.length > 0) {
      out[name] = value
    }
  }
  return out
}

/** Re-serialize a cookie map into a canonical `key=value; key=value` header. */
export function buildCookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ")
}

/**
 * Build a validated {@link FacebookSession} from cookie input.
 *
 * A session is only usable for authenticated reads (and the only way to reach
 * private groups) when both `c_user` and `xs` are present.
 */
export function buildSessionFromCookies(raw: string): Either<Error, FacebookSession> {
  const cookies = parseCookieString(raw)
  const { c_user: cUser, xs } = cookies

  if (cUser === undefined || cUser === "" || xs === undefined || xs === "") {
    return Left(
      new Error(
        "Invalid Facebook session: both 'c_user' and 'xs' cookies are required. " +
          "Copy the full Cookie header from a logged-in facebook.com browser tab " +
          "(DevTools → Application → Cookies, or the Network request 'cookie' header).",
      ),
    )
  }

  return Right({
    cookieHeader: buildCookieHeader(cookies),
    cUser,
    xs,
    datr: cookies["datr"],
  })
}

/**
 * Assemble a session from discrete env values (`FACEBOOK_C_USER` / `FACEBOOK_XS` /
 * `FACEBOOK_DATR`) as an alternative to pasting a whole Cookie header.
 */
export function buildSessionFromParts(parts: {
  readonly cUser?: string
  readonly xs?: string
  readonly datr?: string
}): Either<Error, FacebookSession> {
  if (parts.cUser === undefined || parts.cUser === "" || parts.xs === undefined || parts.xs === "") {
    return Left(new Error("Invalid Facebook session: FACEBOOK_C_USER and FACEBOOK_XS are both required."))
  }

  const cookies: Record<string, string> = {
    c_user: parts.cUser,
    xs: parts.xs,
    ...(parts.datr !== undefined && parts.datr !== "" ? { datr: parts.datr } : {}),
  }

  return Right({
    cookieHeader: buildCookieHeader(cookies),
    cUser: parts.cUser,
    xs: parts.xs,
    datr: parts.datr,
  })
}

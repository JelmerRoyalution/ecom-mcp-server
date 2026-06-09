/* eslint-disable functype/prefer-option --
 * Token harvesting for the (best-effort) HTTP engine. It scrapes the CSRF/spin tokens and the
 * volatile `doc_id` out of the Ad Library page's inline scripts, then assembles the GraphQL form
 * body the internal `/api/graphql/` endpoint expects. This is inherently regex/string work over
 * untyped HTML; the browser engine sidesteps it entirely by intercepting the response.
 */
import { randomUUID } from "node:crypto"

import type { MetaAdSearchParams } from "./types"

/** Tokens scraped from an Ad Library HTML page, needed to replay the GraphQL request. */
export type AdLibraryTokens = {
  readonly lsd?: string
  readonly fbDtsg?: string
  readonly jazoest?: string
  readonly rev?: string
  readonly hs?: string
  readonly spinT?: string
  readonly spinB?: string
  readonly spinR?: string
  readonly user?: string
  /** The volatile document id for the search query - absent on some renders. */
  readonly docId?: string
}

const MEDIA_ENUM: Readonly<Record<string, string>> = {
  all: "ALL",
  image: "IMAGE",
  video: "VIDEO",
  meme: "MEME",
  none: "NONE",
}
const ACTIVE_ENUM: Readonly<Record<string, string>> = { all: "ALL", active: "ACTIVE", inactive: "INACTIVE" }
const SEARCH_ENUM: Readonly<Record<string, string>> = {
  keyword_unordered: "KEYWORD_UNORDERED",
  keyword_exact_phrase: "KEYWORD_EXACT_PHRASE",
  page: "PAGE",
}

function firstMatch(html: string, re: RegExp): string | undefined {
  const m = html.match(re)
  return m !== null ? m[1] : undefined
}

/** Facebook's `jazoest` checksum: "2" followed by the sum of `fb_dtsg`'s char codes. */
export function computeJazoest(fbDtsg: string): string {
  const sum = [...fbDtsg].reduce((acc, ch) => acc + ch.charCodeAt(0), 0)
  return `2${sum}`
}

/** Scrape CSRF/spin tokens + the search `doc_id` from an Ad Library HTML page (best-effort). */
export function harvestTokens(html: string): AdLibraryTokens {
  const lsd = firstMatch(html, /"LSD",\[\],\{"token":"([^"]+)"/) ?? firstMatch(html, /name="lsd"\s+value="([^"]+)"/)
  const fbDtsg =
    firstMatch(html, /"DTSGInitialData",\[\],\{"token":"([^"]+)"/) ??
    firstMatch(html, /name="fb_dtsg"\s+value="([^"]+)"/)
  const rev = firstMatch(html, /"client_revision":(\d+)/) ?? firstMatch(html, /"__spin_r":(\d+)/)
  const hs = firstMatch(html, /"haste_session":"([^"]+)"/)
  const spinT = firstMatch(html, /"__spin_t":(\d+)/)
  const spinB = firstMatch(html, /"__spin_b":"([^"]+)"/)
  const spinR = firstMatch(html, /"__spin_r":(\d+)/)
  const user = firstMatch(html, /"USER_ID":"(\d+)"/) ?? firstMatch(html, /"actorID":"(\d+)"/) ?? "0"
  const docId =
    firstMatch(html, /"AdLibrarySearchPaginationQuery"[\s\S]{0,2000}?"doc_id":"(\d+)"/) ??
    firstMatch(html, /"doc_id":"(\d+)"[\s\S]{0,2000}?"AdLibrarySearchPaginationQuery"/)

  return {
    lsd,
    fbDtsg,
    jazoest: fbDtsg !== undefined ? computeJazoest(fbDtsg) : undefined,
    rev,
    hs,
    spinT,
    spinB,
    spinR,
    user,
    docId,
  }
}

/** A per-search session id reused across paginated requests. */
export function buildSessionId(): string {
  return randomUUID()
}

/** Build the GraphQL `variables` object matching the live Ad Library search request. */
export function buildVariables(
  params: MetaAdSearchParams,
  opts: { readonly cursor?: string; readonly first: number; readonly sessionId: string },
): Record<string, unknown> {
  const countries = params.country.toUpperCase() === "ALL" ? ["ALL"] : [params.country]
  return {
    activeStatus: ACTIVE_ENUM[params.activeStatus] ?? "ALL",
    adType: "ALL",
    bylines: [],
    collationToken: null,
    contentLanguages: [],
    countries,
    country: params.country,
    cursor: opts.cursor ?? null,
    excludedIDs: [],
    fetchPageInfo: true,
    fetchSharedDisclaimers: true,
    first: opts.first,
    location: null,
    mediaType: MEDIA_ENUM[params.mediaType] ?? "ALL",
    multiCountryFilterMode: null,
    pageIDs: [],
    potentialReachInput: [],
    publisherPlatforms: params.platform !== undefined ? [params.platform.toUpperCase()] : [],
    queryString: params.q ?? "",
    regions: [],
    searchType: SEARCH_ENUM[params.searchType] ?? "KEYWORD_UNORDERED",
    sessionID: opts.sessionId,
    sortData: null,
    source: null,
    startDate: null,
    v: "",
    viewAllPageID: params.viewAllPageId ?? "0",
  }
}

/** Assemble the `application/x-www-form-urlencoded` body for a `/api/graphql/` POST. */
export function buildGraphqlBody(args: {
  readonly tokens: AdLibraryTokens
  readonly variables: Record<string, unknown>
  readonly docId: string
  readonly friendlyName: string
}): string {
  const t = args.tokens
  const form = new URLSearchParams()
  form.set("av", t.user ?? "0")
  form.set("__user", t.user ?? "0")
  form.set("__a", "1")
  form.set("dpr", "1")
  if (t.rev !== undefined) form.set("__rev", t.rev)
  if (t.hs !== undefined) form.set("__hs", t.hs)
  if (t.spinR !== undefined) form.set("__spin_r", t.spinR)
  if (t.spinB !== undefined) form.set("__spin_b", t.spinB)
  if (t.spinT !== undefined) form.set("__spin_t", t.spinT)
  if (t.lsd !== undefined) form.set("lsd", t.lsd)
  if (t.fbDtsg !== undefined) form.set("fb_dtsg", t.fbDtsg)
  if (t.jazoest !== undefined) form.set("jazoest", t.jazoest)
  form.set("fb_api_caller_class", "RelayModern")
  form.set("fb_api_req_friendly_name", args.friendlyName)
  form.set("variables", JSON.stringify(args.variables))
  form.set("server_timestamps", "true")
  form.set("doc_id", args.docId)
  return form.toString()
}

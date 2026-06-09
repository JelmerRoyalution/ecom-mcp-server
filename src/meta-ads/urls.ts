import type { MetaAdSearchParams } from "./types"

/** Canonical public Ad Library base URL. */
export const AD_LIBRARY_BASE = "https://www.facebook.com/ads/library/"

const ACTIVE_STATUS_MAP: Readonly<Record<string, string>> = {
  all: "all",
  active: "active",
  inactive: "inactive",
}

const MEDIA_TYPE_MAP: Readonly<Record<string, string>> = {
  all: "all",
  image: "image",
  video: "video",
  meme: "meme",
  none: "none",
}

/** Read a single query-string parameter from a pasted URL (returns undefined when absent). */
function queryParam(input: string, key: string): string | undefined {
  const qIndex = input.indexOf("?")
  if (qIndex < 0) {
    return undefined
  }
  const value = new URLSearchParams(input.slice(qIndex + 1)).get(key)
  return value === null || value === "" ? undefined : value
}

/**
 * Build the canonical Ad Library web URL the browser engine navigates (Meta's own JS then issues
 * the GraphQL request + tokens). Mirrors the parameters the live site uses.
 */
export function buildAdLibraryUrl(params: MetaAdSearchParams): string {
  const qp = new URLSearchParams()
  qp.set("active_status", ACTIVE_STATUS_MAP[params.activeStatus] ?? "active")
  qp.set("ad_type", "all")
  qp.set("country", params.country)
  qp.set("is_targeted_country", "false")
  qp.set("media_type", MEDIA_TYPE_MAP[params.mediaType] ?? "all")
  qp.set("search_type", params.searchType)
  if (params.q !== undefined && params.q.trim() !== "") {
    qp.set("q", params.q.trim())
  }
  if (params.viewAllPageId !== undefined && params.viewAllPageId !== "") {
    qp.set("view_all_page_id", params.viewAllPageId)
  }
  if (params.platform !== undefined) {
    qp.set("publisher_platforms[0]", params.platform)
  }
  return `${AD_LIBRARY_BASE}?${qp.toString()}`
}

/** Deep link to a single ad by its archive id. */
export function adSnapshotUrl(adArchiveId: string): string {
  return `${AD_LIBRARY_BASE}?id=${encodeURIComponent(adArchiveId)}`
}

/** Link to all of one advertiser's ads (used in `MetaAdBrand.snapshotUrl`). */
export function advertiserUrl(pageId: string, country: string): string {
  return buildAdLibraryUrl({
    viewAllPageId: pageId,
    country,
    activeStatus: "all",
    mediaType: "all",
    searchType: "page",
  })
}

/** How an advertiser reference resolves: a specific page, or a keyword/name to search. */
export type AdvertiserRef =
  | { readonly kind: "page"; readonly pageId: string }
  | { readonly kind: "keyword"; readonly q: string }

/**
 * Interpret an advertiser argument. A numeric id or a `view_all_page_id=` URL targets one page
 * (`search_type=page`); a `q=` URL, a domain, or a name falls back to a keyword search.
 */
export function parseAdvertiserRef(input: string): AdvertiserRef {
  const trimmed = input.trim()

  const pageIdFromUrl = queryParam(trimmed, "view_all_page_id")
  if (pageIdFromUrl !== undefined && /^\d+$/.test(pageIdFromUrl)) {
    return { kind: "page", pageId: pageIdFromUrl }
  }

  const qFromUrl = queryParam(trimmed, "q")
  if (qFromUrl !== undefined) {
    return { kind: "keyword", q: qFromUrl }
  }

  if (/^\d{5,}$/.test(trimmed)) {
    return { kind: "page", pageId: trimmed }
  }

  return { kind: "keyword", q: trimmed }
}

/** Extract an ad archive id from a bare id or an Ad Library `?id=` URL. */
export function extractAdArchiveId(input: string): string | undefined {
  const trimmed = input.trim()
  if (/^\d{5,}$/.test(trimmed)) {
    return trimmed
  }
  const id = queryParam(trimmed, "id")
  return id !== undefined && /^\d+$/.test(id) ? id : undefined
}

/** Heuristic: does this query look like a bare domain (the most effective brand-discovery query)? */
export function looksLikeDomain(q: string): boolean {
  const trimmed = q.trim()
  return !trimmed.includes(" ") && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(trimmed)
}

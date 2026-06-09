/* eslint-disable @typescript-eslint/no-explicit-any, functype/no-let, functype/no-imperative-loops, functype/prefer-option, functype/prefer-fold --
 * The single source of truth that turns Meta's internal Ad Library GraphQL JSON into our domain
 * types. The provider JSON is deeply nested, untyped and drifts between deploys, so defensive
 * `any` access with many fallbacks (mirroring amazon/api-engine.ts) plus imperative tree-walking
 * is the pragmatic shape here. The MetaAdsClient re-wraps results into Either at the boundary.
 */
import type {
  MetaAd,
  MetaAdActiveStatus,
  MetaAdBrand,
  MetaAdCreative,
  MetaAdMediaType,
  MetaAdPlatform,
  MetaAdSort,
} from "./types"
import { adSnapshotUrl, advertiserUrl } from "./urls"

// ──────────────────────────── defensive value helpers ────────────────────────────

function str(value: unknown): string {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return ""
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const n = parseFloat(value.replace(/,/g, ""))
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

function arr(value: unknown): any[] {
  return Array.isArray(value) ? value : []
}

function isNonEmpty(s: string): boolean {
  return s.length > 0
}

function uniq(xs: readonly string[]): string[] {
  return Array.from(new Set(xs))
}

/** Strip DCO placeholders like `{{product.name}}` and empty strings down to `undefined`. */
function cleanTemplate(value: string): string | undefined {
  if (value === "" || /\{\{.*?\}\}/.test(value)) return undefined
  return value
}

function epochToIsoDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10)
}

function daysSinceEpoch(epochSeconds: number): number {
  return Math.max(0, Math.floor((Date.now() - epochSeconds * 1000) / 86_400_000))
}

function pickImage(o: any): string {
  return str(o?.original_image_url) || str(o?.resized_image_url)
}

function pickVideo(o: any): string {
  return str(o?.video_hd_url) || str(o?.video_sd_url)
}

// ──────────────────────────── creative normalization ────────────────────────────

/** Build a creative from a snapshot OR a card (cards carry media URLs flat on the object). */
function normalizeCreative(o: any): MetaAdCreative {
  const images = arr(o?.images)
  const videos = arr(o?.videos)
  const imageUrls = uniq([...images.map(pickImage), pickImage(o)].filter(isNonEmpty))
  const videoUrls = uniq([...videos.map(pickVideo), pickVideo(o)].filter(isNonEmpty))
  const bodyText = o?.body !== undefined && typeof o.body === "object" ? str(o.body?.text) : str(o?.body)
  const preview = str(o?.video_preview_image_url) || str(videos[0]?.video_preview_image_url)

  return {
    body: cleanTemplate(bodyText),
    title: cleanTemplate(str(o?.title)),
    caption: str(o?.caption) || undefined,
    linkDescription: cleanTemplate(str(o?.link_description)),
    ctaText: str(o?.cta_text) || undefined,
    ctaType: str(o?.cta_type) || undefined,
    linkUrl: str(o?.link_url) || undefined,
    imageUrls,
    videoUrls,
    videoPreviewImageUrl: preview || undefined,
  }
}

function hasContent(c: MetaAdCreative): boolean {
  return c.body !== undefined || c.title !== undefined || c.imageUrls.length > 0 || c.videoUrls.length > 0
}

/**
 * Resolve the ad's primary creative. For DCO/DPA/CAROUSEL the top-level body/title are often
 * `{{…}}` templates with the real creatives in `cards[]`, so fall back to the first rich card.
 */
function resolveCreative(snapshot: any): { creative: MetaAdCreative; cards?: readonly MetaAdCreative[] } {
  const top = normalizeCreative(snapshot)
  const cards = arr(snapshot?.cards).map(normalizeCreative)

  if (!hasContent(top) && cards.length > 0) {
    const rich = cards.find(hasContent) ?? cards[0]
    const merged: MetaAdCreative = {
      body: rich.body ?? top.body,
      title: rich.title ?? top.title,
      caption: top.caption ?? rich.caption,
      linkDescription: rich.linkDescription ?? top.linkDescription,
      ctaText: rich.ctaText ?? top.ctaText,
      ctaType: rich.ctaType ?? top.ctaType,
      linkUrl: rich.linkUrl ?? top.linkUrl,
      imageUrls: rich.imageUrls.length > 0 ? rich.imageUrls : top.imageUrls,
      videoUrls: rich.videoUrls.length > 0 ? rich.videoUrls : top.videoUrls,
      videoPreviewImageUrl: rich.videoPreviewImageUrl ?? top.videoPreviewImageUrl,
    }
    return { creative: merged, cards }
  }

  return { creative: top, cards: cards.length > 0 ? cards : undefined }
}

/**
 * Normalize one `collated_results[]` node (or a paid-provider record in the same Meta `snapshot`
 * shape) into a {@link MetaAd}; returns undefined when unusable.
 */
export function normalizeAdNode(node: any): MetaAd | undefined {
  const adArchiveId = str(node?.ad_archive_id) || str(node?.ad_id)
  if (adArchiveId === "") return undefined

  const snapshot = node?.snapshot ?? {}
  const { creative, cards } = resolveCreative(snapshot)
  const startEpoch = num(node?.start_date)
  const endEpoch = num(node?.end_date)
  const spend =
    node?.spend !== undefined && node?.spend !== null && typeof node.spend === "object" ? node.spend : undefined
  const cats = arr(snapshot?.page_categories).map(str).filter(isNonEmpty)
  const impr = node?.impressions_with_index
  const impressionsText =
    impr !== undefined && impr !== null && typeof impr === "object" ? str(impr.impressions_text) : ""

  return {
    adArchiveId,
    pageId: str(node?.page_id) || str(snapshot?.page_id),
    pageName: str(node?.page_name) || str(snapshot?.page_name) || "Unknown advertiser",
    pageProfileUri: str(snapshot?.page_profile_uri) || undefined,
    pageLikeCount: num(snapshot?.page_like_count),
    pageCategories: cats.length > 0 ? cats : undefined,
    isActive: Boolean(node?.is_active),
    startDate: startEpoch !== undefined ? epochToIsoDate(startEpoch) : undefined,
    endDate: endEpoch !== undefined ? epochToIsoDate(endEpoch) : undefined,
    daysRunning: startEpoch !== undefined ? daysSinceEpoch(startEpoch) : undefined,
    displayFormat: str(snapshot?.display_format) || undefined,
    publisherPlatforms: arr(node?.publisher_platform).map(str).filter(isNonEmpty),
    collationCount: num(node?.collation_count),
    creative,
    cards,
    snapshotUrl: adSnapshotUrl(adArchiveId),
    currency: str(node?.currency) || undefined,
    spendLowerBound: spend !== undefined ? num(spend.lower_bound) : undefined,
    spendUpperBound: spend !== undefined ? num(spend.upper_bound) : undefined,
    impressionsText: impressionsText !== "" ? impressionsText : undefined,
  }
}

// ──────────────────────────── page / connection walking ────────────────────────────

/**
 * Defensively locate the `search_results_connection` inside a GraphQL response. The pagination
 * query nests it under `data.ad_library_main`, but the first-page query nests it differently, so
 * we walk the tree for either the named connection or any `{ edges, page_info }` shape.
 */
function findConnection(root: unknown): any | undefined {
  const stack: any[] = [root]
  const seen = new Set<any>()
  while (stack.length > 0) {
    const cur = stack.pop()
    if (cur === null || cur === undefined || typeof cur !== "object" || seen.has(cur)) continue
    seen.add(cur)
    if (cur.search_results_connection !== undefined && typeof cur.search_results_connection === "object") {
      return cur.search_results_connection
    }
    if (Array.isArray(cur.edges) && cur.page_info !== undefined) {
      return cur
    }
    for (const key of Object.keys(cur)) {
      const value = cur[key]
      if (value !== null && typeof value === "object") stack.push(value)
    }
  }
  return undefined
}

/** Parse a single raw GraphQL page into ads + the pagination cursor. */
export function parseAdsPage(page: unknown): { ads: MetaAd[]; endCursor?: string; hasNextPage: boolean } {
  const conn = findConnection(page)
  if (conn === undefined) {
    return { ads: [], hasNextPage: false }
  }
  const ads: MetaAd[] = []
  for (const edge of arr(conn.edges)) {
    const node = edge?.node
    if (node === undefined || node === null) continue
    const collated = arr(node.collated_results)
    const sources = collated.length > 0 ? collated : [node]
    for (const source of sources) {
      const ad = normalizeAdNode(source)
      if (ad !== undefined) ads.push(ad)
    }
  }
  const pageInfo = conn.page_info ?? {}
  return {
    ads,
    endCursor: str(pageInfo.end_cursor) || undefined,
    hasNextPage: Boolean(pageInfo.has_next_page),
  }
}

/** Parse and flatten many raw pages into a de-duplicated ad list. */
export function parseAdsPages(pages: readonly unknown[]): { ads: MetaAd[]; hasMore: boolean } {
  const ads: MetaAd[] = []
  const seen = new Set<string>()
  let hasMore = false
  for (const page of pages) {
    const parsed = parseAdsPage(page)
    hasMore = parsed.hasNextPage
    for (const ad of parsed.ads) {
      if (!seen.has(ad.adArchiveId)) {
        seen.add(ad.adArchiveId)
        ads.push(ad)
      }
    }
  }
  return { ads, hasMore }
}

// ──────────────────────────── brand discovery + filtering ────────────────────────────

/** De-duplicate ads by advertiser page into brand cards, ranked by ad volume. */
export function aggregateBrands(ads: readonly MetaAd[], country: string): MetaAdBrand[] {
  const byPage = new Map<string, { ad: MetaAd; count: number }>()
  for (const ad of ads) {
    const key = ad.pageId !== "" ? ad.pageId : ad.pageName
    if (key === "") continue
    const existing = byPage.get(key)
    if (existing === undefined) {
      byPage.set(key, { ad, count: 1 })
    } else {
      existing.count += 1
    }
  }
  return Array.from(byPage.values())
    .map(({ ad, count }) => ({
      pageId: ad.pageId,
      pageName: ad.pageName,
      pageProfileUri: ad.pageProfileUri,
      pageLikeCount: ad.pageLikeCount,
      pageCategories: ad.pageCategories,
      adCountSeen: count,
      sampleAdCopy: ad.creative.body ?? ad.creative.title,
      snapshotUrl: ad.pageId !== "" ? advertiserUrl(ad.pageId, country) : ad.snapshotUrl,
    }))
    .sort((a, b) => b.adCountSeen - a.adCountSeen)
}

/** Client-side safety net for the media/active/platform filters (also applied server-side). */
export function filterAds(
  ads: readonly MetaAd[],
  opts: {
    readonly mediaType: MetaAdMediaType
    readonly activeStatus: MetaAdActiveStatus
    readonly platform?: MetaAdPlatform
  },
): MetaAd[] {
  return ads.filter((ad) => {
    if (opts.activeStatus === "active" && !ad.isActive) return false
    if (opts.activeStatus === "inactive" && ad.isActive) return false
    if (opts.mediaType === "image" && ad.creative.imageUrls.length === 0) return false
    if (opts.mediaType === "video" && ad.creative.videoUrls.length === 0) return false
    if (opts.platform !== undefined && !ad.publisherPlatforms.map((p) => p.toLowerCase()).includes(opts.platform))
      return false
    return true
  })
}

/** Order ads. `longest_running` surfaces the likely winners first. */
export function sortAds(ads: readonly MetaAd[], sort: MetaAdSort): MetaAd[] {
  const copy = [...ads]
  if (sort === "longest_running") {
    return copy.sort((a, b) => (b.daysRunning ?? -1) - (a.daysRunning ?? -1))
  }
  if (sort === "newest") {
    const ms = (ad: MetaAd) => (ad.startDate !== undefined ? Date.parse(ad.startDate) : 0)
    return copy.sort((a, b) => ms(b) - ms(a))
  }
  return copy
}

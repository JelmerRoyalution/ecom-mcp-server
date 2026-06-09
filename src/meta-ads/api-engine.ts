/* eslint-disable @typescript-eslint/no-explicit-any, functype/no-let, functype/no-imperative-loops, functype/prefer-either --
 * External-IO boundary for the optional paid Ad Library API engine. It calls a third-party provider
 * over fetch and normalizes their JSON into our domain types. Providers (e.g. ScrapeCreators) return
 * Meta's own `snapshot` shape, so we reuse the parser's node normalizer, with a flat fallback for
 * providers that flatten the fields. The MetaAdsClient wraps results into Either at its boundary.
 */
import { normalizeAdNode } from "./parsers"
import type { MetaAd, MetaAdsApiProvider, MetaAdSearchParams } from "./types"

function str(value: unknown): string {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return ""
}

/** Map a provider record that FLATTENS the fields into Meta's nested `snapshot` node shape. */
function toNode(raw: any): any {
  if (raw?.snapshot !== undefined) return raw
  return {
    ad_archive_id: raw?.ad_archive_id ?? raw?.adArchiveID ?? raw?.adArchiveId ?? raw?.id,
    page_id: raw?.page_id ?? raw?.pageId,
    page_name: raw?.page_name ?? raw?.pageName ?? raw?.advertiser,
    is_active: raw?.is_active ?? raw?.isActive ?? raw?.active,
    start_date: raw?.start_date ?? raw?.startDate ?? raw?.start_date_unix,
    end_date: raw?.end_date ?? raw?.endDate,
    collation_count: raw?.collation_count ?? raw?.collationCount,
    publisher_platform: raw?.publisher_platform ?? raw?.publisherPlatforms ?? raw?.platforms,
    snapshot: {
      display_format: raw?.display_format ?? raw?.displayFormat,
      caption: raw?.caption ?? raw?.display_url,
      body: { text: raw?.body ?? raw?.ad_creative_body ?? raw?.text ?? raw?.bodyText },
      title: raw?.title ?? raw?.headline,
      link_url: raw?.link_url ?? raw?.linkUrl ?? raw?.url,
      link_description: raw?.link_description ?? raw?.linkDescription,
      cta_text: raw?.cta_text ?? raw?.ctaText,
      cta_type: raw?.cta_type ?? raw?.ctaType,
      page_like_count: raw?.page_like_count ?? raw?.pageLikeCount,
      images: raw?.images ?? (raw?.image_url !== undefined ? [{ original_image_url: raw.image_url }] : []),
      videos: raw?.videos ?? (raw?.video_url !== undefined ? [{ video_hd_url: raw.video_url }] : []),
      cards: raw?.cards ?? [],
    },
  }
}

function normalize(raw: any): MetaAd | undefined {
  return normalizeAdNode(raw) ?? normalizeAdNode(toNode(raw))
}

/** Call ScrapeCreators' Facebook Ad Library API (https://scrapecreators.com). */
async function fetchScrapeCreators(opts: {
  apiKey: string
  params: MetaAdSearchParams
  maxPages: number
}): Promise<MetaAd[]> {
  const base = "https://api.scrapecreators.com/v1/facebook/adLibrary"
  const endpoint = opts.params.viewAllPageId !== undefined ? `${base}/company/ads` : `${base}/search/ads`
  const ads: MetaAd[] = []
  const seen = new Set<string>()
  let cursor: string | undefined = undefined

  for (let page = 0; page < opts.maxPages; page++) {
    const qp = new URLSearchParams()
    if (opts.params.viewAllPageId !== undefined) qp.set("pageId", opts.params.viewAllPageId)
    else qp.set("query", opts.params.q ?? "")
    qp.set("country", opts.params.country)
    qp.set("trim", "false")
    if (cursor !== undefined) qp.set("cursor", cursor)

    const response = await fetch(`${endpoint}?${qp.toString()}`, { headers: { "x-api-key": opts.apiKey } })
    if (!response.ok) {
      throw new Error(
        `ScrapeCreators API returned HTTP ${response.status}. Check META_ADS_API_KEY and your plan credits.`,
      )
    }
    const data: any = await response.json()
    const results: any[] = Array.isArray(data?.results)
      ? data.results
      : Array.isArray(data?.ads)
        ? data.ads
        : Array.isArray(data?.data)
          ? data.data
          : []
    for (const raw of results) {
      const ad = normalize(raw)
      if (ad !== undefined && !seen.has(ad.adArchiveId)) {
        seen.add(ad.adArchiveId)
        ads.push(ad)
      }
    }
    cursor = str(data?.cursor ?? data?.next_cursor ?? data?.nextCursor) || undefined
    if (cursor === undefined || results.length === 0) break
  }

  return ads
}

/** Fetch ads through the configured paid provider, normalized to our domain types. */
export async function fetchViaApi(opts: {
  provider: MetaAdsApiProvider
  apiKey: string
  params: MetaAdSearchParams
  maxPages: number
}): Promise<MetaAd[]> {
  return fetchScrapeCreators(opts)
}

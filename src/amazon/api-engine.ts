/* eslint-disable @typescript-eslint/no-explicit-any, functype/no-let, functype/no-imperative-loops, functype/prefer-either --
 * External-IO boundary for the optional paid reviews-API engine. It calls a third-party
 * provider over fetch and normalizes their JSON into our domain types. Provider responses are
 * untyped JSON, so `any` access with defensive fallbacks is the pragmatic shape here. The
 * AmazonClient wraps results into Either at the method boundary.
 */
import type {
  AmazonApiProvider,
  AmazonProduct,
  AmazonProductWithReviews,
  AmazonReview,
  AmazonReviewSort,
} from "./types"

function str(value: unknown): string {
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value)
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const n = parseFloat(value.replace(/,/g, ""))
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

/** Normalize one provider review record into our {@link AmazonReview}. */
function normalizeReview(raw: any, index: number): AmazonReview {
  return {
    id: str(raw.id ?? raw.review_id ?? raw.reviewId) || `api_${index}`,
    author: str(raw.author ?? raw.name ?? raw.profile?.name ?? raw.reviewer ?? "Amazon Customer"),
    rating: num(raw.rating ?? raw.stars ?? raw.score),
    title: str(raw.title ?? raw.review_title ?? raw.heading),
    body: str(raw.body ?? raw.review_text ?? raw.text ?? raw.content ?? raw.review),
    date: str(raw.date?.raw ?? raw.date ?? raw.review_date ?? raw.reviewDate) || undefined,
    country: str(raw.country ?? raw.location ?? raw.date?.country) || undefined,
    verifiedPurchase: Boolean(raw.verified_purchase ?? raw.verified ?? raw.is_verified ?? raw.verifiedPurchase),
    helpfulVotes: num(raw.helpful_votes ?? raw.helpful ?? raw.found_helpful ?? raw.helpfulVotes),
    variant: str(raw.variant ?? raw.reviewed_variant ?? raw.format) || undefined,
    permalink: str(raw.url ?? raw.review_url ?? raw.link ?? raw.permalink) || undefined,
  }
}

/** Call Unwrangle's Amazon reviews API (https://docs.unwrangle.com/amazon-product-reviews-api/). */
async function fetchUnwrangle(opts: {
  apiKey: string
  asin: string
  marketplace: string
  sort: AmazonReviewSort
  maxPages: number
  cookieHeader?: string
}): Promise<AmazonProductWithReviews> {
  const countryCode = opts.marketplace === "com" ? "us" : opts.marketplace.replace(/\./g, "")
  const reviews: AmazonReview[] = []
  let product: AmazonProduct | undefined

  for (let page = 1; page <= opts.maxPages; page++) {
    const params = new URLSearchParams({
      platform: "amazon_reviews",
      asin: opts.asin,
      country_code: countryCode,
      page: String(page),
      sort_by: opts.sort === "helpful" ? "helpful" : "recent",
      api_key: opts.apiKey,
    })
    if (opts.cookieHeader !== undefined && opts.cookieHeader !== "") {
      params.set("cookie", opts.cookieHeader)
    }
    const response = await fetch(`https://data.unwrangle.com/api/getter/?${params.toString()}`)
    if (!response.ok) {
      throw new Error(`Unwrangle API returned HTTP ${response.status}. Check AMAZON_API_KEY and your plan credits.`)
    }
    const data: any = await response.json()
    if (data.success === false) {
      throw new Error(`Unwrangle API error: ${str(data.detail ?? data.message ?? "unknown error")}`)
    }
    product ??= {
      asin: opts.asin,
      title: str(data.product_name ?? data.name ?? opts.asin) || opts.asin,
      brand: str(data.brand) || undefined,
      url: `https://www.amazon.${opts.marketplace}/dp/${opts.asin}`,
      averageRating: num(data.rating ?? data.avg_rating),
      totalReviews: num(data.total_reviews ?? data.total_results),
    }
    const pageReviews: any[] = Array.isArray(data.reviews) ? data.reviews : []
    pageReviews.forEach((r, i) => reviews.push(normalizeReview(r, (page - 1) * 100 + i)))
    if (pageReviews.length === 0) {
      break
    }
  }

  return {
    product: product ?? {
      asin: opts.asin,
      title: opts.asin,
      url: `https://www.amazon.${opts.marketplace}/dp/${opts.asin}`,
    },
    reviews,
  }
}

/** Call Rainforest's Amazon reviews API (https://trajectdata.com/ecommerce/rainforest-api/). */
async function fetchRainforest(opts: {
  apiKey: string
  asin: string
  marketplace: string
  sort: AmazonReviewSort
  maxPages: number
}): Promise<AmazonProductWithReviews> {
  const reviews: AmazonReview[] = []
  let product: AmazonProduct | undefined

  for (let page = 1; page <= opts.maxPages; page++) {
    const params = new URLSearchParams({
      api_key: opts.apiKey,
      type: "reviews",
      amazon_domain: `amazon.${opts.marketplace}`,
      asin: opts.asin,
      sort_by: opts.sort === "helpful" ? "most_helpful" : "most_recent",
      page: String(page),
    })
    const response = await fetch(`https://api.rainforestapi.com/request?${params.toString()}`)
    if (!response.ok) {
      throw new Error(`Rainforest API returned HTTP ${response.status}. Check AMAZON_API_KEY and your plan credits.`)
    }
    const data: any = await response.json()
    if (data.request_info?.success === false) {
      throw new Error(`Rainforest API error: ${str(data.request_info?.message ?? "unknown error")}`)
    }
    if (product === undefined) {
      const p = data.product ?? {}
      const summary = data.summary ?? {}
      product = {
        asin: opts.asin,
        title: str(p.title ?? opts.asin) || opts.asin,
        brand: str(p.brand) || undefined,
        url: str(p.link) || `https://www.amazon.${opts.marketplace}/dp/${opts.asin}`,
        averageRating: num(summary.rating ?? p.rating),
        totalReviews: num(summary.total_reviews ?? summary.ratings_total ?? p.ratings_total),
      }
    }
    const pageReviews: any[] = Array.isArray(data.reviews) ? data.reviews : []
    pageReviews.forEach((r, i) => reviews.push(normalizeReview(r, (page - 1) * 100 + i)))
    if (pageReviews.length === 0) {
      break
    }
  }

  return {
    product: product ?? {
      asin: opts.asin,
      title: opts.asin,
      url: `https://www.amazon.${opts.marketplace}/dp/${opts.asin}`,
    },
    reviews,
  }
}

/** Fetch reviews through the configured paid provider, normalized to our domain types. */
export async function fetchViaApi(opts: {
  provider: AmazonApiProvider
  apiKey: string
  asin: string
  marketplace: string
  sort: AmazonReviewSort
  maxPages: number
  cookieHeader?: string
}): Promise<AmazonProductWithReviews> {
  if (opts.provider === "rainforest") {
    return fetchRainforest(opts)
  }
  return fetchUnwrangle(opts)
}

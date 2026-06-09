import type { CacheConfig } from "../types"

/**
 * Amazon reviews scraping engine selection.
 *
 * - `http`    - lightweight `fetch` against the `/product-reviews/{ASIN}` page. Free and
 *               dependency-free. Works for the first pages of reviews of most products, but
 *               Amazon increasingly gates depth behind a login wall and serves anti-bot
 *               "robot check" pages, so it is best-effort.
 * - `browser` - Playwright-driven Chromium. More reliable against anti-bot defences and can
 *               replay a logged-in `AMAZON_COOKIE` session to page deeper into the reviews.
 *               Requires the optional `playwright` peer dependency + a browser binary.
 * - `api`     - route through a paid reviews API (Unwrangle or Rainforest). The most reliable
 *               path: the provider handles proxies, CAPTCHAs and pagination. Needs AMAZON_API_KEY.
 * - `auto`    - prefer `api` when a key is set, else `browser` when Playwright + a session are
 *               available, otherwise fall back to `http`.
 */
export type AmazonEngine = "auto" | "http" | "browser" | "api"

/** Paid reviews-API providers behind the optional `api` engine. */
export type AmazonApiProvider = "unwrangle" | "rainforest"

/**
 * An authenticated Amazon session, harvested from a logged-in browser. Logged-out users only
 * see a handful of "featured" reviews; replaying the session cookies lets the scraper page
 * deeper into a product's full review history.
 */
export type AmazonSession = {
  /** Full `key=value; key=value` Cookie header to replay. */
  readonly cookieHeader: string
}

export type AmazonClientConfig = {
  /** Authenticated session; absent means only the first (public) pages of reviews are reachable. */
  readonly session?: AmazonSession
  readonly engine: AmazonEngine
  /** Default marketplace TLD, e.g. `com`, `co.uk`, `de`. Overridden by a full product URL. */
  readonly marketplace: string
  readonly userAgent: string
  /** Minimum delay (ms) enforced between successive Amazon requests (anti-bot pacing). */
  readonly minDelayMs: number
  /** Run the browser engine headless. Headful lowers detection but needs a display. */
  readonly headless: boolean
  /** Preferred locale, e.g. `en_US`, forwarded as Accept-Language and to the browser context. */
  readonly locale: string
  /** Hard cap on review pages fetched per product (each page ≈ 10 reviews). */
  readonly maxReviewPages: number
  /** Optional paid-API credentials enabling the `api` engine. */
  readonly api?: { readonly provider: AmazonApiProvider; readonly key: string }
  readonly cache?: CacheConfig
}

/** How to order the reviews Amazon returns. */
export type AmazonReviewSort = "recent" | "helpful"

/** Star filter for the reviews page. */
export type AmazonStarFilter = "all" | "five" | "four" | "three" | "two" | "one" | "positive" | "critical"

/** Verified-purchase filter. */
export type AmazonReviewerType = "all" | "verified"

/** A single customer review scraped from an Amazon product. */
export type AmazonReview = {
  readonly id: string
  readonly author: string
  /** Star rating, 1–5. Undefined when it could not be parsed. */
  readonly rating?: number
  readonly title: string
  readonly body: string
  /** Human-readable date label as Amazon renders it (e.g. "March 20, 2024"). */
  readonly date?: string
  /** Country the review was written in, parsed from "Reviewed in {country} on …". */
  readonly country?: string
  readonly verifiedPurchase: boolean
  readonly helpfulVotes?: number
  /** Reviewed variant/format (e.g. color, size). */
  readonly variant?: string
  readonly permalink?: string
}

/** Product-level metadata + rating summary. */
export type AmazonProduct = {
  readonly asin: string
  readonly title: string
  readonly brand?: string
  readonly url: string
  /** Overall average star rating, 1–5. */
  readonly averageRating?: number
  /** Total number of ratings/reviews Amazon reports for the product. */
  readonly totalReviews?: number
  /** Percentage of ratings per star (1–5), when the histogram could be parsed. */
  readonly ratingDistribution?: Readonly<Record<1 | 2 | 3 | 4 | 5, number>>
}

/** A product together with its scraped reviews. */
export type AmazonProductWithReviews = {
  readonly product: AmazonProduct
  readonly reviews: readonly AmazonReview[]
}

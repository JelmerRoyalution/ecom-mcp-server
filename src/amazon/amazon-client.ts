/* eslint-disable functype/prefer-either, functype/no-let, functype/no-imperative-loops --
 * Imperative-to-functional boundary for the Amazon scraping client, mirroring facebook-client.ts.
 * Each public method returns Either<Error, T>; the try/catch blocks capture thrown errors from
 * the fetch engines, the paid API, and the parsers into Either.left at the method boundary. The
 * review-pagination loop walks pages until the requested count is reached.
 */
import type { Either } from "functype"
import { Left, Option, Right } from "functype"

import { ResponseCache } from "../client/response-cache"
import { fetchViaApi } from "./api-engine"
import { type AmazonFetchEngine, BrowserFetchEngine, HttpFetchEngine, isPlaywrightAvailable } from "./engines"
import {
  buildProductUrl,
  buildReviewsUrl,
  detectMarketplace,
  extractAsin,
  hasNextReviewPage,
  parseProduct,
  parseReviewsPage,
  parseSearchResults,
} from "./parsers"
import type {
  AmazonClientConfig,
  AmazonProduct,
  AmazonProductWithReviews,
  AmazonReview,
  AmazonReviewerType,
  AmazonReviewSort,
  AmazonStarFilter,
} from "./types"

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

export type GetReviewsOptions = {
  readonly limit?: number
  readonly sort?: AmazonReviewSort
  readonly star?: AmazonStarFilter
  readonly reviewerType?: AmazonReviewerType
  readonly marketplace?: string
}

export class AmazonClient {
  private readonly config: AmazonClientConfig
  private readonly cache?: ResponseCache
  private engine?: AmazonFetchEngine
  private enginePromise?: Promise<AmazonFetchEngine>
  private lastRequestTime = 0

  constructor(config: AmazonClientConfig) {
    this.config = config
    this.cache = config.cache?.enabled === true ? new ResponseCache({ maxBytes: config.cache.maxBytes }) : undefined
  }

  /** True when an authenticated cookie session is configured. */
  hasSession(): boolean {
    return this.config.session !== undefined
  }

  /** True when a paid reviews API is configured and should be used. */
  private useApi(): boolean {
    return this.config.api !== undefined && (this.config.engine === "api" || this.config.engine === "auto")
  }

  /** Name of the active engine, for status reporting. */
  async activeEngineName(): Promise<"http" | "browser" | "api"> {
    if (this.useApi()) {
      return "api"
    }
    return (await this.getEngine()).name
  }

  private async getEngine(): Promise<AmazonFetchEngine> {
    if (this.engine !== undefined) {
      return this.engine
    }
    this.enginePromise ??= this.createEngine().then((engine) => {
      this.engine = engine
      return engine
    })
    return this.enginePromise
  }

  private async createEngine(): Promise<AmazonFetchEngine> {
    const { engine } = this.config
    const wantBrowser =
      engine === "browser" || (engine === "auto" && this.hasSession() && (await isPlaywrightAvailable()))

    if (wantBrowser) {
      return new BrowserFetchEngine({
        cookieHeader: this.config.session?.cookieHeader,
        userAgent: this.config.userAgent,
        headless: this.config.headless,
        locale: this.config.locale,
      })
    }
    return new HttpFetchEngine({
      cookieHeader: this.config.session?.cookieHeader,
      userAgent: this.config.userAgent,
      locale: this.config.locale,
    })
  }

  private async pace(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestTime
    if (this.lastRequestTime > 0 && elapsed < this.config.minDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, this.config.minDelayMs - elapsed))
    }
    this.lastRequestTime = Date.now()
  }

  /** Fetch HTML through the engine, with caching and anti-bot pacing. */
  private async fetchHtml(url: string): Promise<string> {
    const cached = this.cache?.get(url)
    if (cached !== undefined) {
      return cached.body
    }
    await this.pace()
    const engine = await this.getEngine()
    const html = await engine.fetchHtml(url)
    this.cache?.set(url, html, 200)
    return html
  }

  /** Resolve an ASIN + marketplace from a product reference (ASIN or any Amazon URL). */
  private resolveRef(ref: string, marketplaceOverride?: string): { asin: string; marketplace: string } | undefined {
    const asin = extractAsin(ref)
    if (asin === undefined) {
      return undefined
    }
    const marketplace = marketplaceOverride ?? detectMarketplace(ref) ?? this.config.marketplace
    return { asin, marketplace }
  }

  /**
   * Scrape a product's reviews (and its rating summary). Pages through the review list until
   * `limit` reviews are collected or the pages run out. Routes through the paid API when one
   * is configured.
   */
  async getProductReviews(ref: string, opts: GetReviewsOptions = {}): Promise<Either<Error, AmazonProductWithReviews>> {
    try {
      const resolved = this.resolveRef(ref, opts.marketplace)
      if (resolved === undefined) {
        return Left(new Error(`Could not find an ASIN in "${ref}". Pass a 10-character ASIN or an Amazon product URL.`))
      }
      const { asin, marketplace } = resolved
      const limit = opts.limit ?? 50
      const sort = opts.sort ?? "recent"

      if (this.useApi()) {
        const { api } = this.config
        if (api === undefined) {
          return Left(new Error("Amazon API engine selected but no API key is configured."))
        }
        await this.pace()
        const maxPages = Math.min(this.config.maxReviewPages, Math.max(1, Math.ceil(limit / 10)))
        const result = await fetchViaApi({
          provider: api.provider,
          apiKey: api.key,
          asin,
          marketplace,
          sort,
          maxPages,
          cookieHeader: this.config.session?.cookieHeader,
        })
        return Right({ product: result.product, reviews: result.reviews.slice(0, limit) })
      }

      const reviews: AmazonReview[] = []
      const seen = new Set<string>()
      let product: AmazonProduct | undefined

      // Amazon caps each filtered "view" at ~10 pages / ~100 reviews. The cap is PER star
      // filter, so when the caller wants depth and hasn't pinned a single star, we fan out over a
      // deliberate love/balanced/pain spread - 5★ (what they love), 3★ (the most honest, nuanced
      // reviews that list pros AND cons), 1★ (the biggest complaints) - plus the default mixed
      // view, deduping by review id. This is the most signal-rich spread for personas (4★/2★ add
      // mostly overlap). Each view caps ~100, so the ceiling is a few hundred reviews/product -
      // the same technique paid reviews APIs use. When Amazon serves the gated "limited selection"
      // render it ignores the filter params and every window returns the same set; a dry-streak
      // guard bails early so we don't waste requests in that case.
      const wantFanout = (opts.star === undefined || opts.star === "all") && limit > 10
      const starWindows: (AmazonStarFilter | undefined)[] = wantFanout
        ? [undefined, "five", "three", "one"]
        : [opts.star]

      let dryStreak = 0
      for (let i = 0; i < starWindows.length && reviews.length < limit; i++) {
        const { product: windowProduct, fresh } = await this.collectReviewWindow({
          asin,
          marketplace,
          sort,
          star: starWindows[i],
          reviewerType: opts.reviewerType,
          seen,
          reviews,
          limit,
        })
        product ??= windowProduct
        // If a later window adds nothing new twice running, Amazon is ignoring the star param
        // (gated render) - stop rather than re-fetching the same set for every bucket.
        if (i > 0 && fresh === 0) {
          dryStreak += 1
          if (dryStreak >= 2) {
            break
          }
        } else {
          dryStreak = 0
        }
      }

      product ??= { asin, title: asin, url: buildProductUrl(asin, marketplace) }
      if (reviews.length === 0) {
        return Left(
          new Error(
            `No reviews parsed for ASIN ${asin}. Amazon often gates reviews behind a login wall - try ` +
              `AMAZON_ENGINE=browser with a logged-in AMAZON_COOKIE, or set AMAZON_API_KEY for a reviews API.`,
          ),
        )
      }
      return Right({ product, reviews: reviews.slice(0, limit) })
    } catch (error) {
      return Left(new Error(`Failed to scrape Amazon reviews: ${toError(error).message}`))
    }
  }

  /**
   * Walk the (up to ~10) pages of a single review "window" (a star filter + sort), pushing fresh
   * reviews into `reviews`/`seen` and returning how many were new plus the parsed product summary.
   * Stops as soon as a page yields no new reviews or Amazon offers no next page.
   */
  private async collectReviewWindow(args: {
    readonly asin: string
    readonly marketplace: string
    readonly sort: AmazonReviewSort
    readonly star: AmazonStarFilter | undefined
    readonly reviewerType: AmazonReviewerType | undefined
    readonly seen: Set<string>
    readonly reviews: AmazonReview[]
    readonly limit: number
  }): Promise<{ product?: AmazonProduct; fresh: number }> {
    let product: AmazonProduct | undefined
    let fresh = 0
    const maxPages = this.config.maxReviewPages

    for (let page = 1; page <= maxPages && args.reviews.length < args.limit; page++) {
      const url = buildReviewsUrl({
        asin: args.asin,
        marketplace: args.marketplace,
        page,
        sort: args.sort,
        star: args.star,
        reviewerType: args.reviewerType,
      })
      const html = await this.fetchHtml(url)
      const parsed = parseReviewsPage(html, args.asin, buildProductUrl(args.asin, args.marketplace))
      product ??= parsed.product
      let pageFresh = 0
      for (const review of parsed.reviews) {
        const key = review.id !== "" ? review.id : `${review.author}|${review.title}`
        if (!args.seen.has(key)) {
          args.seen.add(key)
          args.reviews.push(review)
          fresh += 1
          pageFresh += 1
        }
      }
      // No reviews at all, nothing new on this page, or no next page → this window is exhausted.
      if (parsed.reviews.length === 0 || pageFresh === 0 || !hasNextReviewPage(html)) {
        break
      }
    }

    return { product, fresh }
  }

  /** Fetch just the product metadata + rating summary (no review bodies). */
  async getProductInfo(ref: string, marketplaceOverride?: string): Promise<Either<Error, AmazonProduct>> {
    try {
      const resolved = this.resolveRef(ref, marketplaceOverride)
      if (resolved === undefined) {
        return Left(new Error(`Could not find an ASIN in "${ref}". Pass a 10-character ASIN or an Amazon product URL.`))
      }
      const { asin, marketplace } = resolved

      if (this.useApi()) {
        // The reviews API returns product summary alongside reviews; reuse it with a tiny page.
        const result = await this.getProductReviews(ref, { limit: 10, marketplace })
        return result.fold(
          (err) => Left(err),
          (data) => Right(data.product),
        )
      }

      const url = buildReviewsUrl({ asin, marketplace, page: 1 })
      const html = await this.fetchHtml(url)
      return Right(parseProduct(html, asin, buildProductUrl(asin, marketplace)))
    } catch (error) {
      return Left(new Error(`Failed to read Amazon product info: ${toError(error).message}`))
    }
  }

  /**
   * Search Amazon for products matching a query and return their cards (ASIN, title, rating).
   * Feed the ASINs into {@link getProductReviews}. Logged-out search is bot-protected, so this is
   * most reliable via the browser engine with a logged-in cookie.
   */
  async searchProducts(
    query: string,
    opts: { readonly limit?: number; readonly marketplace?: string } = {},
  ): Promise<Either<Error, readonly AmazonProduct[]>> {
    try {
      if (query.trim() === "") {
        return Left(new Error("A search query is required."))
      }
      if (this.useApi()) {
        return Left(
          new Error(
            "Amazon search isn't available through the reviews API. Set AMAZON_ENGINE=browser with a logged-in " +
              "AMAZON_COOKIE to search, or pass product ASINs/URLs directly to amazon_get_product_reviews.",
          ),
        )
      }
      const marketplace = opts.marketplace ?? this.config.marketplace
      const url = `https://www.amazon.${marketplace}/s?k=${encodeURIComponent(query.trim())}`
      const html = await this.fetchHtml(url)
      const products = parseSearchResults(html, marketplace)
      if (products.length === 0) {
        return Left(
          new Error(
            `No products parsed for "${query}". Amazon search is bot-protected when logged out - use ` +
              `AMAZON_ENGINE=browser with a logged-in AMAZON_COOKIE, or pass a product URL/ASIN directly.`,
          ),
        )
      }
      return Right(products.slice(0, opts.limit ?? 15))
    } catch (error) {
      return Left(new Error(`Failed to search Amazon: ${toError(error).message}`))
    }
  }

  async close(): Promise<void> {
    if (this.engine !== undefined) {
      await this.engine.close()
    }
  }
}

// Singleton instance (mirrors the Reddit + Facebook client pattern).
const clientHolder: { instance: Option<AmazonClient> } = { instance: Option.none() }

export function initializeAmazonClient(config: AmazonClientConfig): AmazonClient {
  const client = new AmazonClient(config)
  clientHolder.instance = Option(client)
  return client
}

export function getAmazonClient(): Option<AmazonClient> {
  return clientHolder.instance
}

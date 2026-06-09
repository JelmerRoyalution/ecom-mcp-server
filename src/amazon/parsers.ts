/* eslint-disable functype/no-let, functype/prefer-option, functype/prefer-fold, functype/no-imperative-loops --
 * This module is the HTML-parsing boundary for the Amazon scraper. Turning Amazon's review
 * markup into structured records is inherently imperative: it walks the DOM with Cheerio,
 * accumulates matches, and applies ordered selector fallbacks (Amazon's `data-hook` anchors
 * are durable; the surrounding `a-*` class combinations drift over time). Expressing that as
 * immutable folds would obscure intent without changing behaviour. Mirrors the
 * imperative-boundary convention used in facebook/parsers.ts.
 */
import * as cheerio from "cheerio"

import type {
  AmazonProduct,
  AmazonProductWithReviews,
  AmazonReview,
  AmazonReviewerType,
  AmazonReviewSort,
  AmazonStarFilter,
} from "./types"

type Api = cheerio.CheerioAPI
type Selection = ReturnType<cheerio.CheerioAPI>

/** Collapse whitespace and trim a raw text fragment. */
export function cleanText(input: string): string {
  return input
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Extract a 10-character ASIN from any Amazon URL shape or a bare ASIN string.
 * Handles /dp/, /gp/product/, /product-reviews/, /o/ASIN/, /dp/product/ and `?asin=`.
 */
export function extractAsin(input: string): string | undefined {
  const trimmed = input.trim()
  // A bare ASIN passed directly.
  if (/^[A-Z0-9]{10}$/i.test(trimmed)) {
    return trimmed.toUpperCase()
  }
  const patterns = [
    /\/dp\/(?:product\/)?([A-Z0-9]{10})/i,
    /\/gp\/product\/([A-Z0-9]{10})/i,
    /\/product-reviews\/([A-Z0-9]{10})/i,
    /\/o\/ASIN\/([A-Z0-9]{10})/i,
    /\/exec\/obidos\/ASIN\/([A-Z0-9]{10})/i,
    /\/gp\/aw\/d\/([A-Z0-9]{10})/i,
    /\/d\/([A-Z0-9]{10})/i,
    /[?&]asin=([A-Z0-9]{10})/i,
  ]
  for (const pattern of patterns) {
    const m = trimmed.match(pattern)
    if (m !== null) {
      return m[1].toUpperCase()
    }
  }
  return undefined
}

/** Known Amazon marketplaces (TLD suffix after `amazon.`). */
const MARKETPLACE_TLDS = [
  "com",
  "co.uk",
  "de",
  "ca",
  "fr",
  "es",
  "it",
  "co.jp",
  "com.au",
  "in",
  "com.br",
  "com.mx",
  "nl",
  "se",
  "pl",
  "sg",
  "ae",
]

/** Detect the marketplace TLD from a full Amazon URL; returns undefined for a bare ASIN. */
export function detectMarketplace(input: string): string | undefined {
  const m = input.match(/amazon\.([a-z.]{2,6})\//i)
  if (m === null) {
    return undefined
  }
  const tld = m[1].toLowerCase().replace(/\.$/, "")
  return MARKETPLACE_TLDS.includes(tld) ? tld : tld
}

const STAR_FILTER_MAP: Readonly<Record<AmazonStarFilter, string>> = {
  all: "all_stars",
  five: "five_star",
  four: "four_star",
  three: "three_star",
  two: "two_star",
  one: "one_star",
  positive: "positive",
  critical: "critical",
}

/** Build the canonical `/product-reviews/{ASIN}` URL with the standard query params. */
export function buildReviewsUrl(opts: {
  readonly asin: string
  readonly marketplace?: string
  readonly page?: number
  readonly sort?: AmazonReviewSort
  readonly star?: AmazonStarFilter
  readonly reviewerType?: AmazonReviewerType
}): string {
  const tld = opts.marketplace ?? "com"
  const params = new URLSearchParams({
    pageNumber: String(opts.page ?? 1),
    sortBy: opts.sort === "helpful" ? "helpful" : "recent",
    reviewerType: opts.reviewerType === "verified" ? "avp_only_reviews" : "all_reviews",
    filterByStar: STAR_FILTER_MAP[opts.star ?? "all"],
    formatType: "all_formats",
    mediaType: "all_contents",
  })
  return `https://www.amazon.${tld}/product-reviews/${opts.asin}/?${params.toString()}`
}

/** Build the canonical product detail URL. */
export function buildProductUrl(asin: string, marketplace = "com"): string {
  return `https://www.amazon.${marketplace}/dp/${asin}`
}

/**
 * Parse a star rating out of an Amazon "X out of 5 stars" label (handles localized
 * "X von 5" / "X sur 5" / "X su 5" and a leading bare number as fallbacks).
 */
export function parseStars(input: string | undefined): number | undefined {
  if (input === undefined) {
    return undefined
  }
  const normalized = input.replace(",", ".")
  const m =
    normalized.match(/([\d.]+)\s*(?:out of|von|sur|su|de|van|з)\s*5/i) ?? normalized.match(/^\s*([\d.]+)\s*\/\s*5/)
  if (m !== null) {
    const value = parseFloat(m[1])
    return Number.isFinite(value) ? value : undefined
  }
  return undefined
}

/** Parse "12 people found this helpful" / "One person found this helpful" into a count. */
export function parseHelpfulVotes(input: string | undefined): number | undefined {
  if (input === undefined) {
    return undefined
  }
  if (/\bone\b/i.test(input) && /helpful/i.test(input)) {
    return 1
  }
  const m = input.replace(/,/g, "").match(/(\d+)\s+(?:person|people)\s+found/i)
  return m === null ? undefined : parseInt(m[1], 10)
}

/** Parse a total-review/ratings count token ("1,234 global ratings", "2.3K") into a number. */
export function parseTotalReviews(input: string | undefined): number | undefined {
  if (input === undefined) {
    return undefined
  }
  const m = input.replace(/,/g, "").match(/(\d+(?:\.\d+)?)\s*([KkMm])?/)
  if (m === null) {
    return undefined
  }
  const base = parseFloat(m[1])
  const suffix = m[2]?.toLowerCase()
  if (suffix === "k") return Math.round(base * 1_000)
  if (suffix === "m") return Math.round(base * 1_000_000)
  return Math.round(base)
}

/**
 * Split an Amazon review date label like "Reviewed in the United States on March 20, 2024"
 * into the country and the rendered date. Falls back to treating the whole string as the date.
 */
export function parseReviewDate(input: string | undefined): { country?: string; date?: string } {
  if (input === undefined) {
    return {}
  }
  const clean = cleanText(input)
  const m = clean.match(/^Reviewed in (?:the )?(.+?) on (.+)$/i)
  if (m !== null) {
    return { country: m[1].trim(), date: m[2].trim() }
  }
  return { date: clean }
}

/** Strip a leading "X.0 out of 5 stars" phrase that Amazon sometimes folds into the title node. */
function cleanReviewTitle(raw: string): string {
  return cleanText(raw.replace(/^[\d.]+\s*out of\s*5\s*stars\s*/i, ""))
}

/** Pull the star rating off a review container from its title/rating icon alt text. */
function reviewRating($: Api, container: Selection): number | undefined {
  const ratingSelectors = [
    'i[data-hook="review-star-rating"] span.a-icon-alt',
    'i[data-hook="cmps-review-star-rating"] span.a-icon-alt',
    'a[data-hook="review-title"] span.a-icon-alt',
    "i.a-icon-star span.a-icon-alt",
  ]
  for (const sel of ratingSelectors) {
    const text = container.find(sel).first().text()
    const stars = parseStars(cleanText(text))
    if (stars !== undefined) {
      return stars
    }
  }
  // Fall back to a star-N / star-N-5 class on an a-icon-star element.
  const cls = container.find('i[class*="a-star-"]').first().attr("class") ?? ""
  const m = cls.match(/a-star-(\d)(?:-(\d))?/)
  if (m !== null) {
    return parseInt(m[1], 10) + (m[2] !== undefined ? parseInt(m[2], 10) / 10 : 0)
  }
  return undefined
}

/** The visible review title text, with any leading rating phrase removed. */
function reviewTitle($: Api, container: Selection): string {
  const titleEl = container.find('[data-hook="review-title"]').first()
  if (titleEl.length > 0) {
    // Modern markup nests the visible title in the LAST span; older markup is flat.
    const lastSpan = titleEl.find("span").not(".a-icon-alt").last()
    const text = lastSpan.length > 0 ? lastSpan.text() : titleEl.text()
    const cleaned = cleanReviewTitle(text)
    if (cleaned.length > 0) {
      return cleaned
    }
  }
  return ""
}

/** Concatenate the review body text. */
function reviewBody($: Api, container: Selection): string {
  const bodyEl = container.find('[data-hook="review-body"]').first()
  if (bodyEl.length > 0) {
    return cleanText(bodyEl.text())
  }
  const alt = container.find("div.reviewText, span.review-text-content, div.review-data span").first()
  return cleanText(alt.text())
}

/**
 * Parse the list of reviews out of a `/product-reviews/{ASIN}` page (or a product detail
 * page's reviews section). Anchored on `[data-hook="review"]`, with tolerant field selectors.
 */
export function parseReviews(html: string): readonly AmazonReview[] {
  const $ = cheerio.load(html)
  const reviews: AmazonReview[] = []
  const seen = new Set<string>()

  let containers = $('[data-hook="review"]')
  if (containers.length === 0) {
    containers = $("div.review, li.review")
  }

  containers.each((index, el) => {
    const container = $(el)
    const body = reviewBody($, container)
    const title = reviewTitle($, container)
    if (body.length === 0 && title.length === 0) {
      return
    }

    const author = cleanText(container.find("span.a-profile-name").first().text()) || "Amazon Customer"
    const rating = reviewRating($, container)
    const { country, date } = parseReviewDate(container.find('[data-hook="review-date"]').first().text())
    const verifiedPurchase = container.find('[data-hook="avp-badge"]').length > 0
    const helpfulVotes = parseHelpfulVotes(container.find('[data-hook="helpful-vote-statement"]').first().text())
    const variant = cleanText(container.find('a[data-hook="format-strip"]').first().text()) || undefined

    const idAttr = $(el).attr("id")
    const id = idAttr !== undefined && idAttr !== "" ? idAttr : `r_${index}`
    if (seen.has(id)) {
      return
    }
    seen.add(id)

    const permalinkHref = container.find('a[data-hook="review-title"]').first().attr("href")
    const permalink =
      permalinkHref !== undefined && permalinkHref !== ""
        ? permalinkHref.startsWith("http")
          ? permalinkHref
          : `https://www.amazon.com${permalinkHref}`
        : undefined

    reviews.push({
      id,
      author,
      rating,
      title,
      body,
      date,
      country,
      verifiedPurchase,
      helpfulVotes,
      variant,
      permalink,
    })
  })

  return reviews
}

/** Parse the per-star percentage histogram, when present on the page. */
function parseRatingDistribution($: Api): Readonly<Record<1 | 2 | 3 | 4 | 5, number>> | undefined {
  const dist: Record<number, number> = {}
  $('[data-hook="cr-rating-histogram"] tr, table#histogramTable tr, .a-histogram-row').each((_i, row) => {
    const text = cleanText($(row).text())
    // Rows read like "5 star 63%".
    const m = text.match(/(\d)\s*star.*?(\d{1,3})\s*%/i)
    if (m !== null) {
      const star = parseInt(m[1], 10)
      const pct = parseInt(m[2], 10)
      if (star >= 1 && star <= 5) {
        dist[star] = pct
      }
    }
  })
  if (Object.keys(dist).length === 0) {
    return undefined
  }
  return { 1: dist[1] ?? 0, 2: dist[2] ?? 0, 3: dist[3] ?? 0, 4: dist[4] ?? 0, 5: dist[5] ?? 0 }
}

/**
 * Parse product-level metadata + the rating summary from a reviews page or a product page.
 * Layered selectors cover both the `/product-reviews/` layout and the `/dp/` detail layout.
 */
export function parseProduct(html: string, asin: string, url: string): AmazonProduct {
  const $ = cheerio.load(html)

  const title =
    cleanText($('[data-hook="product-link"]').first().text()) ||
    cleanText($("#productTitle").first().text()) ||
    cleanText($('a.a-link-normal[href*="/dp/"]').first().text()) ||
    cleanText($('meta[property="og:title"]').attr("content") ?? "")

  const brand =
    cleanText($("#bylineInfo").first().text())
      .replace(/^(visit the|brand:)\s*/i, "")
      .replace(/\s*store$/i, "") || undefined

  const averageRating =
    parseStars(cleanText($('[data-hook="rating-out-of-text"]').first().text())) ??
    parseStars(cleanText($('[data-hook="average-star-rating"] span.a-icon-alt').first().text())) ??
    parseStars(cleanText($("span[data-hook='acr-average-stars-rating-text']").first().text())) ??
    parseStars(cleanText($("#acrPopover span.a-icon-alt").first().text()))

  const totalReviews =
    parseTotalReviews(cleanText($('[data-hook="total-review-count"]').first().text())) ??
    parseTotalReviews(cleanText($('[data-hook="cr-filter-info-review-rating-count"]').first().text())) ??
    parseTotalReviews(cleanText($("#acrCustomerReviewText").first().text()))

  return {
    asin,
    title: title.length > 0 ? title : asin,
    brand,
    url,
    averageRating,
    totalReviews,
    ratingDistribution: parseRatingDistribution($),
  }
}

/** Parse a reviews page into product metadata + its reviews in one pass. */
export function parseReviewsPage(html: string, asin: string, url: string): AmazonProductWithReviews {
  return { product: parseProduct(html, asin, url), reviews: parseReviews(html) }
}

/** Does this HTML look like it has a "next page" of reviews? */
export function hasNextReviewPage(html: string): boolean {
  const $ = cheerio.load(html)
  const last = $("li.a-last")
  return last.length > 0 && !last.hasClass("a-disabled") && last.find("a").length > 0
}

/**
 * Parse an Amazon search-results page (`/s?k=...`) into product cards. Anchored on the
 * `s-search-result` component with a `data-asin`, with tolerant title/rating/count selectors.
 * Logged-out search is bot-protected, so this is most reliable via the browser engine + cookie.
 */
export function parseSearchResults(html: string, marketplace = "com"): readonly AmazonProduct[] {
  const $ = cheerio.load(html)
  const products: AmazonProduct[] = []
  const seen = new Set<string>()

  $('div[data-component-type="s-search-result"][data-asin], div.s-result-item[data-asin]').each((_i, el) => {
    const container = $(el)
    const asin = (container.attr("data-asin") ?? "").toUpperCase()
    if (asin === "" || !/^[A-Z0-9]{10}$/.test(asin) || seen.has(asin)) {
      return
    }
    const title =
      cleanText(container.find("h2 a span").first().text()) ||
      cleanText(container.find("h2 span").first().text()) ||
      cleanText(container.find('[data-cy="title-recipe"] span').first().text())
    if (title === "") {
      return
    }
    seen.add(asin)

    const averageRating = parseStars(cleanText(container.find("span.a-icon-alt").first().text()))
    const countText = container
      .find(
        '[data-cy="reviews-block"] span.a-size-base, a[href*="#customerReviews"] span, span.a-size-base.s-underline-text',
      )
      .first()
      .text()
    const totalReviews = parseTotalReviews(cleanText(countText))
    const href = container.find('h2 a, a.a-link-normal[href*="/dp/"]').first().attr("href")
    const url =
      href !== undefined && href !== ""
        ? href.startsWith("http")
          ? href
          : `https://www.amazon.${marketplace}${href}`
        : buildProductUrl(asin, marketplace)

    products.push({ asin, title, url, averageRating, totalReviews })
  })

  return products
}

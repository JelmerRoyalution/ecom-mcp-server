import type { AmazonProduct, AmazonProductWithReviews, AmazonReview } from "./types"

function truncate(text: string, max: number): string {
  const clean = text.replace(/\n{3,}/g, "\n\n").trim()
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean
}

function stars(rating: number | undefined): string {
  if (rating === undefined) {
    return ""
  }
  const full = Math.round(rating)
  return `${"★".repeat(full)}${"☆".repeat(Math.max(0, 5 - full))} (${rating}/5)`
}

function distributionLine(product: AmazonProduct): string {
  if (product.ratingDistribution === undefined) {
    return ""
  }
  const d = product.ratingDistribution
  return `- Rating split: 5★ ${d[5]}% · 4★ ${d[4]}% · 3★ ${d[3]}% · 2★ ${d[2]}% · 1★ ${d[1]}%`
}

/** Render Amazon search results as Markdown (each card is ready to feed into a reviews scrape). */
export function formatProductSearch(query: string, products: readonly AmazonProduct[]): string {
  if (products.length === 0) {
    return `# Amazon Search: "${query}"\n\nNo products found. Amazon search is bot-protected when logged out - try AMAZON_ENGINE=browser with a logged-in AMAZON_COOKIE, or pass a product URL/ASIN directly.`
  }
  const body = products
    .map((p, index) => {
      const meta = [
        p.averageRating !== undefined ? stars(p.averageRating) : "",
        p.totalReviews !== undefined ? `${p.totalReviews.toLocaleString()} ratings` : "",
      ]
        .filter((s) => s.length > 0)
        .join(" · ")
      return `### ${index + 1}. ${p.title}\n- ASIN: \`${p.asin}\`${meta.length > 0 ? `\n- ${meta}` : ""}\n- URL: ${p.url}`
    })
    .join("\n\n")
  return `# Amazon Search: "${query}"\n\n_${products.length} product(s) - feed an ASIN into amazon_get_product_reviews:_\n\n${body}`
}

/** Render product-level metadata + rating summary as Markdown. */
export function formatProduct(product: AmazonProduct): string {
  const lines = [
    product.brand !== undefined ? `- Brand: ${product.brand}` : "",
    product.averageRating !== undefined ? `- Average rating: ${stars(product.averageRating)}` : "",
    product.totalReviews !== undefined ? `- Total ratings: ${product.totalReviews.toLocaleString()}` : "",
    distributionLine(product),
    `- ASIN: ${product.asin}`,
    `- URL: ${product.url}`,
  ].filter((s) => s.length > 0)

  return `# Amazon Product: ${product.title}

${lines.join("\n")}`
}

function formatReview(review: AmazonReview, index: number): string {
  const meta = [
    review.rating !== undefined ? stars(review.rating) : "",
    review.verifiedPurchase ? "✓ Verified Purchase" : "",
    review.date ?? "",
    review.country ?? "",
    review.helpfulVotes !== undefined ? `${review.helpfulVotes} found helpful` : "",
  ]
    .filter((s) => s.length > 0)
    .join(" · ")

  const heading = review.title.length > 0 ? review.title : "(no title)"
  const variant = review.variant !== undefined ? `\n_${review.variant}_` : ""
  return `### ${index + 1}. ${heading}
${meta}${variant}

${truncate(review.body, 800)}`
}

/** Render a product and its reviews as Markdown. */
export function formatProductWithReviews(result: AmazonProductWithReviews): string {
  const { product, reviews } = result
  const header = formatProduct(product)

  if (reviews.length === 0) {
    return `${header}

---

No reviews parsed. Amazon may be gating reviews behind a login wall - try AMAZON_ENGINE=browser with a logged-in AMAZON_COOKIE, or configure AMAZON_API_KEY.`
  }

  const verified = reviews.filter((r) => r.verifiedPurchase).length
  const rated = reviews.filter((r) => r.rating !== undefined)
  const avg = rated.length > 0 ? (rated.reduce((sum, r) => sum + (r.rating ?? 0), 0) / rated.length).toFixed(1) : "n/a"

  const body = reviews.map((review, index) => formatReview(review, index)).join("\n\n---\n\n")

  return `${header}

---

_${reviews.length} review(s) scraped · ${verified} verified · avg of scraped: ${avg}/5_

${body}`
}

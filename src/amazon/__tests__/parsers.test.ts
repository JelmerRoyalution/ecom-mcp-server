import { describe, expect, it } from "vitest"

import {
  buildReviewsUrl,
  detectMarketplace,
  extractAsin,
  hasNextReviewPage,
  parseHelpfulVotes,
  parseProduct,
  parseReviewDate,
  parseReviews,
  parseReviewsPage,
  parseSearchResults,
  parseStars,
  parseTotalReviews,
} from "../parsers"

describe("amazon parsers", () => {
  describe("extractAsin", () => {
    it("pulls an ASIN out of every common URL shape", () => {
      expect(extractAsin("B0CXYZ1234")).toBe("B0CXYZ1234")
      expect(extractAsin("https://www.amazon.com/dp/B0CXYZ1234")).toBe("B0CXYZ1234")
      expect(extractAsin("https://www.amazon.com/Some-Product-Name/dp/B0CXYZ1234/ref=sr_1_1")).toBe("B0CXYZ1234")
      expect(extractAsin("https://www.amazon.co.uk/gp/product/B0CXYZ1234")).toBe("B0CXYZ1234")
      expect(extractAsin("https://www.amazon.de/product-reviews/B0CXYZ1234/?pageNumber=2")).toBe("B0CXYZ1234")
      expect(extractAsin("https://www.amazon.com/gp/aw/d/B0CXYZ1234")).toBe("B0CXYZ1234")
      expect(extractAsin("https://www.amazon.com/review/create-review?asin=B0CXYZ1234")).toBe("B0CXYZ1234")
    })

    it("lowercases are normalized and junk returns undefined", () => {
      expect(extractAsin("b0cxyz1234")).toBe("B0CXYZ1234")
      expect(extractAsin("https://example.com/not-amazon")).toBeUndefined()
      expect(extractAsin("hello world")).toBeUndefined()
    })
  })

  describe("detectMarketplace", () => {
    it("reads the TLD from a full URL", () => {
      expect(detectMarketplace("https://www.amazon.com/dp/B0CXYZ1234")).toBe("com")
      expect(detectMarketplace("https://www.amazon.co.uk/dp/B0CXYZ1234")).toBe("co.uk")
      expect(detectMarketplace("https://www.amazon.de/dp/B0CXYZ1234")).toBe("de")
      expect(detectMarketplace("B0CXYZ1234")).toBeUndefined()
    })
  })

  describe("buildReviewsUrl", () => {
    it("builds a canonical product-reviews URL with the standard params", () => {
      const url = buildReviewsUrl({ asin: "B0CXYZ1234", marketplace: "com", page: 2, sort: "helpful", star: "five" })
      expect(url).toContain("https://www.amazon.com/product-reviews/B0CXYZ1234/?")
      expect(url).toContain("pageNumber=2")
      expect(url).toContain("sortBy=helpful")
      expect(url).toContain("filterByStar=five_star")
      expect(url).toContain("reviewerType=all_reviews")
    })

    it("maps verified-only to avp_only_reviews and defaults to recent/all", () => {
      const url = buildReviewsUrl({ asin: "B0CXYZ1234", reviewerType: "verified" })
      expect(url).toContain("reviewerType=avp_only_reviews")
      expect(url).toContain("sortBy=recent")
      expect(url).toContain("filterByStar=all_stars")
      expect(url).toContain("pageNumber=1")
    })
  })

  describe("scalar parsers", () => {
    it("parses star ratings from localized labels", () => {
      expect(parseStars("5.0 out of 5 stars")).toBe(5)
      expect(parseStars("4,0 von 5 Sternen")).toBe(4)
      expect(parseStars("3.5 out of 5")).toBe(3.5)
      expect(parseStars(undefined)).toBeUndefined()
      expect(parseStars("no stars here")).toBeUndefined()
    })

    it("parses helpful-vote statements", () => {
      expect(parseHelpfulVotes("12 people found this helpful")).toBe(12)
      expect(parseHelpfulVotes("1,234 people found this helpful")).toBe(1234)
      expect(parseHelpfulVotes("One person found this helpful")).toBe(1)
      expect(parseHelpfulVotes(undefined)).toBeUndefined()
    })

    it("parses total-review counts with K/M suffixes", () => {
      expect(parseTotalReviews("1,234 global ratings")).toBe(1234)
      expect(parseTotalReviews("2.3K global ratings")).toBe(2300)
      expect(parseTotalReviews(undefined)).toBeUndefined()
    })

    it("splits review-date labels into country + date", () => {
      expect(parseReviewDate("Reviewed in the United States on March 20, 2024")).toEqual({
        country: "United States",
        date: "March 20, 2024",
      })
      expect(parseReviewDate("Reviewed in the United Kingdom on 5 January 2023")).toEqual({
        country: "United Kingdom",
        date: "5 January 2023",
      })
      expect(parseReviewDate("March 20, 2024")).toEqual({ date: "March 20, 2024" })
    })
  })

  describe("parseReviews", () => {
    const html = `
      <div id="cm_cr-review_list">
        <li data-hook="review" id="R1ABC">
          <span class="a-profile-name">Jane Doe</span>
          <i data-hook="review-star-rating" class="a-icon a-icon-star a-star-5"><span class="a-icon-alt">5.0 out of 5 stars</span></i>
          <a data-hook="review-title" class="review-title" href="/gp/customer-reviews/R1ABC">
            <span class="a-icon-alt">5.0 out of 5 stars</span><span>Best moisturizer ever</span>
          </a>
          <span data-hook="review-date">Reviewed in the United States on March 20, 2024</span>
          <a data-hook="format-strip">Color: Blue</a>
          <span data-hook="avp-badge">Verified Purchase</span>
          <span data-hook="review-body"><span>This cream completely fixed my dry, flaky skin. I struggled for years.</span></span>
          <span data-hook="helpful-vote-statement">12 people found this helpful</span>
        </li>
        <li data-hook="review" id="R2DEF">
          <span class="a-profile-name">John Roe</span>
          <i class="a-icon a-icon-star a-star-2"></i>
          <span data-hook="review-title">Broke out in a rash</span>
          <span data-hook="review-date">Reviewed in the United Kingdom on 5 January 2023</span>
          <span data-hook="review-body">Way too greasy and it irritated my skin. Disappointed.</span>
          <span data-hook="helpful-vote-statement">One person found this helpful</span>
        </li>
      </div>`

    it("parses each review's fields", () => {
      const reviews = parseReviews(html)
      expect(reviews).toHaveLength(2)

      const [first, second] = reviews
      expect(first.id).toBe("R1ABC")
      expect(first.author).toBe("Jane Doe")
      expect(first.rating).toBe(5)
      expect(first.title).toBe("Best moisturizer ever")
      expect(first.body).toContain("flaky skin")
      expect(first.verifiedPurchase).toBe(true)
      expect(first.variant).toBe("Color: Blue")
      expect(first.date).toBe("March 20, 2024")
      expect(first.country).toBe("United States")
      expect(first.helpfulVotes).toBe(12)
      expect(first.permalink).toContain("/gp/customer-reviews/R1ABC")

      // Second review: rating comes from the a-star-2 class fallback, flat title, 1 helpful vote.
      expect(second.author).toBe("John Roe")
      expect(second.rating).toBe(2)
      expect(second.title).toBe("Broke out in a rash")
      expect(second.verifiedPurchase).toBe(false)
      expect(second.helpfulVotes).toBe(1)
      expect(second.country).toBe("United Kingdom")
    })

    it("returns an empty list for markup with no reviews", () => {
      expect(parseReviews("<html><body><div>nothing here</div></body></html>")).toHaveLength(0)
    })
  })

  describe("parseProduct", () => {
    const html = `
      <div>
        <a data-hook="product-link" href="/dp/B0CXYZ1234">Acme Hydrating Face Cream</a>
        <a id="bylineInfo">Visit the Acme Store</a>
        <span data-hook="rating-out-of-text">4.6 out of 5</span>
        <div data-hook="total-review-count">1,234 global ratings</div>
        <table id="histogramTable">
          <tr><td>5 star</td><td>63%</td></tr>
          <tr><td>4 star</td><td>20%</td></tr>
          <tr><td>3 star</td><td>9%</td></tr>
          <tr><td>2 star</td><td>4%</td></tr>
          <tr><td>1 star</td><td>4%</td></tr>
        </table>
      </div>`

    it("parses product metadata + rating summary", () => {
      const product = parseProduct(html, "B0CXYZ1234", "https://www.amazon.com/dp/B0CXYZ1234")
      expect(product.asin).toBe("B0CXYZ1234")
      expect(product.title).toBe("Acme Hydrating Face Cream")
      expect(product.brand).toBe("Acme")
      expect(product.averageRating).toBe(4.6)
      expect(product.totalReviews).toBe(1234)
      expect(product.ratingDistribution).toEqual({ 1: 4, 2: 4, 3: 9, 4: 20, 5: 63 })
    })
  })

  describe("parseReviewsPage", () => {
    it("returns product + reviews together", () => {
      const html = `
        <div>
          <a data-hook="product-link" href="/dp/B0CXYZ1234">Acme Cream</a>
          <li data-hook="review" id="R1"><span data-hook="review-body">Love it, works great on dry skin.</span></li>
        </div>`
      const { product, reviews } = parseReviewsPage(html, "B0CXYZ1234", "https://www.amazon.com/dp/B0CXYZ1234")
      expect(product.title).toBe("Acme Cream")
      expect(reviews).toHaveLength(1)
    })
  })

  describe("parseSearchResults", () => {
    const html = `
      <div class="s-main-slot">
        <div data-component-type="s-search-result" data-asin="B086RQVNDV">
          <h2><a class="a-link-normal" href="/Nature-Made/dp/B086RQVNDV/ref=sr_1_2"><span>Nature Made Magnesium Glycinate 200 mg</span></a></h2>
          <div data-cy="reviews-ratings-slot"><span class="a-icon-alt">4.6 out of 5 stars</span></div>
          <div data-cy="reviews-block"><span class="a-size-base s-underline-text">12,345</span></div>
        </div>
        <div data-component-type="s-search-result" data-asin="B07ABCDEFG">
          <h2><span>Pure Encapsulations Magnesium Glycinate</span></h2>
        </div>
        <div data-component-type="s-search-result" data-asin="SPONSORED-X"></div>
      </div>`

    it("parses product cards with ASIN, title, rating and count", () => {
      const products = parseSearchResults(html, "com")
      expect(products).toHaveLength(2)

      const [first, second] = products
      expect(first.asin).toBe("B086RQVNDV")
      expect(first.title).toContain("Nature Made")
      expect(first.averageRating).toBe(4.6)
      expect(first.totalReviews).toBe(12345)
      expect(first.url).toContain("/dp/B086RQVNDV")

      expect(second.asin).toBe("B07ABCDEFG")
      expect(second.title).toContain("Pure Encapsulations")
      expect(second.averageRating).toBeUndefined()
    })

    it("returns an empty list for a bot-check / empty page", () => {
      expect(parseSearchResults("<html><body>Robot Check</body></html>")).toHaveLength(0)
    })
  })

  describe("hasNextReviewPage", () => {
    it("detects an enabled next link", () => {
      expect(hasNextReviewPage('<ul><li class="a-last"><a href="?pageNumber=2">Next</a></li></ul>')).toBe(true)
    })
    it("returns false when the next link is disabled or absent", () => {
      expect(hasNextReviewPage('<ul><li class="a-last a-disabled">Next</li></ul>')).toBe(false)
      expect(hasNextReviewPage("<ul><li>nothing</li></ul>")).toBe(false)
    })
  })
})

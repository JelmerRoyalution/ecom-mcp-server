import { describe, expect, it } from "vitest"

import { aggregateBrands, filterAds, parseAdsPage, parseAdsPages, sortAds } from "../parsers"
import { searchResponse } from "./fixtures"

describe("meta-ads parsers", () => {
  describe("parseAdsPage", () => {
    const { ads, endCursor, hasNextPage } = parseAdsPage(searchResponse)

    it("extracts all collated ads with the pagination cursor", () => {
      expect(ads).toHaveLength(4)
      expect(endCursor).toBe("CURSORABC")
      expect(hasNextPage).toBe(true)
    })

    it("normalizes an IMAGE ad (copy, media, page meta, run-length signal)", () => {
      const ad = ads.find((a) => a.adArchiveId === "111")
      expect(ad).toBeDefined()
      expect(ad?.pageName).toBe("Vitality Extracts Essential Oils")
      expect(ad?.displayFormat).toBe("IMAGE")
      expect(ad?.creative.title).toBe("Frankincense Balm")
      expect(ad?.creative.body).toContain("stiff joints")
      expect(ad?.creative.caption).toBe("vitalityextracts.com")
      expect(ad?.creative.ctaText).toBe("Shop now")
      expect(ad?.creative.imageUrls).toContain("https://example.test/img1.jpg")
      expect(ad?.pageLikeCount).toBe(1296770)
      expect(ad?.collationCount).toBe(5)
      expect(typeof ad?.daysRunning).toBe("number")
      expect(ad?.daysRunning).toBeGreaterThanOrEqual(0)
      expect(ad?.snapshotUrl).toBe("https://www.facebook.com/ads/library/?id=111")
    })

    it("normalizes a VIDEO ad with poster", () => {
      const ad = ads.find((a) => a.adArchiveId === "222")
      expect(ad?.creative.videoUrls).toContain("https://example.test/v-hd.mp4")
      expect(ad?.creative.videoPreviewImageUrl).toBe("https://example.test/v-poster.jpg")
    })

    it("resolves a DCO ad from cards[] when the top-level fields are {{templates}}", () => {
      const ad = ads.find((a) => a.adArchiveId === "333")
      expect(ad?.displayFormat).toBe("DCO")
      // top-level title/body were "{{product.name}}" / "{{product.description}}" → resolved from card
      expect(ad?.creative.title).toBe("From a 6 to a 1 in Minutes")
      expect(ad?.creative.body).toContain("knee pain")
      expect(ad?.creative.videoUrls).toContain("https://example.test/card-hd.mp4")
      expect(ad?.creative.caption).toBe("vitalityextracts.com")
      expect(ad?.cards).toHaveLength(2)
    })
  })

  describe("parseAdsPages", () => {
    it("flattens and de-duplicates across pages by archive id", () => {
      const { ads, hasMore } = parseAdsPages([searchResponse, searchResponse])
      expect(ads).toHaveLength(4)
      expect(hasMore).toBe(true)
    })
  })

  describe("aggregateBrands", () => {
    it("surfaces the connected page network ranked by ad volume", () => {
      const { ads } = parseAdsPages([searchResponse])
      const brands = aggregateBrands(ads, "US")
      expect(brands).toHaveLength(2)
      expect(brands[0].pageName).toBe("Vitality Extracts Essential Oils")
      expect(brands[0].adCountSeen).toBe(3)
      expect(brands[0].snapshotUrl).toContain("view_all_page_id=821291691309623")
      expect(brands[1].pageName).toBe("Families For Wellness")
    })
  })

  describe("filterAds", () => {
    const { ads } = parseAdsPages([searchResponse])

    it("filters by active status", () => {
      const active = filterAds(ads, { mediaType: "all", activeStatus: "active" })
      expect(active.map((a) => a.adArchiveId).sort()).toEqual(["111", "222", "333"])
    })

    it("filters by media type (video resolves through DCO cards)", () => {
      const videos = filterAds(ads, { mediaType: "video", activeStatus: "active" })
      expect(videos.map((a) => a.adArchiveId).sort()).toEqual(["222", "333"])
    })

    it("filters by publisher platform", () => {
      const messenger = filterAds(ads, { mediaType: "all", activeStatus: "all", platform: "messenger" })
      expect(messenger.map((a) => a.adArchiveId)).toEqual(["333"])
    })
  })

  describe("sortAds", () => {
    it("orders by days running (winners first)", () => {
      const { ads } = parseAdsPages([searchResponse])
      const sorted = sortAds(ads, "longest_running")
      const running = sorted.map((a) => a.daysRunning ?? -1)
      const descending = [...running].sort((a, b) => b - a)
      expect(running).toEqual(descending)
    })
  })
})

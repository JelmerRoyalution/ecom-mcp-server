import { describe, expect, it } from "vitest"

import {
  adSnapshotUrl,
  advertiserUrl,
  buildAdLibraryUrl,
  extractAdArchiveId,
  looksLikeDomain,
  parseAdvertiserRef,
} from "../urls"

describe("meta-ads urls", () => {
  describe("buildAdLibraryUrl", () => {
    it("builds a keyword/domain search URL", () => {
      const url = buildAdLibraryUrl({
        q: "vitalityextracts.com",
        country: "US",
        activeStatus: "active",
        mediaType: "all",
        searchType: "keyword_unordered",
      })
      expect(url).toContain("https://www.facebook.com/ads/library/?")
      expect(url).toContain("q=vitalityextracts.com")
      expect(url).toContain("country=US")
      expect(url).toContain("active_status=active")
      expect(url).toContain("ad_type=all")
      expect(url).toContain("search_type=keyword_unordered")
    })

    it("builds an advertiser (page) URL with a media filter and platform", () => {
      const url = buildAdLibraryUrl({
        viewAllPageId: "821291691309623",
        country: "US",
        activeStatus: "active",
        mediaType: "video",
        platform: "instagram",
        searchType: "page",
      })
      expect(url).toContain("view_all_page_id=821291691309623")
      expect(url).toContain("media_type=video")
      expect(url).toContain("search_type=page")
      // brackets are percent-encoded by URLSearchParams
      expect(decodeURIComponent(url)).toContain("publisher_platforms[0]=instagram")
    })
  })

  describe("parseAdvertiserRef", () => {
    it("treats a bare numeric id as a page", () => {
      expect(parseAdvertiserRef("821291691309623")).toEqual({ kind: "page", pageId: "821291691309623" })
    })

    it("extracts view_all_page_id from a pasted Ad Library URL", () => {
      const ref = parseAdvertiserRef(
        "https://www.facebook.com/ads/library/?active_status=all&view_all_page_id=123456789&country=US",
      )
      expect(ref).toEqual({ kind: "page", pageId: "123456789" })
    })

    it("extracts q from a pasted search URL", () => {
      const ref = parseAdvertiserRef("https://www.facebook.com/ads/library/?q=seed.com&search_type=keyword_unordered")
      expect(ref).toEqual({ kind: "keyword", q: "seed.com" })
    })

    it("treats a name/domain as a keyword", () => {
      expect(parseAdvertiserRef("Vitality Extracts")).toEqual({ kind: "keyword", q: "Vitality Extracts" })
      expect(parseAdvertiserRef("vitalityextracts.com")).toEqual({ kind: "keyword", q: "vitalityextracts.com" })
    })
  })

  describe("extractAdArchiveId", () => {
    it("reads a bare id and an ?id= URL", () => {
      expect(extractAdArchiveId("2085382372023599")).toBe("2085382372023599")
      expect(extractAdArchiveId("https://www.facebook.com/ads/library/?id=2085382372023599")).toBe("2085382372023599")
      expect(extractAdArchiveId("not-an-id")).toBeUndefined()
    })
  })

  describe("looksLikeDomain", () => {
    it("recognizes bare domains and rejects phrases", () => {
      expect(looksLikeDomain("vitalityextracts.com")).toBe(true)
      expect(looksLikeDomain("seed.com")).toBe(true)
      expect(looksLikeDomain("magnesium glycinate")).toBe(false)
      expect(looksLikeDomain("besque")).toBe(false)
    })
  })

  describe("helper URLs", () => {
    it("builds ad + advertiser deep links", () => {
      expect(adSnapshotUrl("123")).toBe("https://www.facebook.com/ads/library/?id=123")
      expect(advertiserUrl("999", "US")).toContain("view_all_page_id=999")
    })
  })
})

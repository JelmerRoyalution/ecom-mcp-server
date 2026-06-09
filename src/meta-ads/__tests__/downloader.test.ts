import { describe, expect, it } from "vitest"

import { slugify, sniffExt } from "../downloader"

describe("meta-ads downloader helpers", () => {
  describe("sniffExt (magic bytes win over content-type)", () => {
    it("detects PNG bytes even when the CDN labels it jpeg", () => {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      expect(sniffExt(png, "image/jpeg")).toBe("png")
    })

    it("detects JPEG, GIF, WEBP and MP4 from bytes", () => {
      expect(sniffExt(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "")).toBe("jpg")
      expect(sniffExt(Buffer.from([0x47, 0x49, 0x46, 0x38]), "")).toBe("gif")
      const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP")])
      expect(sniffExt(webp, "")).toBe("webp")
      const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftyp"), Buffer.from("isom")])
      expect(sniffExt(mp4, "")).toBe("mp4")
    })

    it("falls back to content-type when bytes are unrecognized", () => {
      const junk = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05])
      expect(sniffExt(junk, "image/png")).toBe("png")
      expect(sniffExt(junk, "video/mp4")).toBe("mp4")
      expect(sniffExt(junk, "application/octet-stream")).toBe("jpg")
    })
  })

  describe("slugify", () => {
    it("makes filesystem-safe advertiser slugs", () => {
      expect(slugify("Vitality Extracts Essential Oils")).toBe("Vitality_Extracts_Essential_Oils")
      expect(slugify("Dr. Julie Abboud")).toBe("Dr_Julie_Abboud")
      expect(slugify("Eat Smart with Dr. Amanda Johnson")).toBe("Eat_Smart_with_Dr_Amanda_Johnson")
    })

    it("falls back to 'advertiser' for empty/symbol-only names and caps length", () => {
      expect(slugify("   ???   ")).toBe("advertiser")
      expect(slugify("")).toBe("advertiser")
      expect(slugify("a".repeat(100)).length).toBe(60)
    })
  })
})

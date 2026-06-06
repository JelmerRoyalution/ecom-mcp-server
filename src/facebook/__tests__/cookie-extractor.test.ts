import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "vitest"

import { BROWSER_REGISTRY, detectInstalledBrowsers, hasCookieDb } from "../cookie-extractor"

describe("cookie-extractor", () => {
  const temps: string[] = []
  const makeProfile = (withCookies: "flat" | "network" | "none"): string => {
    const base = mkdtempSync(join(tmpdir(), "browsertest-"))
    temps.push(base)
    mkdirSync(join(base, "Default"), { recursive: true })
    if (withCookies === "flat") {
      writeFileSync(join(base, "Default", "Cookies"), "x")
    } else if (withCookies === "network") {
      mkdirSync(join(base, "Default", "Network"), { recursive: true })
      writeFileSync(join(base, "Default", "Network", "Cookies"), "x")
    }
    return base
  }

  afterAll(() => {
    for (const t of temps) {
      rmSync(t, { recursive: true, force: true })
    }
  })

  describe("BROWSER_REGISTRY", () => {
    it("covers the common Chromium-family browsers", () => {
      const keys = Object.keys(BROWSER_REGISTRY)
      expect(keys).toEqual(expect.arrayContaining(["chrome", "brave", "edge", "arc", "chromium"]))
    })

    it("each spec resolves a user-data-dir and lists executables", () => {
      for (const spec of Object.values(BROWSER_REGISTRY)) {
        expect(typeof spec.label).toBe("string")
        expect(Array.isArray(spec.executables)).toBe(true)
        // userDataDir() returns a string on supported platforms
        const dir = spec.userDataDir()
        expect(dir === undefined || typeof dir === "string").toBe(true)
      }
    })
  })

  describe("hasCookieDb", () => {
    it("detects the flat Cookies location", () => {
      expect(hasCookieDb(makeProfile("flat"))).toBe(true)
    })
    it("detects the Network/Cookies location", () => {
      expect(hasCookieDb(makeProfile("network"))).toBe(true)
    })
    it("returns false when no cookie DB exists", () => {
      expect(hasCookieDb(makeProfile("none"))).toBe(false)
    })
  })

  describe("detectInstalledBrowsers", () => {
    it("returns an array of {key,label,userDataDir} without throwing", () => {
      const found = detectInstalledBrowsers()
      expect(Array.isArray(found)).toBe(true)
      for (const b of found) {
        expect(typeof b.key).toBe("string")
        expect(typeof b.label).toBe("string")
        expect(typeof b.userDataDir).toBe("string")
      }
    })
  })
})

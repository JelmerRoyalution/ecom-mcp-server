import { describe, expect, it } from "vitest"

import { buildCookieHeader, buildSessionFromCookies, buildSessionFromParts, parseCookieString } from "../cookies"

describe("facebook cookies", () => {
  describe("parseCookieString", () => {
    it("parses a standard Cookie header", () => {
      const cookies = parseCookieString("c_user=100012345; xs=ABCdef%3A1%3A0; datr=zzz; sb=qqq")
      expect(cookies["c_user"]).toBe("100012345")
      expect(cookies["xs"]).toBe("ABCdef%3A1%3A0")
      expect(cookies["datr"]).toBe("zzz")
      expect(cookies["sb"]).toBe("qqq")
    })

    it("keeps values that themselves contain '='", () => {
      const cookies = parseCookieString("xs=a=b=c")
      expect(cookies["xs"]).toBe("a=b=c")
    })

    it("tolerates newline-separated input and blank segments", () => {
      const cookies = parseCookieString("c_user=1\n\nxs=2\n")
      expect(cookies).toEqual({ c_user: "1", xs: "2" })
    })
  })

  describe("buildCookieHeader", () => {
    it("round-trips a cookie map", () => {
      const header = buildCookieHeader({ c_user: "1", xs: "2" })
      expect(header).toBe("c_user=1; xs=2")
    })
  })

  describe("buildSessionFromCookies", () => {
    it("builds a session when c_user and xs are present", () => {
      const result = buildSessionFromCookies("c_user=42; xs=secret; datr=dev")
      expect(result.isRight()).toBe(true)
      const session = result.orThrow(new Error("expected right"))
      expect(session.cUser).toBe("42")
      expect(session.xs).toBe("secret")
      expect(session.datr).toBe("dev")
      expect(session.cookieHeader).toContain("c_user=42")
    })

    it("fails when xs is missing", () => {
      const result = buildSessionFromCookies("c_user=42; datr=dev")
      expect(result.isLeft()).toBe(true)
    })

    it("fails on an empty string", () => {
      expect(buildSessionFromCookies("").isLeft()).toBe(true)
    })
  })

  describe("buildSessionFromParts", () => {
    it("builds a session from discrete parts", () => {
      const result = buildSessionFromParts({ cUser: "7", xs: "s", datr: "d" })
      expect(result.isRight()).toBe(true)
      const session = result.orThrow(new Error("expected right"))
      expect(session.cookieHeader).toBe("c_user=7; xs=s; datr=d")
    })

    it("omits datr when not provided", () => {
      const session = buildSessionFromParts({ cUser: "7", xs: "s" }).orThrow(new Error("expected right"))
      expect(session.cookieHeader).toBe("c_user=7; xs=s")
      expect(session.datr).toBeUndefined()
    })

    it("fails when c_user is missing", () => {
      expect(buildSessionFromParts({ xs: "s" }).isLeft()).toBe(true)
    })
  })
})

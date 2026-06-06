import { describe, expect, it } from "vitest"

import { toCsv } from "../csv"

describe("toCsv", () => {
  const columns = ["platform", "comment"]

  it("writes a header and one line per row", () => {
    const csv = toCsv(columns, [
      { platform: "reddit", comment: "hello" },
      { platform: "facebook", comment: "world" },
    ])
    expect(csv).toBe("platform,comment\nreddit,hello\nfacebook,world\n")
  })

  it("quotes fields containing commas, quotes, or newlines", () => {
    const csv = toCsv(columns, [{ platform: "reddit", comment: 'he said "hi", then left\nbye' }])
    expect(csv).toBe('platform,comment\nreddit,"he said ""hi"", then left\nbye"\n')
  })

  it("renders missing keys as empty cells", () => {
    const csv = toCsv(columns, [{ platform: "reddit" }])
    expect(csv).toBe("platform,comment\nreddit,\n")
  })

  it("returns just the header for no rows", () => {
    expect(toCsv(columns, [])).toBe("platform,comment\n")
  })
})

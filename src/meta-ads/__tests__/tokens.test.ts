import { describe, expect, it } from "vitest"

import { buildGraphqlBody, buildVariables, computeJazoest, harvestTokens } from "../tokens"

const SAMPLE_HTML = `
<html><head>
<script>requireLazy(["LSD"],function(l){});__d("LSD",[],{"token":"lsd_abc123"},0);</script>
<script>__d("DTSGInitialData",[],{"token":"dtsg_xyz789"},0);</script>
<script>{"client_revision":1024998877,"haste_session":"99999.BP:DEFAULT.2:","__spin_t":1730000000,"__spin_b":"trunk","__spin_r":1024998877}</script>
<script>{"CurrentUserInitialData":{"USER_ID":"100012345"}}</script>
<script>{"fb_api_req_friendly_name":"AdLibrarySearchPaginationQuery","doc_id":"24394279933540792"}</script>
</head><body></body></html>
`

describe("meta-ads tokens", () => {
  it("computes the jazoest checksum", () => {
    // a=97, b=98, c=99 → 294
    expect(computeJazoest("abc")).toBe("2294")
  })

  it("harvests the tokens and doc_id from page HTML", () => {
    const t = harvestTokens(SAMPLE_HTML)
    expect(t.lsd).toBe("lsd_abc123")
    expect(t.fbDtsg).toBe("dtsg_xyz789")
    expect(t.jazoest).toBe(computeJazoest("dtsg_xyz789"))
    expect(t.rev).toBe("1024998877")
    expect(t.user).toBe("100012345")
    expect(t.docId).toBe("24394279933540792")
  })

  it("returns undefined doc_id/tokens when absent (engine then guides the user)", () => {
    const t = harvestTokens("<html><body>no tokens here</body></html>")
    expect(t.docId).toBeUndefined()
    expect(t.fbDtsg).toBeUndefined()
    expect(t.lsd).toBeUndefined()
  })

  it("builds GraphQL variables matching the live search shape", () => {
    const vars = buildVariables(
      {
        q: "vitalityextracts.com",
        country: "US",
        activeStatus: "active",
        mediaType: "video",
        searchType: "keyword_unordered",
      },
      { cursor: "CUR", first: 30, sessionId: "sess-1" },
    )
    expect(vars.queryString).toBe("vitalityextracts.com")
    expect(vars.activeStatus).toBe("ACTIVE")
    expect(vars.mediaType).toBe("VIDEO")
    expect(vars.searchType).toBe("KEYWORD_UNORDERED")
    expect(vars.adType).toBe("ALL")
    expect(vars.countries).toEqual(["US"])
    expect(vars.cursor).toBe("CUR")
    expect(vars.first).toBe(30)
  })

  it("maps an advertiser page search and country=ALL", () => {
    const vars = buildVariables(
      { viewAllPageId: "821291691309623", country: "ALL", activeStatus: "all", mediaType: "all", searchType: "page" },
      { first: 30, sessionId: "sess-2" },
    )
    expect(vars.searchType).toBe("PAGE")
    expect(vars.viewAllPageID).toBe("821291691309623")
    expect(vars.countries).toEqual(["ALL"])
    expect(vars.cursor).toBeNull()
  })

  it("assembles a urlencoded GraphQL body with tokens + doc_id", () => {
    const body = buildGraphqlBody({
      tokens: { lsd: "L", fbDtsg: "D", jazoest: "2100", user: "5", rev: "999" },
      variables: { queryString: "x" },
      docId: "123456",
      friendlyName: "AdLibrarySearchPaginationQuery",
    })
    expect(body).toContain("lsd=L")
    expect(body).toContain("fb_dtsg=D")
    expect(body).toContain("jazoest=2100")
    expect(body).toContain("doc_id=123456")
    expect(body).toContain("fb_api_req_friendly_name=AdLibrarySearchPaginationQuery")
    expect(body).toContain(`variables=${encodeURIComponent(JSON.stringify({ queryString: "x" }))}`)
  })
})

import { describe, expect, it } from "vitest"

import {
  extractGroupId,
  extractPostId,
  parseCount,
  parseGroupFeed,
  parseGroupInfo,
  parseGroupSearchResults,
  parsePostWithComments,
} from "../parsers"

describe("facebook parsers", () => {
  describe("helpers", () => {
    it("parses count tokens with K/M suffixes", () => {
      expect(parseCount("12")).toBe(12)
      expect(parseCount("1,234")).toBe(1234)
      expect(parseCount("1.2K")).toBe(1200)
      expect(parseCount("2.3M")).toBe(2_300_000)
      expect(parseCount(undefined)).toBeUndefined()
    })

    it("extracts a group id from ids and urls", () => {
      expect(extractGroupId("123456")).toBe("123456")
      expect(extractGroupId("https://www.facebook.com/groups/skincarelovers/")).toBe("skincarelovers")
      expect(extractGroupId("https://m.facebook.com/groups/987/?ref=share")).toBe("987")
    })

    it("extracts a post id from permalinks", () => {
      expect(extractPostId("/groups/skincare/permalink/111/")).toBe("111")
      expect(extractPostId("/story.php?story_fbid=222&id=5")).toBe("222")
      expect(extractPostId("/nope")).toBeUndefined()
    })
  })

  describe("parseGroupFeed", () => {
    const html = `
      <div id="m_group_stories_container">
        <div role="article" data-ft='{"top_level_post_id":"111"}'>
          <h3><a href="/profile.php?id=555">Jane Doe</a></h3>
          <div data-ft="b"><div>My skin has been so dry lately and nothing works.</div></div>
          <p>I've tried every moisturizer and still struggle with flaky skin.</p>
          <a href="/groups/skincare/permalink/111/">Full Story</a>
          <div>42 Comments 5 Shares 100 Reactions</div>
        </div>
        <div role="article">
          <h3><a href="/profile.php?id=777">John Roe</a></h3>
          <p>Where can I buy the best vitamin C serum?</p>
          <a href="/groups/skincare/permalink/222/">Full Story</a>
          <div>3 Comments</div>
        </div>
      </div>`

    it("parses posts with author, text, permalink and engagement", () => {
      const posts = parseGroupFeed(html, { groupId: "skincare" })
      expect(posts).toHaveLength(2)

      const [first, second] = posts
      expect(first.author).toBe("Jane Doe")
      expect(first.id).toBe("111")
      expect(first.text).toContain("dry")
      expect(first.text).toContain("flaky skin")
      expect(first.commentCount).toBe(42)
      expect(first.shareCount).toBe(5)
      expect(first.likeCount).toBe(100)
      expect(first.permalink).toContain("/permalink/111")
      expect(first.groupId).toBe("skincare")

      expect(second.author).toBe("John Roe")
      expect(second.id).toBe("222")
      expect(second.commentCount).toBe(3)
    })

    it("returns an empty list for markup with no articles", () => {
      expect(parseGroupFeed("<html><body><div>nothing here</div></body></html>")).toHaveLength(0)
    })
  })

  describe("parsePostWithComments", () => {
    const html = `
      <div id="m_story_permalink_view">
        <div role="article">
          <h3><a href="/profile.php?id=555">Jane Doe</a></h3>
          <p>My skin is so dry and flaky, I hate it.</p>
          <a href="/groups/skincare/permalink/111/">Full Story</a>
        </div>
        <div id="ufi">
          <div role="article" id="comment_1">
            <h3><a href="/profile.php?id=1">Amy</a></h3>
            <div data-ft="c"><div>Try jojoba oil, it fixed my dryness completely.</div></div>
            <a href="/groups/skincare/permalink/111/?comment_id=901">4d</a>
          </div>
          <div role="article" id="comment_2">
            <h3><a href="/profile.php?id=2">Bob</a></h3>
            <div data-ft="c"><div>I struggled too, then switched to CeraVe and it helped.</div></div>
            <abbr>2 h</abbr>
            <a href="/groups/skincare/?comment_id=902">Reply</a>
          </div>
        </div>
      </div>`

    it("separates the post from its comments and does not leak the wrapper", () => {
      const { post, comments } = parsePostWithComments(html, { groupId: "skincare" })

      expect(post.author).toBe("Jane Doe")
      expect(post.text).toContain("dry and flaky")
      expect(post.id).toBe("111")

      expect(comments).toHaveLength(2)
      expect(comments.map((c) => c.author)).toEqual(["Amy", "Bob"])
      expect(comments[0].text).toContain("jojoba")
      expect(comments[1].text).toContain("CeraVe")
      // Facebook renders a relative time label that we capture as the timestamp.
      expect(comments[0].timestamp).toBe("4d")
      expect(comments[1].timestamp).toBe("2 h")
      // The #ufi container must NOT appear as a giant merged comment.
      expect(comments.some((c) => c.text.includes("jojoba") && c.text.includes("CeraVe"))).toBe(false)
    })
  })

  describe("parseGroupInfo", () => {
    it("reads og tags, privacy and member count", () => {
      const html = `
        <html><head>
          <meta property="og:title" content="Skincare Lovers | Facebook" />
          <meta property="og:description" content="A community for skincare fans." />
        </head><body>
          <div>Private group · 24,500 members</div>
        </body></html>`
      const group = parseGroupInfo(html, "skincare", "https://www.facebook.com/groups/skincare")
      expect(group.name).toBe("Skincare Lovers")
      expect(group.privacy).toBe("private")
      expect(group.memberCount).toBe(24500)
      expect(group.description).toContain("skincare fans")
    })
  })

  describe("parseGroupSearchResults", () => {
    it("extracts unique groups from search markup", () => {
      const html = `
        <div>
          <a href="/groups/skincarelovers/">Skincare Lovers</a>
          <a href="/groups/skincarelovers/">Skincare Lovers</a>
          <a href="/groups/glowgang/?ref=search">Glow Gang</a>
          <a href="/feed/">Your Feed</a>
        </div>`
      const groups = parseGroupSearchResults(html)
      expect(groups).toHaveLength(2)
      expect(groups.map((g) => g.id)).toEqual(["skincarelovers", "glowgang"])
      expect(groups[0].url).toBe("https://www.facebook.com/groups/skincarelovers")
    })
  })
})

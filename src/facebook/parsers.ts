/* eslint-disable functype/no-let, functype/prefer-option, functype/prefer-fold, functype/no-imperative-loops --
 * This module is the HTML-parsing boundary for the Facebook scraper. Turning Facebook's
 * deeply-nested, obfuscated, frequently-malformed mobile markup into structured records is
 * inherently imperative: it walks the DOM with Cheerio, accumulates matches, and applies
 * ordered selector fallbacks. Expressing that as immutable folds would obscure intent without
 * changing behavior. Mirrors the imperative-boundary convention used in reddit-client.ts.
 */
import * as cheerio from "cheerio"

import type { FacebookComment, FacebookGroup, FacebookGroupPrivacy, FacebookPost } from "./types"

// cheerio publicly exports only `Cheerio` and `CheerioAPI`; derive the element-bound
// selection type from the `$` call signature rather than naming domhandler's node types.
type Api = cheerio.CheerioAPI
type Selection = ReturnType<cheerio.CheerioAPI>

/** UI chrome strings that show up as text nodes on the mobile site and must be stripped. */
const UI_NOISE = new Set(
  [
    "like",
    "comment",
    "share",
    "reply",
    "full story",
    "see more",
    "see translation",
    "view more comments",
    "view previous comments",
    "write a comment",
    "write a comment…",
    "more",
    "hide",
    "report",
    "follow",
    "join",
    "top fan",
    "author",
    "edited",
    "·",
  ].map((s) => s.toLowerCase()),
)

/** Collapse whitespace and trim a raw text fragment. */
export function cleanText(input: string): string {
  return input.replace(/ /g, " ").replace(/\s+/g, " ").trim()
}

/**
 * Parse a Facebook-style count token ("1.2K", "3,456", "2.3M", "12") into a number.
 * Returns undefined when nothing numeric is present.
 */
export function parseCount(input: string | undefined): number | undefined {
  if (input === undefined) {
    return undefined
  }
  const match = input.replace(/,/g, "").match(/(\d+(?:\.\d+)?)\s*([KkMm])?/)
  if (match === null) {
    return undefined
  }
  const base = parseFloat(match[1])
  const suffix = match[2]?.toLowerCase()
  if (suffix === "k") {
    return Math.round(base * 1_000)
  }
  if (suffix === "m") {
    return Math.round(base * 1_000_000)
  }
  return Math.round(base)
}

/** Extract a bare group id/slug from a raw id or any Facebook group URL. */
export function extractGroupId(input: string): string {
  const trimmed = input.trim()
  const urlMatch = trimmed.match(/groups\/([^/?#]+)/i)
  if (urlMatch !== null) {
    return decodeURIComponent(urlMatch[1])
  }
  return trimmed.replace(/^\/+|\/+$/g, "")
}

/** Extract a numeric post id from a Facebook permalink/story href, if present. */
export function extractPostId(href: string): string | undefined {
  const patterns = [
    /story_fbid=(\d+)/,
    /\/permalink\/(\d+)/,
    /\/posts\/(\d+)/,
    /\/groups\/[^/]+\/posts\/(\d+)/,
    /multi_permalinks=(\d+)/,
    /comment_id=(\d+)/,
    /\bfbid=(\d+)/,
  ]
  for (const pattern of patterns) {
    const m = href.match(pattern)
    if (m !== null) {
      return m[1]
    }
  }
  return undefined
}

/** Resolve a possibly-relative Facebook href to an absolute www.facebook.com URL. */
export function absoluteUrl(href: string | undefined): string | undefined {
  if (href === undefined || href === "") {
    return undefined
  }
  if (/^https?:\/\//i.test(href)) {
    return href.replace(/^https?:\/\/(?:m|mbasic|web)\.facebook\.com/i, "https://www.facebook.com")
  }
  if (href.startsWith("/")) {
    return `https://www.facebook.com${href}`
  }
  return undefined
}

function looksLikeProfileLink(href: string): boolean {
  // Group member links look like /groups/{id}/user/{uid}/ — treat those as profiles.
  if (/\/user\/\d+/.test(href)) {
    return true
  }
  if (href.includes("/groups/")) {
    return false
  }
  return /\/profile\.php\?id=\d+/.test(href) || /facebook\.com\/[^/?#]+$/.test(href) || /^\/[^/?#]+$/.test(href)
}

/** A drop of text is meaningful only if it is not pure UI chrome or a bare separator. */
function isContentText(text: string): boolean {
  const lower = text.toLowerCase()
  if (text.length === 0) {
    return false
  }
  if (UI_NOISE.has(lower)) {
    return false
  }
  // Pure counts like "12 likes" / "3 comments" are engagement chrome, not content.
  if (/^\d[\d.,km]*\s*(likes?|comments?|shares?|reactions?)$/i.test(lower)) {
    return false
  }
  return true
}

type ParseContext = {
  readonly groupId?: string
  readonly groupName?: string
}

/**
 * Pull the best-guess author + profile URL out of a post/comment container.
 * Strategy: prefer heading anchors (`h3 a`, `h4 a`, `strong a`), then the first
 * anchor whose href looks like a profile (not a group/system link).
 */
function extractAuthor($: Api, container: Selection): { name: string; profileUrl?: string } {
  const headingSelectors = ["h3 a", "h4 a", "strong a", "h3", "h4"]
  for (const sel of headingSelectors) {
    const el = container.find(sel).first()
    const name = cleanText(el.text())
    if (name.length > 0 && isContentText(name)) {
      const href = el.attr("href")
      return { name, profileUrl: absoluteUrl(href) }
    }
  }

  // Fallback: first anchor that resembles a profile link.
  let found: { name: string; profileUrl?: string } | undefined
  container.find("a[href]").each((_i, a) => {
    if (found !== undefined) {
      return
    }
    const href = $(a).attr("href") ?? ""
    const name = cleanText($(a).text())
    if (name.length > 1 && isContentText(name) && looksLikeProfileLink(href)) {
      found = { name, profileUrl: absoluteUrl(href) }
    }
  })
  return found ?? { name: "Unknown" }
}

/** Concatenate the meaningful text of a container, preferring paragraph/text blocks. */
function extractBodyText($: Api, container: Selection): string {
  // Modern www.facebook.com renders the post/comment message in div[dir="auto"] blocks.
  // The message is the longest such block; shorter ones are the author name / timestamp.
  const dirAutos: string[] = []
  container.find('div[dir="auto"]').each((_i, el) => {
    const text = cleanText($(el).text())
    if (text.length >= 30 && isContentText(text)) {
      dirAutos.push(text)
    }
  })
  if (dirAutos.length > 0) {
    return dirAutos.sort((a, b) => b.length - a.length)[0]
  }

  const parts: string[] = []

  // Mobile/mbasic post bodies live in <p> tags or in divs carrying data-ft.
  const candidates = container.find("p, div[data-ft] > div, div[data-gt] > div")
  if (candidates.length > 0) {
    candidates.each((_i, el) => {
      const text = cleanText($(el).text())
      if (text.length > 0 && isContentText(text)) {
        parts.push(text)
      }
    })
  }

  if (parts.length === 0) {
    // Last resort: own text minus obvious chrome.
    const text = cleanText(container.text())
    if (text.length > 0) {
      parts.push(text)
    }
  }

  // Dedupe consecutive duplicates and join.
  const deduped: string[] = []
  for (const part of parts) {
    if (deduped[deduped.length - 1] !== part) {
      deduped.push(part)
    }
  }
  return deduped.join("\n").trim()
}

function findPermalink($: Api, container: Selection): string | undefined {
  let permalink: string | undefined
  container.find("a[href]").each((_i, a) => {
    if (permalink !== undefined) {
      return
    }
    const href = $(a).attr("href") ?? ""
    if (/story\.php|\/permalink\/|\/posts\/|story_fbid=/.test(href)) {
      permalink = absoluteUrl(href)
    }
  })
  return permalink
}

function findEngagementCount(text: string, kind: "comment" | "share" | "reaction"): number | undefined {
  const patterns: Record<typeof kind, RegExp> = {
    comment: /([\d.,]+\s*[KkMm]?)\s+comments?/i,
    share: /([\d.,]+\s*[KkMm]?)\s+shares?/i,
    reaction: /([\d.,]+\s*[KkMm]?)\s+(?:reactions?|likes?)/i,
  }
  const m = text.match(patterns[kind])
  return m === null ? undefined : parseCount(m[1])
}

function selectArticles($: Api): Selection {
  const roleArticles = $('[role="article"]')
  if (roleArticles.length > 0) {
    return roleArticles
  }
  const dataFt = $("article[data-ft], article")
  if (dataFt.length > 0) {
    return dataFt
  }
  return $("#m_group_stories_container > div, #m_newsfeed_stream > div")
}

/**
 * Parse a group (or page) feed page into posts.
 *
 * Selectors are intentionally layered: `[role="article"]` (rendered/modern),
 * `article[data-ft]` (mbasic), then a `#m_group_stories_container` fallback.
 */
export function parseGroupFeed(html: string, ctx: ParseContext = {}): readonly FacebookPost[] {
  const $ = cheerio.load(html)
  const posts: FacebookPost[] = []
  const seen = new Set<string>()

  selectArticles($).each((index, el) => {
    const container = $(el)
    const author = extractAuthor($, container)
    const text = extractBodyText($, container)
    if (text.length === 0) {
      return
    }

    const permalink = findPermalink($, container)
    const id = (permalink !== undefined ? extractPostId(permalink) : undefined) ?? `idx_${index}`
    if (seen.has(id)) {
      return
    }
    seen.add(id)

    const containerText = cleanText(container.text())
    const images: string[] = []
    container.find("img[src]").each((_i, img) => {
      const src = $(img).attr("src")
      if (src !== undefined && /^https?:/.test(src) && !/static\.|emoji|rsrc\.php/.test(src)) {
        images.push(src)
      }
    })

    posts.push({
      id,
      author: author.name,
      authorProfileUrl: author.profileUrl,
      text,
      permalink,
      groupId: ctx.groupId,
      groupName: ctx.groupName,
      commentCount: findEngagementCount(containerText, "comment"),
      shareCount: findEngagementCount(containerText, "share"),
      likeCount: findEngagementCount(containerText, "reaction"),
      ...(images.length > 0 ? { images } : {}),
    })
  })

  return posts
}

/**
 * Parse a single post permalink page into the post plus its comment thread.
 * Comments are matched from the mobile comment container (`#ufi`, `[role="article"]`
 * within the comments region, or mbasic `div[id]` comment blocks).
 */
export function parsePostWithComments(
  html: string,
  ctx: ParseContext = {},
): { post: FacebookPost; comments: readonly FacebookComment[] } {
  const $ = cheerio.load(html)

  // The first article on a permalink page is the post itself.
  const articles = selectArticles($)
  const first = articles.first()
  const postEl = articles.get(0)
  const author = extractAuthor($, first)
  const postText = extractBodyText($, first)
  const permalink = findPermalink($, first)
  const post: FacebookPost = {
    id: (permalink !== undefined ? extractPostId(permalink) : undefined) ?? "unknown",
    author: author.name,
    authorProfileUrl: author.profileUrl,
    text: postText,
    permalink,
    groupId: ctx.groupId,
    groupName: ctx.groupName,
  }

  const comments = parseComments($, post.text, postEl)
  return { post, comments }
}

function parseComments($: Api, postText: string, postEl?: unknown): readonly FacebookComment[] {
  const comments: FacebookComment[] = []
  const seen = new Set<string>()

  // Candidate comment nodes: explicit comment containers, then generic articles, then
  // mbasic numeric-id blocks as a last resort.
  let candidates = $('#ufi [role="article"], div[data-sigil="comment"], [role="article"]')
  if (candidates.length === 0) {
    candidates = $("#m_story_permalink_view div[id], #ufi div[id]")
  }

  // Drop wrapper containers: keep only nodes that do not contain another candidate node.
  // (Otherwise a comments container like #ufi would be mistaken for one giant comment.)
  const nodes = candidates.toArray()
  const candidateSet = new Set(nodes)
  const leaves = nodes.filter((node) => {
    if (node === postEl) {
      return false
    }
    return !$(node)
      .find("*")
      .toArray()
      .some((descendant) => candidateSet.has(descendant))
  })

  leaves.forEach((el, index) => {
    const container = $(el)
    const author = extractAuthor($, container)
    let text = extractBodyText($, container)

    // The post body often re-appears as an article; skip it.
    if (text.length === 0 || (postText.length > 0 && text === postText)) {
      return
    }
    // Strip a leading repeated author name from the comment text.
    if (author.name !== "Unknown" && text.startsWith(author.name)) {
      text = cleanText(text.slice(author.name.length))
    }
    if (text.length === 0 || !isContentText(text)) {
      return
    }

    const idAttr = $(el).attr("id")
    const permalink = findCommentPermalink($, container)
    const id = idAttr !== undefined && idAttr !== "" ? idAttr : (extractPostId(permalink ?? "") ?? `c_${index}`)
    if (seen.has(id)) {
      return
    }
    seen.add(id)

    comments.push({
      id,
      author: author.name,
      authorProfileUrl: author.profileUrl,
      text,
      permalink,
      depth: estimateDepth(container),
    })
  })

  return comments
}

function findCommentPermalink($: Api, container: Selection): string | undefined {
  let permalink: string | undefined
  container.find("a[href]").each((_i, a) => {
    if (permalink !== undefined) {
      return
    }
    const href = $(a).attr("href") ?? ""
    if (/comment_id=|reply_comment_id=|\/comment\//.test(href)) {
      permalink = absoluteUrl(href)
    }
  })
  return permalink
}

/** Crude reply-depth estimate from how deeply nested the node is inside other articles. */
function estimateDepth(container: Selection): number {
  return Math.min(container.parents('[role="article"], div[data-sigil="comment"]').length, 5)
}

/** Parse a group "about" / landing page into group metadata. */
export function parseGroupInfo(html: string, groupId: string, url: string): FacebookGroup {
  const $ = cheerio.load(html)

  const title =
    cleanText($('meta[property="og:title"]').attr("content") ?? "") ||
    cleanText($("title").first().text()) ||
    cleanText($("h1").first().text())

  const description = cleanText($('meta[property="og:description"]').attr("content") ?? "")

  const bodyText = cleanText($("body").text())
  const memberMatch = bodyText.match(/([\d.,]+\s*[KkMm]?)\s+members?/i)
  const memberCount = memberMatch === null ? undefined : parseCount(memberMatch[1])

  let privacy: FacebookGroupPrivacy = "unknown"
  if (/private group/i.test(bodyText)) {
    privacy = "private"
  } else if (/public group/i.test(bodyText)) {
    privacy = "public"
  }

  return {
    id: groupId,
    name: title.replace(/\s*\|\s*Facebook\s*$/i, "").trim() || groupId,
    url,
    privacy,
    memberCount,
    description: description.length > 0 ? description : undefined,
  }
}

/** Parse a `search/groups` results page into a list of groups. */
export function parseGroupSearchResults(html: string): readonly FacebookGroup[] {
  const $ = cheerio.load(html)
  const groups: FacebookGroup[] = []
  const seen = new Set<string>()

  $('a[href*="/groups/"]').each((_i, a) => {
    const href = $(a).attr("href") ?? ""
    const id = extractGroupId(href)
    // Skip non-group hrefs (feed, your_groups, etc.) and dupes.
    if (id === "" || /^(feed|your_groups|joins|discover|search|create)$/i.test(id) || seen.has(id)) {
      return
    }
    const name = cleanText($(a).text())
    if (name.length < 2 || !isContentText(name)) {
      return
    }
    seen.add(id)
    groups.push({
      id,
      name,
      url: `https://www.facebook.com/groups/${id}`,
      privacy: "unknown",
    })
  })

  return groups
}

/* eslint-disable functype/no-let, functype/prefer-option, functype/prefer-fold, functype/no-imperative-loops, @typescript-eslint/no-explicit-any --
 * This module is the HTML/JSON-parsing boundary for the Quora scraper. Quora is a JSON SPA whose
 * answers are NOT served as schema.org JSON-LD to logged-out clients; instead the browser-rendered
 * page carries each answer in an obfuscated-but-annotated DOM (`dom_annotate_question_answer_item_N`
 * wrappers, `.spacing_log_answer_content` bodies). So the parser is DOM-first against the rendered
 * page (like facebook/amazon parsers), with a schema.org `QAPage` JSON-LD fallback for any render
 * that still ships it. Walking the DOM and applying ordered fallbacks is inherently imperative; the
 * surrounding QuoraClient re-wraps results into Either. Mirrors amazon/parsers.ts.
 */
import * as cheerio from "cheerio"

import type { QuoraAnswer, QuoraComment, QuoraQuestion, QuoraQuestionWithAnswers } from "./types"

type Api = cheerio.CheerioAPI
type Node = any

const QUORA_ORIGIN = "https://www.quora.com"

/** Path prefixes that are NOT question slugs (topics, spaces, profiles, app routes, …). */
const RESERVED_PREFIXES = new Set([
  "topic",
  "q",
  "profile",
  "search",
  "unanswered",
  "following",
  "answer",
  "about",
  "contact",
  "careers",
  "sitemap",
  "partners",
  "login",
  "signup",
  "settings",
  "notifications",
  "messages",
  "stats",
  "share",
  "embed",
  "widgets",
  "challenges",
  "business",
  "ads",
  "ad",
  "press",
  "qemail",
  "webfonts",
  "api",
  "_",
])

/** Collapse whitespace and trim a raw text fragment. */
export function cleanText(input: string): string {
  return input
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** Turn an HTML fragment (Quora JSON-LD answer bodies arrive as HTML) into clean plain text. */
export function stripHtml(html: string): string {
  if (html === "") {
    return ""
  }
  const spaced = html.replace(/<\/(p|div|br|li)>/gi, " ").replace(/<br\s*\/?>/gi, " ")
  return cleanText(cheerio.load(`<root>${spaced}</root>`)("root").text())
}

/** Extract a Quora question slug from any Quora URL or a bare slug. */
export function extractSlug(input: string): string | undefined {
  const trimmed = input.trim()
  if (trimmed === "") {
    return undefined
  }
  const urlMatch = trimmed.match(/quora\.com\/([^/?#]+)/i)
  if (urlMatch !== null) {
    const seg = decodeURIComponent(urlMatch[1])
    return RESERVED_PREFIXES.has(seg.toLowerCase()) ? undefined : seg
  }
  if (/^[^/?#\s]+$/.test(trimmed) && !RESERVED_PREFIXES.has(trimmed.toLowerCase())) {
    return trimmed
  }
  return undefined
}

/** Build the canonical question page URL from a slug. */
export function buildQuestionUrl(slug: string): string {
  return `${QUORA_ORIGIN}/${encodeURIComponent(slug).replace(/%2F/gi, "/")}`
}

/** Build a Quora search URL filtered to questions. */
export function buildSearchUrl(query: string): string {
  return `${QUORA_ORIGIN}/search?q=${encodeURIComponent(query.trim())}&type=question`
}

/** Build a topic feed URL from a topic name/slug or a topic/space URL. */
export function buildTopicUrl(topic: string): string {
  const trimmed = topic.trim()
  if (/quora\.com\/(topic|q)\//i.test(trimmed)) {
    return trimmed.startsWith("http") ? trimmed : `https://${trimmed.replace(/^\/+/, "")}`
  }
  if (/^q\//i.test(trimmed)) {
    return `${QUORA_ORIGIN}/${trimmed.replace(/^\/+/, "")}`
  }
  const slug = trimmed.replace(/^\/+/, "").replace(/\s+/g, "-")
  return `${QUORA_ORIGIN}/topic/${encodeURIComponent(slug).replace(/%2F/gi, "/")}`
}

/** Prefix a root-relative Quora href with the origin; pass through absolute URLs. */
function absolutize(href: string | undefined): string | undefined {
  if (href === undefined || href === "") {
    return undefined
  }
  if (href.startsWith("http")) {
    return href
  }
  return href.startsWith("/") ? `${QUORA_ORIGIN}${href}` : href
}

/** Humanize a `/profile/<slug>` href into a display name (strip the disambiguation suffix). */
function humanizeProfile(href: string | undefined): string | undefined {
  if (href === undefined) {
    return undefined
  }
  const m = href.match(/\/profile\/([^/?#]+)/)
  if (m === null) {
    return undefined
  }
  const name = cleanText(decodeURIComponent(m[1]).replace(/-\d+$/, "").replace(/-/g, " "))
  return name !== "" ? name : undefined
}

/** Parse a "1.2K" / "12,345" style count into a number. */
function parseCount(raw: string): number | undefined {
  const m = raw.replace(/,/g, "").match(/^([\d.]+)\s*([KMB])?$/i)
  if (m === null) {
    return undefined
  }
  const n = Number(m[1])
  if (!Number.isFinite(n)) {
    return undefined
  }
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] ?? "").toLowerCase()] ?? 1
  return Math.round(n * mult)
}

const DATE_RE =
  /\b(?:\d{1,2}\s+)?(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s*\d{0,4}\b|\b\d+[a-z]{0,2}\s+ago\b|\bUpdated\b/i

/** Best-effort: pull a human date label ("Mar 23", "2y ago") from the answer item's links. */
function parseAnswerDate($: Api, el: Node): string | undefined {
  let found: string | undefined
  $(el)
    .find('a[href*="/answer/"], a[href*="/log/"], time')
    .each((_, a) => {
      if (found !== undefined) {
        return
      }
      const t = cleanText($(a).text())
      if (t !== "" && DATE_RE.test(t)) {
        found = t
      }
    })
  return found
}

/** Best-effort: read the upvote count near the answer's Upvote control (often hidden logged-out). */
function parseUpvotes($: Api, el: Node): number | undefined {
  let votes: number | undefined
  $(el)
    .find('[aria-label*="pvote"], [class*="upvote"]')
    .each((_, btn) => {
      if (votes !== undefined) {
        return
      }
      const label = $(btn).attr("aria-label") ?? ""
      const fromLabel = label.match(/([\d.,]+\s*[KMB]?)\s*upvote/i)
      if (fromLabel !== null) {
        votes = parseCount(cleanText(fromLabel[1]))
        return
      }
      const txt = cleanText($(btn).text())
      if (/^[\d.,]+\s*[KMB]?$/.test(txt)) {
        votes = parseCount(txt)
      }
    })
  return votes
}

/**
 * Clean a raw answer-content string. Quora renders a truncated preview, a "Continue Reading"
 * control, AND the full expanded text inside the same content node, so the raw text duplicates the
 * answer. Splitting on the control and keeping the longest segment yields the full answer once;
 * trailing "(more)" affordances are trimmed too.
 */
function cleanAnswerBody(raw: string): string {
  const segments = raw
    .split(/Continue Reading/i)
    .map((s) => s.trim())
    .filter((s) => s !== "")
  const best = segments.length > 0 ? segments.reduce((a, b) => (b.length > a.length ? b : a)) : raw
  return best.replace(/\s*\(more\)\s*$/i, "").trim()
}

/** Parse one rendered answer item (a `dom_annotate_question_answer_item_N` wrapper). */
function parseAnswerItem($: Api, el: Node, questionUrl: string): QuoraAnswer | undefined {
  const $el = $(el)
  const body = cleanAnswerBody(cleanText($el.find(".spacing_log_answer_content").first().text()))
  if (body === "") {
    return undefined
  }
  const profile = $el.find('a[href*="/profile/"]').first()
  const authorHref = profile.attr("href")
  const linkName = cleanText(profile.text())
  // Quora often renders the name in a child node the link text misses, so fall back to the slug.
  const author = linkName !== "" ? linkName : (humanizeProfile(authorHref) ?? "Anonymous")
  const permalink = absolutize($el.find('a[href*="/answer/"]').first().attr("href"))
  return {
    id: permalink ?? `${author}|${body.slice(0, 40)}`,
    author,
    authorUrl: absolutize(authorHref),
    body,
    upvotes: parseUpvotes($, el),
    date: parseAnswerDate($, el),
    permalink: permalink ?? questionUrl,
  }
}

/** Parse all answers from the browser-rendered DOM, de-duped by id. */
function parseAnswerItemsFromDom($: Api, questionUrl: string): QuoraAnswer[] {
  const answers: QuoraAnswer[] = []
  const seen = new Set<string>()
  $('[class*="dom_annotate_question_answer_item"]').each((_, el) => {
    const answer = parseAnswerItem($, el, questionUrl)
    if (answer !== undefined && !seen.has(answer.id)) {
      seen.add(answer.id)
      answers.push(answer)
    }
  })
  return answers
}

/** Read the reported answer count from the rendered DOM ("53 Answers"), best-effort. */
function parseAnswerCount($: Api): number | undefined {
  let count: number | undefined
  $("div, span, h2, h3").each((_, el) => {
    if (count !== undefined) {
      return
    }
    const m = cleanText($(el).text()).match(/^([\d.,]+)\s+Answers?$/i)
    if (m !== null) {
      count = parseCount(m[1])
    }
  })
  return count
}

/** Pull the `og:title` (or <title>) as the question title. */
function parseOgTitle($: Api): string {
  const og = $('meta[property="og:title"]').attr("content")
  const raw = og !== undefined && og !== "" ? og : $("title").first().text()
  return cleanText(raw.replace(/\s*-\s*Quora\s*$/i, ""))
}

// ───────────────────────── schema.org JSON-LD fallback ─────────────────────────

function findJsonLdBlocks($: Api): Node[] {
  const blocks: Node[] = []
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text().trim()
    if (raw === "") {
      return
    }
    try {
      blocks.push(JSON.parse(raw))
    } catch {
      // Quora occasionally emits invalid JSON-LD; ignore those blocks.
    }
  })
  return blocks
}

function isQuestionNode(node: Node): boolean {
  if (node === null || typeof node !== "object") {
    return false
  }
  const type = node["@type"]
  const types = Array.isArray(type) ? type : [type]
  return types.some((t) => typeof t === "string" && /question/i.test(t))
}

function locateQuestionNode(root: Node): Node | undefined {
  const stack: Node[] = [root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === null || typeof node !== "object") {
      continue
    }
    if (isQuestionNode(node)) {
      return node
    }
    for (const value of Object.values(node)) {
      if (value !== null && typeof value === "object") {
        stack.push(value)
      }
    }
  }
  return undefined
}

function jsonLdAuthorName(answer: Node): string {
  const author = answer?.author
  if (author === undefined || author === null) {
    return "Anonymous"
  }
  if (typeof author === "string") {
    return cleanText(author) || "Anonymous"
  }
  return cleanText(String(author.name ?? "")) || "Anonymous"
}

function numberOrUndefined(value: Node): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN
  return Number.isFinite(n) ? n : undefined
}

function jsonLdComments(answer: Node): QuoraComment[] {
  const raw = answer?.comment
  const list = Array.isArray(raw) ? raw : raw !== undefined ? [raw] : []
  const out: QuoraComment[] = []
  for (const c of list) {
    if (c === null || typeof c !== "object") {
      continue
    }
    const body = stripHtml(String(c.text ?? ""))
    if (body !== "") {
      out.push({ author: jsonLdAuthorName(c), body, upvotes: numberOrUndefined(c.upvoteCount) })
    }
  }
  return out
}

function jsonLdAnswer(answer: Node, questionUrl: string): QuoraAnswer | undefined {
  if (answer === null || typeof answer !== "object") {
    return undefined
  }
  const body = stripHtml(String(answer.text ?? ""))
  if (body === "") {
    return undefined
  }
  const permalink = typeof answer.url === "string" && answer.url !== "" ? answer.url : undefined
  const comments = jsonLdComments(answer)
  const authorUrl = answer?.author?.url
  return {
    id: permalink ?? `${jsonLdAuthorName(answer)}|${body.slice(0, 32)}`,
    author: jsonLdAuthorName(answer),
    authorUrl: typeof authorUrl === "string" && authorUrl !== "" ? authorUrl : undefined,
    body,
    upvotes: numberOrUndefined(answer.upvoteCount),
    date: typeof answer.dateCreated === "string" ? answer.dateCreated : undefined,
    permalink: permalink ?? questionUrl,
    comments: comments.length > 0 ? comments : undefined,
  }
}

function parseQuestionJsonLd($: Api, slug: string, url: string): QuoraQuestionWithAnswers | undefined {
  for (const block of findJsonLdBlocks($)) {
    const node = locateQuestionNode(block)
    if (node === undefined) {
      continue
    }
    const title = cleanText(String(node.name ?? node.text ?? "")) || slug.replace(/-/g, " ")
    const accepted = node.acceptedAnswer
    const acceptedList = Array.isArray(accepted) ? accepted : accepted !== undefined ? [accepted] : []
    const suggested = Array.isArray(node.suggestedAnswer) ? node.suggestedAnswer : []
    const answers: QuoraAnswer[] = []
    const seen = new Set<string>()
    for (const raw of [...acceptedList, ...suggested]) {
      const answer = jsonLdAnswer(raw, url)
      if (answer !== undefined && !seen.has(answer.id)) {
        seen.add(answer.id)
        answers.push(answer)
      }
    }
    return { question: { slug, title, url, answerCount: numberOrUndefined(node.answerCount) }, answers }
  }
  return undefined
}

// ───────────────────────────── public entry points ─────────────────────────────

/**
 * Parse a Quora question page into the question metadata + its answers. Primary path: the
 * browser-rendered DOM (each answer in a `dom_annotate_question_answer_item_N` wrapper); fallback:
 * schema.org `QAPage` JSON-LD for any render that still ships it.
 */
export function parseQuestionPage(html: string, requestedUrl: string): QuoraQuestionWithAnswers {
  const $ = cheerio.load(html)
  const slug = extractSlug(requestedUrl) ?? requestedUrl
  const url = buildQuestionUrl(slug)
  const title = parseOgTitle($) || slug.replace(/-/g, " ")

  const domAnswers = parseAnswerItemsFromDom($, url)
  if (domAnswers.length > 0) {
    return { question: { slug, title, url, answerCount: parseAnswerCount($) }, answers: domAnswers }
  }

  const jsonLd = parseQuestionJsonLd($, slug, url)
  if (jsonLd !== undefined && jsonLd.answers.length > 0) {
    return jsonLd
  }

  return { question: { slug, title, url, answerCount: parseAnswerCount($) }, answers: [] }
}

/**
 * Parse a Quora search or topic page into question cards. Quora exposes these as anchor links to
 * question slugs (single path segment, hyphenated, not a reserved route); this scans + de-dupes
 * them. Most reliable via the browser engine with a logged-in session.
 */
export function parseQuestionCards(html: string): QuoraQuestion[] {
  const $ = cheerio.load(html)
  // A slug can be linked by several anchors (the question title, but also answer date/byline
  // links). Collect the best title per slug: prefer a question-like anchor, else humanize the slug.
  const bestTitle = new Map<string, string>()

  $("a[href]").each((_, el) => {
    const slug = questionSlugFromHref($(el).attr("href") ?? "")
    if (slug === undefined) {
      return
    }
    const text = cleanText($(el).text())
    const looksLikeQuestion =
      (text.includes("?") || text.length >= 15) &&
      !DATE_RE.test(text) &&
      !/^(Bijgewerkt|Updated|Beantwoord)/i.test(text)
    if (!bestTitle.has(slug)) {
      bestTitle.set(slug, looksLikeQuestion ? text : "")
    } else if (bestTitle.get(slug) === "" && looksLikeQuestion) {
      bestTitle.set(slug, text)
    }
  })

  return Array.from(bestTitle.entries()).map(([slug, title]) => ({
    slug,
    title: title !== "" ? title : slug.replace(/-/g, " "),
    url: buildQuestionUrl(slug),
  }))
}

/** Extract a question slug from an href if it points at a question (else undefined). */
function questionSlugFromHref(href: string): string | undefined {
  const m = href.match(/^(?:https?:\/\/[^/]*quora\.com)?\/([^/?#]+)(?:[/?#]|$)/i)
  if (m === null) {
    return undefined
  }
  const seg = decodeURIComponent(m[1])
  if (RESERVED_PREFIXES.has(seg.toLowerCase()) || !seg.includes("-")) {
    return undefined
  }
  return seg
}

/**
 * Derive the Quora language subdomain host (e.g. `nl.quora.com`) from a session cookie header.
 * Quora stamps the account's UI language in an `m-ql10n_<lang>` cookie; when the account default
 * differs from the requested page language, Quora redirects to a `/join` "add language"
 * interstitial that blocks search/topic feeds. Navigating on the account's own language subdomain
 * avoids it. English stays on `www`. Returns undefined when no language cookie is present.
 */
export function quoraHostForCookie(cookieHeader: string | undefined): string | undefined {
  if (cookieHeader === undefined || cookieHeader === "") {
    return undefined
  }
  const m = cookieHeader.match(/(?:^|;\s*)m-ql10n_([a-z]{2})=/i)
  if (m === null) {
    return undefined
  }
  const lang = m[1].toLowerCase()
  return lang === "en" ? undefined : `${lang}.quora.com`
}

/**
 * Rewrite a `www.quora.com`/`quora.com` URL onto a language subdomain host. Only the gated feeds
 * (search / topic / Space) are localized - they're what trigger the "add language" interstitial.
 * Question pages are language-specific slugs that 404 ("Fout"/"Error") on the wrong subdomain, so
 * they're left on their canonical host. No-op when host is undefined.
 */
export function localizeQuoraUrl(url: string, host: string | undefined): string {
  if (host === undefined || !/\/(search\b|topic\/|q\/)/i.test(url)) {
    return url
  }
  return url.replace(/^(https?:\/\/)(?:www\.)?quora\.com/i, `$1${host}`)
}

/** Heuristic: does this HTML look like Quora's login wall with no readable answers? */
export function looksLoginGated(html: string, parsedAnswers: number): boolean {
  if (parsedAnswers > 0) {
    return false
  }
  return /(Continue with Google|Continue with Facebook|Login to Quora|loginModal|We value your privacy)/i.test(
    html.slice(0, 30000),
  )
}

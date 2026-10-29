import { writeFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"

import crypto from "crypto"
import dotenv from "dotenv"
import { FastMCP } from "fastmcp"
import { Option } from "functype"
import { z } from "zod"

import { getAmazonClient, initializeAmazonClient } from "./amazon/amazon-client"
import { buildAmazonSessionFromCookie } from "./amazon/cookies"
import { formatProduct, formatProductSearch, formatProductWithReviews } from "./amazon/format"
import type { AmazonApiProvider, AmazonEngine, AmazonReviewSort, AmazonSession, AmazonStarFilter } from "./amazon/types"
import { getRedditClient, initializeRedditClient } from "./client/reddit-client"
import {
  type BrowserKey,
  extractAmazonCookieHeader,
  extractFacebookSession,
  extractMetaAdsCookieHeader,
  extractQuoraCookieHeader,
  extractRedditCookieHeader,
} from "./facebook/cookie-extractor"
import { buildSessionFromCookies, buildSessionFromParts } from "./facebook/cookies"
import { isPlaywrightAvailable } from "./facebook/engines"
import { getFacebookClient, initializeFacebookClient } from "./facebook/facebook-client"
import { formatFeed, formatGroupInfo, formatGroupSearch, formatPostComments } from "./facebook/format"
import type { FacebookEngine, FacebookSession } from "./facebook/types"
import { buildMetaAdsSessionFromCookie } from "./meta-ads/cookies"
import { formatAdvertiserAds, formatBrands, formatDownloadManifest } from "./meta-ads/format"
import { getMetaAdsClient, initializeMetaAdsClient } from "./meta-ads/meta-ads-client"
import type {
  MetaAdActiveStatus,
  MetaAdMediaType,
  MetaAdPlatform,
  MetaAdsApiProvider,
  MetaAdsEngine,
  MetaAdSort,
  MetaAdsSession,
  MetaDownloadWhat,
  MetaTranscribeMode,
} from "./meta-ads/types"
import { buildPersonaBrief, classifyComment, isValuableComment, mineVoiceOfCustomer } from "./persona/schwartz"
import { buildQuoraSessionFromCookie } from "./quora/cookies"
import { formatQuestionCards, formatQuestionWithAnswers } from "./quora/format"
import { buildTopicUrl } from "./quora/parsers"
import { getQuoraClient, initializeQuoraClient } from "./quora/quora-client"
import type { QuoraEngine, QuoraQuestionWithAnswers, QuoraSession } from "./quora/types"
import type {
  BotDisclosureConfig,
  CacheConfig,
  FormattedPostInfo,
  Page,
  RedditAuthMode,
  RedditPost,
  RedditSafeMode,
  RetryConfig,
  SafeModeConfig,
  UserContent,
} from "./types"
import { toCsv } from "./utils/csv"
import { formatCommentInfo, formatPostInfo, formatSubredditInfo, formatUserInfo } from "./utils/formatters"

// A current desktop Chrome UA - used for Facebook fetches when none is provided.
const DEFAULT_FACEBOOK_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

// A current desktop Chrome UA - used for Amazon fetches when none is provided.
const DEFAULT_AMAZON_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

// A current desktop Chrome UA - used for Quora fetches when none is provided.
const DEFAULT_QUORA_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

// Load environment variables
dotenv.config({ quiet: true })

// Version injected at build time by tsdown
declare const __VERSION__: string
const VERSION = (typeof __VERSION__ !== "undefined" ? __VERSION__ : "0.0.0-dev") as `${number}.${number}.${number}`

// User-Agent validation and building
function validateUserAgent(userAgent: string, username?: string): void {
  const recommendedPattern = /^[\w-]+:[\w-]+:[\d.]+ \(by \/u\/\w+\)$/
  if (!recommendedPattern.test(userAgent)) {
    console.error("[Warning] User-Agent does not follow Reddit's recommended format")
    console.error("[Warning] Recommended: 'platform:app_id:version (by /u/username)'")
    console.error("[Warning] Non-standard User-Agents may increase ban risk")
    if (username !== undefined) {
      console.error(`[Warning] Consider using: 'typescript:reddit-mcp-server:${VERSION} (by /u/${username})'`)
    }
  }
}

function buildUserAgent(customAgent?: string, username?: string): string {
  if (customAgent !== undefined) {
    validateUserAgent(customAgent, username)
    return customAgent
  }

  if (username !== undefined) {
    const autoAgent = `typescript:reddit-mcp-server:${VERSION} (by /u/${username})`
    console.error(`[Setup] Auto-generated User-Agent: ${autoAgent}`)
    return autoAgent
  }

  const fallbackAgent = `typescript:reddit-mcp-server:${VERSION} (by /u/anonymous)`
  console.error(
    "[Setup] No REDDIT_USERNAME set - using anonymous User-Agent. Set REDDIT_USERNAME for a personalized agent.",
  )
  return fallbackAgent
}

// Safe mode configuration
function buildSafeModeConfig(safeMode: RedditSafeMode): SafeModeConfig {
  switch (safeMode) {
    case "off":
      return {
        enabled: false,
        mode: "off",
        writeDelayMs: 0,
        duplicateCheck: false,
        maxRecentHashes: 10,
      }
    case "standard":
      return {
        enabled: true,
        mode: "standard",
        writeDelayMs: 2000,
        duplicateCheck: true,
        maxRecentHashes: 10,
      }
    case "strict":
      return {
        enabled: true,
        mode: "strict",
        writeDelayMs: 5000,
        duplicateCheck: true,
        maxRecentHashes: 20,
      }
  }
}

function unwrapClient() {
  return getRedditClient().orThrow(new Error("Reddit client not initialized"))
}

function unwrapFacebookClient() {
  return getFacebookClient().orThrow(
    new Error("Facebook client not initialized - restart the server with Facebook support enabled."),
  )
}

function unwrapAmazonClient() {
  return getAmazonClient().orThrow(
    new Error("Amazon client not initialized - restart the server with Amazon support enabled."),
  )
}

function unwrapMetaAdsClient() {
  return getMetaAdsClient().orThrow(
    new Error("Meta Ad Library client not initialized - restart the server with Meta Ads support enabled."),
  )
}

function unwrapQuoraClient() {
  return getQuoraClient().orThrow(
    new Error("Quora client not initialized - restart the server with Quora support enabled."),
  )
}

// Build a Facebook session from env: explicit cookie, discrete parts, or - when
// FACEBOOK_COOKIE_FROM is set - auto-extracted from a locally logged-in browser.
async function resolveFacebookSession(): Promise<FacebookSession | undefined> {
  const cookie = process.env.FACEBOOK_COOKIE
  if (cookie !== undefined && cookie.trim() !== "") {
    return buildSessionFromCookies(cookie).fold(
      (err) => {
        console.error(`[Facebook] ${err.message}`)
        return undefined
      },
      (session) => session,
    )
  }

  const cUser = process.env.FACEBOOK_C_USER
  const xs = process.env.FACEBOOK_XS
  if (cUser !== undefined || xs !== undefined) {
    return buildSessionFromParts({ cUser, xs, datr: process.env.FACEBOOK_DATR }).fold(
      (err) => {
        console.error(`[Facebook] ${err.message}`)
        return undefined
      },
      (session) => session,
    )
  }

  // Auto-pickup from a logged-in browser (e.g. FACEBOOK_COOKIE_FROM=chrome).
  const from = process.env.FACEBOOK_COOKIE_FROM
  if (from !== undefined && from.trim() !== "") {
    try {
      const { session, cookieNames } = await extractFacebookSession({
        browser: from.trim() as BrowserKey,
        profile: process.env.FACEBOOK_COOKIE_FROM_PROFILE ?? "Default",
      })
      console.error(`[Facebook] ✓ Auto-loaded session from ${from} (${cookieNames.length} cookies)`)
      return session
    } catch (err) {
      console.error(
        `[Facebook] Could not auto-read cookies from ${from}: ${err instanceof Error ? err.message : String(err)}`,
      )
      return undefined
    }
  }

  return undefined
}

// Initialize the Facebook scraping client (always available; auth via session cookies).
async function setupFacebookClient(): Promise<void> {
  const engine = (process.env.FACEBOOK_ENGINE ?? "auto") as FacebookEngine
  if (!["auto", "http", "browser"].includes(engine)) {
    console.error(`[Error] Invalid FACEBOOK_ENGINE: ${engine}`)
    console.error("[Error] Valid options are: auto, http, browser")
    process.exit(1)
  }

  const session = await resolveFacebookSession()
  const minDelayRaw = Number(process.env.FACEBOOK_MIN_DELAY_MS ?? "4000")
  const cacheEnabled = (process.env.FACEBOOK_CACHE ?? "on") !== "off"
  const cacheMaxMb = Number(process.env.FACEBOOK_CACHE_MAX_MB ?? "50")

  initializeFacebookClient({
    session,
    engine,
    userAgent: process.env.FACEBOOK_USER_AGENT ?? DEFAULT_FACEBOOK_UA,
    minDelayMs: Number.isFinite(minDelayRaw) && minDelayRaw >= 0 ? minDelayRaw : 4000,
    headless: (process.env.FACEBOOK_HEADLESS ?? "true") !== "false",
    locale: process.env.FACEBOOK_LOCALE ?? "en_US",
    cache: {
      enabled: cacheEnabled,
      maxBytes: (Number.isFinite(cacheMaxMb) && cacheMaxMb > 0 ? cacheMaxMb : 50) * 1024 * 1024,
    },
  })

  console.error("[Setup] Facebook client initialized")
  console.error(`[Setup] Facebook engine: ${engine}`)
  if (session !== undefined) {
    console.error(`[Setup] ✓ Facebook session loaded (c_user=${session.cUser}) - private groups accessible if joined`)
  } else {
    console.error("[Setup] Facebook: no session cookies - only limited public reads will work")
    console.error("[Setup] Set FACEBOOK_COOKIE (full cookie header) to scrape groups you are a member of")
  }

  if (engine === "browser" || engine === "auto") {
    const hasPlaywright = await isPlaywrightAvailable()
    if (hasPlaywright) {
      console.error("[Setup] ✓ Playwright detected - browser engine available (best for private groups)")
    } else if (engine === "browser") {
      console.error("[Setup] ✗ FACEBOOK_ENGINE=browser but Playwright is not installed")
      console.error("[Setup]   Install with: npm install playwright && npx playwright install chromium")
    } else {
      console.error("[Setup] Playwright not installed - Facebook will use the lightweight HTTP engine")
      console.error(
        "[Setup]   For private groups & full comments: npm install playwright && npx playwright install chromium",
      )
    }
  }
}

// Build an Amazon session from env: an explicit cookie header, or - when AMAZON_COOKIE_FROM is
// set - auto-extracted from a locally logged-in browser (macOS/Linux). A session is optional:
// without one, only the first (public) pages of reviews are reachable.
async function resolveAmazonSession(): Promise<AmazonSession | undefined> {
  const cookie = process.env.AMAZON_COOKIE
  if (cookie !== undefined && cookie.trim() !== "") {
    return buildAmazonSessionFromCookie(cookie).fold(
      (err) => {
        console.error(`[Amazon] ${err.message}`)
        return undefined
      },
      (session) => session,
    )
  }

  const from = process.env.AMAZON_COOKIE_FROM
  if (from !== undefined && from.trim() !== "") {
    try {
      const header = await extractAmazonCookieHeader({
        browser: from.trim() as BrowserKey,
        profile: process.env.AMAZON_COOKIE_FROM_PROFILE ?? process.env.FACEBOOK_COOKIE_FROM_PROFILE ?? "Default",
      })
      if (header === "") {
        console.error(`[Amazon] No amazon.com cookies found in ${from} (log in to amazon.com in that browser first).`)
        return undefined
      }
      return buildAmazonSessionFromCookie(header).fold(
        (err) => {
          console.error(`[Amazon] ${err.message}`)
          return undefined
        },
        (session) => {
          console.error(`[Amazon] ✓ Auto-loaded session cookies from ${from}`)
          return session
        },
      )
    } catch (err) {
      console.error(
        `[Amazon] Could not auto-read cookies from ${from}: ${err instanceof Error ? err.message : String(err)}`,
      )
      return undefined
    }
  }

  return undefined
}

// Initialize the Amazon reviews scraping client (always available; depth via cookies or a paid API).
async function setupAmazonClient(): Promise<void> {
  const engine = (process.env.AMAZON_ENGINE ?? "auto") as AmazonEngine
  if (!["auto", "http", "browser", "api"].includes(engine)) {
    console.error(`[Error] Invalid AMAZON_ENGINE: ${engine}`)
    console.error("[Error] Valid options are: auto, http, browser, api")
    process.exit(1)
  }

  const session = await resolveAmazonSession()
  const minDelayRaw = Number(process.env.AMAZON_MIN_DELAY_MS ?? "3000")
  const maxPagesRaw = Number(process.env.AMAZON_MAX_REVIEW_PAGES ?? "10")
  const cacheEnabled = (process.env.AMAZON_CACHE ?? "on") !== "off"
  const cacheMaxMb = Number(process.env.AMAZON_CACHE_MAX_MB ?? "50")

  // Optional paid reviews API (the most reliable path).
  const apiKey = process.env.AMAZON_API_KEY
  const apiProvider = (process.env.AMAZON_API_PROVIDER ?? "unwrangle") as AmazonApiProvider
  const api = apiKey !== undefined && apiKey.trim() !== "" ? { provider: apiProvider, key: apiKey.trim() } : undefined
  if (api !== undefined && !["unwrangle", "rainforest"].includes(apiProvider)) {
    console.error(`[Error] Invalid AMAZON_API_PROVIDER: ${apiProvider} (valid: unwrangle, rainforest)`)
    process.exit(1)
  }

  initializeAmazonClient({
    session,
    engine,
    marketplace: (process.env.AMAZON_MARKETPLACE ?? "com").replace(/^amazon\./i, ""),
    userAgent: process.env.AMAZON_USER_AGENT ?? DEFAULT_AMAZON_UA,
    minDelayMs: Number.isFinite(minDelayRaw) && minDelayRaw >= 0 ? minDelayRaw : 3000,
    headless: (process.env.AMAZON_HEADLESS ?? "true") !== "false",
    locale: process.env.AMAZON_LOCALE ?? "en_US",
    maxReviewPages: Number.isFinite(maxPagesRaw) && maxPagesRaw > 0 ? Math.min(maxPagesRaw, 100) : 10,
    api,
    cache: {
      enabled: cacheEnabled,
      maxBytes: (Number.isFinite(cacheMaxMb) && cacheMaxMb > 0 ? cacheMaxMb : 50) * 1024 * 1024,
    },
  })

  console.error("[Setup] Amazon client initialized")
  console.error(`[Setup] Amazon engine: ${engine}`)
  if (api !== undefined) {
    console.error(`[Setup] ✓ Amazon reviews API configured (${apiProvider}) - most reliable path`)
  } else if (session !== undefined) {
    console.error("[Setup] ✓ Amazon session cookies loaded - can page deeper into review history")
  } else {
    console.error("[Setup] Amazon: no session/API - the HTTP engine reads the first (public) pages of reviews")
    console.error("[Setup]   For depth: set AMAZON_COOKIE (logged-in header) or AMAZON_API_KEY (reviews API)")
  }
}

// Build a Quora session from env: an explicit cookie header, or - when QUORA_COOKIE_FROM is set -
// auto-extracted from a locally logged-in browser (macOS/Linux). A session is optional: without
// one, only a question's first (public) answers are reliably reachable.
async function resolveQuoraSession(): Promise<QuoraSession | undefined> {
  const cookie = process.env.QUORA_COOKIE
  if (cookie !== undefined && cookie.trim() !== "") {
    return buildQuoraSessionFromCookie(cookie).fold(
      (err) => {
        console.error(`[Quora] ${err.message}`)
        return undefined
      },
      (session) => session,
    )
  }

  const from = process.env.QUORA_COOKIE_FROM
  if (from !== undefined && from.trim() !== "") {
    try {
      const header = await extractQuoraCookieHeader({
        browser: from.trim() as BrowserKey,
        profile: process.env.QUORA_COOKIE_FROM_PROFILE ?? process.env.FACEBOOK_COOKIE_FROM_PROFILE ?? "Default",
      })
      if (header === "") {
        console.error(`[Quora] No quora.com cookies found in ${from} (log in to quora.com in that browser first).`)
        return undefined
      }
      return buildQuoraSessionFromCookie(header).fold(
        (err) => {
          console.error(`[Quora] ${err.message}`)
          return undefined
        },
        (session) => {
          console.error(`[Quora] ✓ Auto-loaded session cookies from ${from}`)
          return session
        },
      )
    } catch (err) {
      console.error(
        `[Quora] Could not auto-read cookies from ${from}: ${err instanceof Error ? err.message : String(err)}`,
      )
      return undefined
    }
  }

  return undefined
}

// Initialize the Quora scraping client (always available; depth via a logged-in session cookie).
async function setupQuoraClient(): Promise<void> {
  const engine = (process.env.QUORA_ENGINE ?? "auto") as QuoraEngine
  if (!["auto", "http", "browser"].includes(engine)) {
    console.error(`[Error] Invalid QUORA_ENGINE: ${engine}`)
    console.error("[Error] Valid options are: auto, http, browser")
    process.exit(1)
  }

  const session = await resolveQuoraSession()
  const minDelayRaw = Number(process.env.QUORA_MIN_DELAY_MS ?? "5000")
  const cacheEnabled = (process.env.QUORA_CACHE ?? "on") !== "off"
  const cacheMaxMb = Number(process.env.QUORA_CACHE_MAX_MB ?? "50")

  initializeQuoraClient({
    session,
    engine,
    userAgent: process.env.QUORA_USER_AGENT ?? DEFAULT_QUORA_UA,
    minDelayMs: Number.isFinite(minDelayRaw) && minDelayRaw >= 0 ? minDelayRaw : 5000,
    headless: (process.env.QUORA_HEADLESS ?? "true") !== "false",
    locale: process.env.QUORA_LOCALE ?? "en_US",
    cache: {
      enabled: cacheEnabled,
      maxBytes: (Number.isFinite(cacheMaxMb) && cacheMaxMb > 0 ? cacheMaxMb : 50) * 1024 * 1024,
    },
  })

  console.error("[Setup] Quora client initialized")
  console.error(`[Setup] Quora engine: ${engine}`)
  if (session !== undefined) {
    console.error("[Setup] ✓ Quora session cookies loaded - can read deeper into answer threads")
  } else {
    console.error(
      "[Setup] Quora: no session - question pages parse from embedded JSON-LD; search/topic feeds are gated",
    )
    console.error("[Setup]   For depth: set QUORA_COOKIE (logged-in header) or run `pnpm run setup`")
  }
}

// Build a Meta Ad Library session: an explicit META_ADS_COOKIE, an auto-extracted one, or - by
// default - the same facebook.com login the Facebook module already uses (the Ad Library is public,
// so a session is optional and only smooths Meta's anti-bot defences).
async function resolveMetaAdsSession(): Promise<MetaAdsSession | undefined> {
  const cookie = process.env.META_ADS_COOKIE
  if (cookie !== undefined && cookie.trim() !== "") {
    return buildMetaAdsSessionFromCookie(cookie).fold(
      (err) => {
        console.error(`[MetaAds] ${err.message}`)
        return undefined
      },
      (session) => session,
    )
  }

  const from = process.env.META_ADS_COOKIE_FROM
  if (from !== undefined && from.trim() !== "") {
    try {
      const header = await extractMetaAdsCookieHeader({
        browser: from.trim() as BrowserKey,
        profile: process.env.META_ADS_COOKIE_FROM_PROFILE ?? process.env.FACEBOOK_COOKIE_FROM_PROFILE ?? "Default",
      })
      if (header !== "") {
        return buildMetaAdsSessionFromCookie(header).fold(
          () => undefined,
          (session) => {
            console.error(`[MetaAds] ✓ Auto-loaded cookies from ${from}`)
            return session
          },
        )
      }
    } catch (err) {
      console.error(
        `[MetaAds] Could not auto-read cookies from ${from}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  // Default: reuse the resolved Facebook session (same facebook.com login).
  const fb = await resolveFacebookSession()
  return fb !== undefined ? { cookieHeader: fb.cookieHeader } : undefined
}

// Initialize the Meta Ad Library scraping client (always available; the Ad Library is public).
async function setupMetaAdsClient(): Promise<void> {
  const engine = (process.env.META_ADS_ENGINE ?? "auto") as MetaAdsEngine
  if (!["auto", "http", "browser", "api"].includes(engine)) {
    console.error(`[Error] Invalid META_ADS_ENGINE: ${engine}`)
    console.error("[Error] Valid options are: auto, http, browser, api")
    process.exit(1)
  }

  const session = await resolveMetaAdsSession()
  const minDelayRaw = Number(process.env.META_ADS_MIN_DELAY_MS ?? "5000")
  const maxPagesRaw = Number(process.env.META_ADS_MAX_PAGES ?? "10")
  const cacheEnabled = (process.env.META_ADS_CACHE ?? "on") !== "off"
  const cacheMaxMb = Number(process.env.META_ADS_CACHE_MAX_MB ?? "50")

  // Optional paid Ad Library API (handles proxies + token rotation; the most reliable path at scale).
  const apiKey = process.env.META_ADS_API_KEY
  const apiProvider = (process.env.META_ADS_API_PROVIDER ?? "scrapecreators") as MetaAdsApiProvider
  const api = apiKey !== undefined && apiKey.trim() !== "" ? { provider: apiProvider, key: apiKey.trim() } : undefined
  if (api !== undefined && !["scrapecreators"].includes(apiProvider)) {
    console.error(`[Error] Invalid META_ADS_API_PROVIDER: ${apiProvider} (valid: scrapecreators)`)
    process.exit(1)
  }

  initializeMetaAdsClient({
    session,
    engine,
    country: process.env.META_ADS_COUNTRY ?? "US",
    userAgent: process.env.META_ADS_USER_AGENT ?? DEFAULT_FACEBOOK_UA,
    minDelayMs: Number.isFinite(minDelayRaw) && minDelayRaw >= 0 ? minDelayRaw : 5000,
    headless: (process.env.META_ADS_HEADLESS ?? "true") !== "false",
    locale: process.env.META_ADS_LOCALE ?? "en_US",
    maxPages: Number.isFinite(maxPagesRaw) && maxPagesRaw > 0 ? Math.min(maxPagesRaw, 50) : 10,
    api,
    cache: {
      enabled: cacheEnabled,
      maxBytes: (Number.isFinite(cacheMaxMb) && cacheMaxMb > 0 ? cacheMaxMb : 50) * 1024 * 1024,
    },
  })

  console.error("[Setup] Meta Ad Library client initialized")
  console.error(`[Setup] Meta Ads engine: ${engine}`)
  if (api !== undefined) {
    console.error(`[Setup] ✓ Meta Ads API configured (${apiProvider}) - most reliable path`)
  } else if (session !== undefined) {
    console.error("[Setup] ✓ Meta Ads session loaded (reuses your Facebook login) - smoother anti-bot")
  } else {
    console.error(
      "[Setup] Meta Ads: no session - the public Ad Library still works (a Facebook login improves reliability)",
    )
  }

  if (engine === "browser" || engine === "auto") {
    const hasPlaywright = await isPlaywrightAvailable()
    if (hasPlaywright) {
      console.error("[Setup] ✓ Playwright detected - Meta Ads browser engine available (most robust path)")
    } else if (engine === "browser") {
      console.error("[Setup] ✗ META_ADS_ENGINE=browser but Playwright is not installed")
      console.error("[Setup]   Install with: npm install playwright && npx playwright install chromium")
    } else {
      console.error(
        "[Setup] Playwright not installed - Meta Ads will use the brittle HTTP engine (set META_ADS_API_KEY for reliability)",
      )
    }
  }
}

const ARCHIVE_DISCLAIMER =
  "\n\n> **Archive mode** — from the Arctic Shift archive, a free third-party copy of Reddit, not Reddit's API. Scores and comment counts lag and are often 0 or 1 on recent posts, and recent comments may be missing. Set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET for live data."

// Footer naming where a page of results came from, plus any caveat the client attached.
function sourceDisclaimer(page: Page<unknown>): string {
  const notice = Option(page.notice).fold(
    () => "",
    (text) => `\n\n> **Note** — ${text}`,
  )
  if (page.source === "rss") {
    return `${notice}\n\n> **RSS mode** — scores, comment counts, and upvote ratios are unavailable. Set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET for full data.`
  }
  return page.source === "arctic" ? `${notice}${ARCHIVE_DISCLAIMER}` : notice
}

// Footer for single-item tools, which carry no page source: keyless reads come from the archive.
function archiveDisclaimer(client: { readonly keyless: boolean }): string {
  return client.keyless ? ARCHIVE_DISCLAIMER : ""
}

function formatPostSummary(post: FormattedPostInfo, index: number, source?: string): string {
  const statsLines =
    source === "rss" || source === "arctic"
      ? []
      : [
          `- Score: ${post.stats.score.toLocaleString()} (${(post.stats.upvoteRatio * 100).toFixed(1)}% upvoted)`,
          `- Comments: ${post.stats.comments.toLocaleString()}`,
        ]

  return [
    `### ${index + 1}. ${post.title}`,
    `- Author: u/${post.author}`,
    ...statsLines,
    `- Posted: ${post.metadata.posted}`,
    `- Link: ${post.links.shortLink}`,
  ].join("\n")
}

// Footer appended to paginated listings when more results are available.
function nextPageHint(after?: string): string {
  return Option(after).fold(
    () => "",
    (cursor) => `\n\n---\nMore results available — call again with after="${cursor}" for the next page.`,
  )
}

// Render a mixed posts+comments listing (saved / overview).
function formatUserContent(heading: string, content: UserContent): string {
  const postsSection =
    content.posts.length === 0
      ? ""
      : `## Posts (${content.posts.length})\n${content.posts
          .map(
            (post, index) =>
              `${index + 1}. ${post.title} — r/${post.subreddit}, score ${post.score.toLocaleString()} — https://reddit.com${post.permalink}`,
          )
          .join("\n")}\n\n`

  const commentsSection =
    content.comments.length === 0
      ? ""
      : `## Comments (${content.comments.length})\n${content.comments
          .map((comment, index) => {
            const formatted = formatCommentInfo(comment, 200)
            return `${index + 1}. in r/${comment.subreddit}: ${formatted.content} — ${formatted.link}`
          })
          .join("\n")}\n\n`

  const empty = content.posts.length === 0 && content.comments.length === 0 ? "No items found.\n\n" : ""

  return `# ${heading}\n\n${postsSection}${commentsSection}${empty}`.trimEnd() + nextPageHint(content.after)
}

// Initialize Reddit client
async function setupRedditClient() {
  const clientId = process.env.REDDIT_CLIENT_ID
  const clientSecret = process.env.REDDIT_CLIENT_SECRET
  const customUserAgent = process.env.REDDIT_USER_AGENT
  const username = process.env.REDDIT_USERNAME
  const password = process.env.REDDIT_PASSWORD
  const authMode = (process.env.REDDIT_AUTH_MODE ?? "auto") as RedditAuthMode
  const safeMode = (process.env.REDDIT_SAFE_MODE ?? "standard") as RedditSafeMode

  // Validate auth mode
  if (!["auto", "authenticated", "anonymous"].includes(authMode)) {
    console.error(`[Error] Invalid REDDIT_AUTH_MODE: ${authMode}`)
    console.error("[Error] Valid options are: auto, authenticated, anonymous")
    process.exit(1)
  }

  // Validate safe mode
  if (!["off", "standard", "strict"].includes(safeMode)) {
    console.error(`[Error] Invalid REDDIT_SAFE_MODE: ${safeMode}`)
    console.error("[Error] Valid options are: off, standard, strict")
    process.exit(1)
  }

  // In authenticated mode, require credentials
  if (authMode === "authenticated" && (clientId === undefined || clientSecret === undefined)) {
    console.error("[Error] Authenticated mode requires REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET")
    process.exit(1)
  }

  // For auto/anonymous, credentials are optional
  const hasCredentials = Boolean(clientId && clientSecret)

  // Build user-agent (auto-format with username if available)
  const userAgent = buildUserAgent(customUserAgent, username)

  // Build safe mode config
  const safeModeConfig = buildSafeModeConfig(safeMode)

  // Build bot disclosure config
  const botDisclosureMode = process.env.REDDIT_BOT_DISCLOSURE ?? "off"
  const defaultFooter =
    "\n\n---\n^(🤖 I am a bot | Built with) [^reddit-mcp-server](https://github.com/jordanburke/reddit-mcp-server)"
  const botDisclosureConfig: BotDisclosureConfig = {
    enabled: botDisclosureMode === "auto",
    footer: botDisclosureMode === "auto" ? (process.env.REDDIT_BOT_FOOTER ?? defaultFooter) : "",
  }

  // Build cache config (enabled by default to ease Reddit rate limits; opt out with REDDIT_CACHE=off)
  const cacheEnabled = (process.env.REDDIT_CACHE ?? "on") !== "off"
  const cacheMaxMb = Number(process.env.REDDIT_CACHE_MAX_MB ?? "50")
  const cacheConfig: CacheConfig = {
    enabled: cacheEnabled,
    maxBytes: (Number.isFinite(cacheMaxMb) && cacheMaxMb > 0 ? cacheMaxMb : 50) * 1024 * 1024,
  }

  // Reddit blocks anonymous JSON access from many networks (403). Replaying reddit.com cookies
  // from the user's browser bypasses that with no Reddit account or app. Prefer an explicit
  // REDDIT_COOKIE; otherwise auto-borrow from the browser when running anonymously.
  const envRedditCookie = process.env.REDDIT_COOKIE
  const isAnonymousReddit = authMode === "anonymous" || (authMode === "auto" && !hasCredentials)
  const needsBorrow = (envRedditCookie === undefined || envRedditCookie.trim() === "") && isAnonymousReddit
  const borrowedRedditCookie = needsBorrow
    ? await extractRedditCookieHeader({
        browser: (process.env.REDDIT_COOKIE_FROM ?? process.env.FACEBOOK_COOKIE_FROM ?? "chrome") as BrowserKey,
        profile: process.env.REDDIT_COOKIE_FROM_PROFILE ?? process.env.FACEBOOK_COOKIE_FROM_PROFILE ?? "Default",
      })
    : ""
  const redditCookie =
    envRedditCookie !== undefined && envRedditCookie.trim() !== "" ? envRedditCookie : borrowedRedditCookie
  if (needsBorrow && borrowedRedditCookie !== "") {
    console.error("[Setup] ✓ Reddit: borrowed browser cookies (bypasses anonymous 403)")
  }

  // Retry on HTTP 429 with Retry-After backoff (opt out with REDDIT_MAX_RETRIES=0)
  const maxRetriesRaw = Number(process.env.REDDIT_MAX_RETRIES ?? "3")
  const retryConfig: RetryConfig = {
    maxRetries: Number.isFinite(maxRetriesRaw) && maxRetriesRaw >= 0 ? Math.floor(maxRetriesRaw) : 3,
    baseDelayMs: 1000,
    maxDelayMs: 60_000,
  }

  const client = initializeRedditClient({
    clientId: clientId ?? "",
    clientSecret: clientSecret ?? "",
    userAgent,
    username,
    password,
    authMode,
    safeMode: safeModeConfig,
    botDisclosure: botDisclosureConfig,
    cache: cacheConfig,
    cookieHeader: redditCookie,
    retry: retryConfig,
  })

  console.error("[Setup] Reddit client initialized")
  console.error(`[Setup] Authentication mode: ${authMode}`)

  if (authMode === "anonymous") {
    console.error(
      "[Warning] REDDIT_AUTH_MODE=anonymous is deprecated; it is now an alias for auto without credentials.",
    )
  }

  if (authMode === "anonymous" || !hasCredentials) {
    console.error("[Setup] Keyless mode — no OAuth credentials detected.")
    console.error("[Setup] Reads come from RSS feeds (ranked listings, until Reddit retires them 2026-11-13)")
    console.error("[Setup] and the Arctic Shift archive (a free third-party Reddit archive; scores lag).")
    console.error("[Setup] Set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET for full API access (100 req/min).")
    console.error("[Setup] See: https://www.reddit.com/wiki/api")
  } else {
    console.error("[Setup] Testing Reddit API connection...")
    const isConnected = await client.checkAuthentication()

    if (!isConnected) {
      console.error("[Error] ✗ Failed to connect to Reddit API")
      console.error("[Error] Please check your REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET")
      process.exit(1)
    }

    console.error("[Setup] ✓ Reddit API connection successful")
    console.error("[Setup] Using OAuth Reddit API (60-100 req/min)")
  }

  if (username !== undefined && password !== undefined) {
    console.error(`[Setup] ✓ User authenticated as: ${username}`)
    console.error("[Setup] Write operations enabled (posting, replying, editing, deleting)")
  } else {
    console.error("[Setup] Read-only mode (no user credentials)")
    console.error("[Setup] For write operations, set REDDIT_USERNAME and REDDIT_PASSWORD")
  }

  // Log safe mode status
  if (safeModeConfig.enabled) {
    console.error(`[Setup] ✓ Safe mode enabled: ${safeModeConfig.mode}`)
    console.error(`[Setup]   - Write delay: ${safeModeConfig.writeDelayMs}ms between operations`)
    console.error(`[Setup]   - Duplicate detection: enabled (tracking last ${safeModeConfig.maxRecentHashes} items)`)
  } else {
    console.error(
      "[Setup] Safe mode: off (explicitly disabled - ensure compliance with Reddit's Responsible Builder Policy)",
    )
  }

  // Log bot disclosure status
  if (botDisclosureConfig.enabled) {
    console.error("[Setup] ✓ Bot disclosure: enabled (automated content will include bot footer)")
  } else {
    console.error("[Setup] Bot disclosure: off")
    console.error("[Setup] For Reddit policy compliance, consider REDDIT_BOT_DISCLOSURE=auto")
  }
}

// OAuth token: generate once at startup, never expose in responses
const oauthToken = process.env.OAUTH_TOKEN ?? crypto.randomBytes(32).toString("hex")
if (process.env.OAUTH_ENABLED === "true" && process.env.OAUTH_TOKEN === undefined) {
  console.error(`[Auth] Generated OAuth token: ${oauthToken}`)
}

// Create FastMCP server
const server = new FastMCP({
  name: "reddit-mcp-server",
  version: VERSION,
  instructions: `An e-commerce customer-research MCP server. It scrapes discussions from Reddit, Facebook
groups, Amazon product reviews, AND Quora Q&A, then turns them into customer personas using Eugene
Schwartz's "Breakthrough Advertising" framework.

Reddit capabilities:
- Fetch Reddit posts, comments, and user information
- Get subreddit details and statistics
- Search Reddit content across posts and subreddits
- Create posts and reply to posts/comments (with authentication)
- Edit your own posts and comments (with authentication)
- Save or unsave posts and comments (with authentication)
- Delete your own posts and comments (with authentication)
- Analyze engagement metrics and community insights

Facebook capabilities (tools prefixed facebook_*):
- Scrape posts from public AND private Facebook groups (private groups need a FACEBOOK_COOKIE session
  belonging to a member; the optional Playwright browser engine is most reliable)
- Scrape comment threads from Facebook posts
- Get group metadata and search for groups by niche
- Scrape public Facebook Page feeds

Amazon capabilities (tools prefixed amazon_*):
- Scrape customer reviews for any product by ASIN or product URL (star rating, title, body,
  verified-purchase flag, date, helpful votes) - a rich vein of voice-of-customer language
- Get product metadata + rating summary (average stars, total ratings, per-star distribution)
- The free HTTP engine reads the first public pages; for full review history set AMAZON_COOKIE
  (a logged-in session) or AMAZON_API_KEY (a reviews API: Unwrangle or Rainforest)

Quora capabilities (tools prefixed quora_*):
- Scrape a question and its answers by URL/slug (answer author, body, upvote count, date) - Quora
  questions are pure voice-of-customer: people literally stating their pains, desires and questions
- Search Quora for questions in a niche, or list the questions in a topic/Space
- Question pages parse from embedded JSON-LD even logged-out; search/topic feeds and deep answer
  threads are gated, so for those set QUORA_COOKIE from a logged-in browser (browser engine)

Customer-persona workflow (Schwartz "Breakthrough Advertising"):
- analyze_voice_of_customer: mine a corpus of comments/posts/reviews into pains, desires, objections,
  questions, emotional triggers, product mentions, and verbatim quotes
- build_customer_persona: assemble a persona brief organized by mass desire, the 5 awareness stages, and
  the 5 market-sophistication levels - then synthesize the persona from that evidence
- These persona tools are platform-agnostic: feed them text scraped from Reddit, Facebook, Amazon, Quora, or all.

For Reddit write operations (posting, replying, editing, deleting), ensure REDDIT_USERNAME and REDDIT_PASSWORD are configured.

IMPORTANT - research data ethics:
- Scraped discussion is for aggregate customer-persona research only. Do NOT de-anonymize, profile, or
  re-identify individuals, and do NOT republish people's verbatim posts/comments/reviews as-is.
- Respect Facebook's, Reddit's, Amazon's, and Quora's Terms; only access private groups you are
  legitimately a member of, and use your own logged-in session for any depth scraping.

IMPORTANT - Reddit Responsible Builder Policy compliance:
- Data retrieved via these tools must NOT be used for AI model training without Reddit's written approval
- Data must NOT be sold, licensed, or commercially redistributed
- Do NOT attempt to de-anonymize or re-identify Reddit users
- Do NOT post identical or substantially similar content across multiple subreddits
- Do NOT use these tools to manipulate votes, karma, or circumvent Reddit safety mechanisms
- All bot-generated content must clearly disclose its automated nature
- Bots must NOT send private/direct messages without explicit user consent
For details: https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy`,

  // Optional OAuth configuration for HTTP transport
  ...(process.env.OAUTH_ENABLED === "true" && {
    authenticate: (request: { readonly headers: { readonly authorization?: string } }) => {
      const authHeader = request.headers.authorization
      if (!authHeader?.startsWith("Bearer ")) {
        // eslint-disable-next-line functype/prefer-either
        throw new Response(null, {
          status: 401,
          statusText: "Missing or invalid Authorization header",
        })
      }

      const token = authHeader.slice(7)
      const tokenBuffer = Buffer.from(token)
      const expectedBuffer = Buffer.from(oauthToken)
      const tokenHash = crypto.createHash("sha256").update(tokenBuffer).digest()
      const expectedHash = crypto.createHash("sha256").update(expectedBuffer).digest()
      if (!crypto.timingSafeEqual(tokenHash, expectedHash)) {
        // eslint-disable-next-line functype/prefer-either
        throw new Response(null, {
          status: 403,
          statusText: "Invalid token",
        })
      }

      return Promise.resolve({ authenticated: true })
    },
  }),
})

// Test tool
server.addTool({
  name: "test_reddit_mcp_server",
  description:
    'Health check for the Reddit MCP server. Read-only and side-effect-free — inspects local configuration only and makes no Reddit API calls. Returns the server version, whether the Reddit client is initialized, whether OAuth credentials are present, and whether write access (REDDIT_USERNAME/REDDIT_PASSWORD) is configured. Use this first to diagnose setup/auth problems. Do NOT use it to check Reddit\'s own status or connectivity — it never contacts Reddit. A "✗ Write Access" result means the write tools (create_post, reply_to_post, edit_*, delete_*) will fail.',
  annotations: {
    title: "Test Reddit MCP Server",
    readOnlyHint: true,
    openWorldHint: false,
  },
  parameters: z.object({}),
  execute: () => {
    const client = getRedditClient()
    const hasAuth = client.fold(
      () => "✗",
      () => "✓",
    )
    const hasWriteAccess =
      process.env.REDDIT_USERNAME !== undefined && process.env.REDDIT_PASSWORD !== undefined ? "✓" : "✗"

    return Promise.resolve(`Reddit MCP Server Status:
- Server: ✓ Running
- Reddit Client: ${hasAuth} ${client.fold(
      () => "Not initialized",
      () => "Initialized",
    )}
- Read Source: ${client.fold(
      () => "Unknown",
      (c) => (c.keyless ? "Keyless (RSS feeds + Arctic Shift archive; scores lag)" : "Reddit API (OAuth)"),
    )}
- Write Access: ${hasWriteAccess} ${hasWriteAccess === "✓" ? "Available" : "Read-only mode"}
- Version: ${VERSION}

Ready to handle Reddit API requests!`)
  },
})

// User tools
server.addTool({
  name: "get_user_info",
  description:
    "Get a public profile for any Reddit user: comment/post/total karma, account age and status flags, plus a short activity analysis and engagement tips. Read-only; works without credentials via the Arctic Shift archive (scores lag). Returns profile stats only — use get_user_posts / get_user_comments for their actual content. Use get_me instead for your own authenticated account; do NOT expect private fields here, as only public data is returned.",
  annotations: {
    title: "Get User Info",
    readOnlyHint: true,
    openWorldHint: true,
  },
  parameters: z.object({
    username: z
      .string()
      .describe("The target user's Reddit username, without the u/ prefix (e.g. 'spez', not 'u/spez')."),
  }),
  execute: async (args) => {
    const client = unwrapClient()

    const result = await client.getUser(args.username)
    return result.fold(
      (err) => {
        // eslint-disable-next-line functype/prefer-either
        throw new Error(`Failed to get user info: ${err.message}`)
      },
      (user) => {
        const formattedUser = formatUserInfo(user)

        return `# User Information: u/${formattedUser.username}

## Profile Overview
- Username: u/${formattedUser.username}
- Karma:
  - Comment Karma: ${formattedUser.karma.commentKarma.toLocaleString()}
  - Post Karma: ${formattedUser.karma.postKarma.toLocaleString()}
  - Total Karma: ${formattedUser.karma.totalKarma.toLocaleString()}
- Account Status: ${client.keyless ? "Unknown (not in the archive)" : formattedUser.accountStatus.join(", ")}
- Account Created: ${client.keyless && user.createdUtc === 0 ? "Unknown (no archived activity)" : formattedUser.accountCreated}
- Profile URL: ${formattedUser.profileUrl}

## Activity Analysis
- ${formattedUser.activityAnalysis.replace(/\n {2}- /g, "\n- ")}

## Recommendations
- ${formattedUser.recommendations.replace(/\n {2}- /g, "\n- ")}${
          client.keyless ? "\n\n> Account Created is estimated from the user's first archived post or comment." : ""
        }${archiveDisclaimer(client)}`
      },
    )
  },
})

server.addTool({
  name: "get_me",
  description:
    "Get the authenticated user's own profile (karma, account age, status flags). Read-only, but requires user credentials (REDDIT_USERNAME/REDDIT_PASSWORD) and fails without user credentials. Use this instead of get_user_info when you need the current account rather than an arbitrary user. Do NOT use it to look up other users — it always returns the logged-in account.",
  annotations: {
    title: "Get My Account",
    readOnlyHint: true,
    openWorldHint: true,
  },
  parameters: z.object({}),
  execute: async () => {
    const client = unwrapClient()

    const result = await client.getMe()
    return result.fold(
      (err) => {
        // eslint-disable-next-line functype/prefer-either
        throw new Error(`Failed to get authenticated user: ${err.message}`)
      },
      (user) => {
        const formattedUser = formatUserInfo(user)

        return `# Your Account: u/${formattedUser.username}

## Profile Overview
- Username: u/${formattedUser.username}
- Karma:
  - Comment Karma: ${formattedUser.karma.commentKarma.toLocaleString()}
  - Post Karma: ${formattedUser.karma.postKarma.toLocaleString()}
  - Total Karma: ${formattedUser.karma.totalKarma.toLocaleString()}
- Account Status: ${formattedUser.accountStatus.join(", ")}
- Account Created: ${formattedUser.accountCreated}
- Profile URL: ${formattedUser.profileUrl}`
      },
    )
  },
})

server.addTool({
  name: "get_my_overview",
  description:
    "Get the authenticated user's own recent activity — posts and comments interleaved, newest first. Read-only but requires user credentials (REDDIT_USERNAME/REDDIT_PASSWORD). Returns up to `limit` items plus an `after` cursor for the next page. Use get_my_saved for saved items, or get_user_posts / get_user_comments for another user. Do NOT use this to fetch a specific post's thread — use get_post_comments.",
  annotations: {
    title: "Get My Overview",
    readOnlyHint: true,
    openWorldHint: true,
  },
  parameters: z.object({
    limit: z.number().min(1).max(100).default(25).describe("How many activity items to return, 1–100 (default 25)."),
    after: z
      .string()
      .optional()
      .describe("Forward pagination cursor: the `after` value returned by a previous call. Omit for the first page."),
  }),
  execute: async (args) => {
    const client = unwrapClient()

    const result = await client.getMyOverview({ limit: args.limit, after: args.after })
    return result.fold(
      (err) => {
        // eslint-disable-next-line functype/prefer-either
        throw new Error(`Failed to get your overview: ${err.message}`)
      },
      (content) => formatUserContent("Your Overview", content),
    )
  },
})

server.addTool({
  name: "get_my_saved",
  description:
    "Get the authenticated user's saved posts and comments (private to the account). Read-only but requires user credentials (REDDIT_USERNAME/REDDIT_PASSWORD). Returns up to `limit` items plus an `after` pagination cursor. Use get_my_overview for your authored activity. Do NOT use this for another user — saved items are private and have no cross-user equivalent.",
  annotations: {
    title: "Get My Saved",
    readOnlyHint: true,
    openWorldHint: true,
  },
  parameters: z.object({
    limit: z.number().min(1).max(100).default(25).describe("How many saved items to return, 1–100 (default 25)."),
    after: z
      .string()
      .optional()
      .describe("Forward pagination cursor: the `after` value returned by a previous call. Omit for the first page."),
  }),
  execute: async (args) => {
    const client = unwrapClient()

    const result = await client.getMySaved({ limit: args.limit, after: args.after })
    return result.fold(
      (err) => {
        // eslint-disable-next-line functype/prefer-either
        throw new Error(`Failed to get saved content: ${err.message}`)
      },
      (content) => formatUserContent("Your Saved Content", content),
    )
  },
})

server.addTool({
  name: "get_user_posts",
  description:
    "Get posts submitted by a specific user, with sort (new/hot/top) and time filter. Read-only; works without credentials via the Arctic Shift archive (scores lag). Returns a page of posts (title, subreddit, score, upvote ratio, comment count, permalink) plus an `after` cursor for paging. Use get_user_comments for their comments, or get_user_info for karma/profile stats. Do NOT use this to search a subreddit — use search_reddit or browse_subreddit.",
  annotations: {
    title: "Get User Posts",
    readOnlyHint: true,
    openWorldHint: true,
  },
  parameters: z.object({
    username: z.string().describe("The author's Reddit username, without the u/ prefix (e.g. 'spez')."),
    sort: z
      .enum(["new", "hot", "top"])
      .default("new")
      .describe(
        "Ordering: 'new' (most recent), 'hot' (currently active), or 'top' (highest score within `time_filter`). Default 'new'.",
      ),
    time_filter: z
      .enum(["hour", "day", "week", "month", "year", "all"])
      .default("all")
      .describe("Time window for scoring; only applies when sort='top'. Ignored for 'new'/'hot'. Default 'all'."),
    limit: z.number().min(1).max(100).default(10).describe("How many posts to return, 1–100 (default 10)."),
    after: z
      .string()
      .optional()
      .describe("Forward pagination cursor: the `after` value from a previous call. Omit for the first page."),
  }),
  execute: async (args) => {
    const client = unwrapClient()

    const result = await client.getUserPosts(args.username, {
      sort: args.sort,
      timeFilter: args.time_filter,
      limit: args.limit,
      after: args.after,
    })

    return result.fold(
      (err) => {
        // eslint-disable-next-line functype/prefer-either
        throw new Error(`Failed to get user posts: ${err.message}`)
      },
      (page) => {
        const posts = page.items
        if (posts.length === 0) {
          return `No posts found for u/${args.username} with the specified filters.`
        }

        const postSummaries = posts
          .map((post, index) => {
            const flags = [...(post.over18 ? ["**NSFW**"] : []), ...(post.spoiler === true ? ["**Spoiler**"] : [])]

            return `### ${index + 1}. ${post.title} ${flags.join(" ")}
- Subreddit: r/${post.subreddit}
- Score: ${post.score.toLocaleString()} (${(post.upvoteRatio * 100).toFixed(1)}% upvoted)
- Comments: ${post.numComments.toLocaleString()}
- Posted: ${new Date(post.createdUtc * 1000).toLocaleString()}
- Link: https://reddit.com${post.permalink}`
          })
          .join("\n\n")

        return `# Posts by u/${args.username} (${args.sort} - ${args.time_filter})

${postSummaries}${nextPageHint(page.after)}${sourceDisclaimer(page)}`
      },
    )
  },
})

server.addTool({
  name: "get_user_comments",
  description:
    "Get comments made by a specific user, with sort (new/hot/top) and time filter. Read-only; works without credentials via the Arctic Shift archive (scores lag). Returns a page of comments (subreddit, parent post title, body excerpt, score, permalink) plus an `after` cursor. Use get_user_posts for their submissions, or get_user_info for karma/profile stats. Do NOT use this to read one post's thread — use get_post_comments.",
  annotations: {
    title: "Get User Comments",
    readOnlyHint: true,
    openWorldHint: true,
  },
  parameters: z.object({
    username: z.string().describe("The author's Reddit username, without the u/ prefix (e.g. 'spez')."),
    sort: z
      .enum(["new", "hot", "top"])
      .default("new")
      .describe(
        "Ordering: 'new' (most recent), 'hot' (currently active), or 'top' (highest score within `time_filter`). Default 'new'.",
      ),
    time_filter: z
      .enum(["hour", "day", "week", "month", "year", "all"])
      .default("all")
      .describe("Time window for scoring; only applies when sort='top'. Ignored for 'new'/'hot'. Default 'all'."),
    limit: z.number().min(1).max(100).default(10).describe("How many comments to return, 1–100 (default 10)."),
    after: z
      .string()
      .optional()
      .describe("Forward pagination cursor: the `after` value from a previous call. Omit for the first page."),
  }),
  execute: async (args) => {
    const client = unwrapClient()

    const result = await client.getUserComments(args.username, {
      sort: args.sort,
      timeFilter: args.time_filter,
      limit: args.limit,
      after: args.after,
    })

    return result.fold(
      (err) => {
        // eslint-disable-next-line functype/prefer-either
        throw new Error(`Failed to get user comments: ${err.message}`)
      },
      (page) => {
        const comments = page.items
        if (comments.length === 0) {
          return `No comments found for u/${args.username} with the specified filters.`
        }

        const commentSummaries = comments
          .map((comment, index) => {
            const formatted = formatCommentInfo(comment, 300)

            const flags = [...(comment.edited ? ["*(edited)*"] : []), ...(comment.isSubmitter ? ["**OP**"] : [])]

            return `### ${index + 1}. Comment ${flags.join(" ")}
In r/${comment.subreddit} on "${comment.submissionTitle}"

> ${formatted.content}

- Score: ${comment.score.toLocaleString()}
- Posted: ${new Date(comment.createdUtc * 1000).toLocaleString()}
- Link: ${formatted.link}`
          })
          .join("\n\n")

        return `# Comments by u/${args.username} (${args.sort} - ${args.time_filter})

${commentSummaries}${nextPageHint(page.after)}${sourceDisclaimer(page)}`
      },
    )
  },
})

// Post tools
server.addTool({
  name: "get_reddit_post",
  description:
    "Get a single post by subreddit + post id: title, author, self-text or link content, score, upvote ratio, comment count, flair/flags, and an engagement analysis. Read-only; works without credentials via the Arctic Shift archive (scores lag). Returns the post only — use get_post_comments for its comment thread. Do NOT use this to list a subreddit's posts (use browse_subreddit / get_top_posts) or to find posts by keyword (use search_reddit).",
  annotations: {
    title: "Get Reddit Post",
    readOnlyHint: true,
    openWorldHint: true,
  },
  parameters: z.object({
    subreddit: z.string().describe("The subreddit the post lives in, without the r/ prefix (e.g. 'programming')."),
    post_id: z
      .string()
      .describe(
        "Base36 post id — the segment after /comments/ in a permalink like reddit.com/r/<sub>/comments/<post_id>/... (e.g. '1abc23'). With or without a t3_ prefix.",
      ),
  }),
  execute: async (args) => {
    const client = unwrapClient()

    const result = await client.getPost(args.post_id, args.subreddit)
    return result.fold(
      (err) => {
        // eslint-disable-next-line functype/prefer-either
        throw new Error(`Failed to get post: ${err.message}`)
      },
      (post) => {
        const formattedPost = formatPostInfo(post)

        return `# Post from r/${formattedPost.subreddit}

## Post Details
- Title: ${formattedPost.title}
- Type: ${formattedPost.type}
- Author: u/${formattedPost.author}

## Content
${formattedPost.content}

## Stats
- Score: ${formattedPost.stats.score.toLocaleString()}
- Upvote Ratio: ${(formattedPost.stats.upvoteRatio * 100).toFixed(1)}%
- Comments: ${formattedPost.stats.comments.toLocaleString()}

## Metadata
- Posted: ${formattedPost.metadata.posted}
- Flags: ${formattedPost.metadata.flags.length > 0 ? formattedPost.metadata.flags.join(", ") : "None"}
- Flair: ${formattedPost.metadata.flair}

## Links
- Full Post: ${formattedPost.links.fullPost}
- Short Link: ${formattedPost.links.shortLink}

## Engagement Analysis
- ${formattedPost.engagementAnalysis.replace(/\n {2}- /g, "\n- ")}

## Best Time to Engage
${formattedPost.bestTimeToEngage}${archiveDisclaimer(client)}`
      },
    )
  },
})

server.addTool({
  name: "get_top_posts",
  description:
    "Get the top-scoring posts from a subreddit — or from the authenticated home feed if no subreddit is given — within a time window (hour…all). Read-only; works without credentials via RSS (titles and links only, no scores); if RSS fails, it falls back to the Arctic Shift archive's newest posts, which have no ranking. Returns a page of posts plus an `after` cursor. This is a shortcut for the 'top' sort; use browse_subreddit for hot/new/rising/controversial, or search_reddit to find posts by keyword.",
  annotations: {
    title: "Get Top Posts",
    readOnlyHint: true,
    openWorldHint: true,
  },
  parameters: z.object({
    subreddit: z
      .string()
      .optional()
      .describe(
        "Subreddit to read, without the r/ prefix (e.g. 'science'). Omit to use the authenticated home feed (requires credentials).",
      ),
    time_filter: z
      .enum(["hour", "day", "week", "month", "year", "all"])
      .default("week")
      .describe("Time window the 'top' ranking is computed over (e.g. 'day' = top today). Default 'week'."),
    limit: z.number().min(1).max(100).default(10).describe("How many posts to return, 1–100 (default 10)."),
    after: z
      .string()
      .optional()
      .describe("Forward pagination cursor: the `after` value from a previous call. Omit for the first page."),
  }),
  execute: async (args) => {
    const client = unwrapClient()

    const result = await client.getTopPosts(args.subreddit ?? "", args.time_filter, args.limit, args.after)
    return result.fold(
      (err) => {
        // eslint-disable-next-line functype/prefer-either
        throw new Error(`Failed to get top posts: ${err.message}`)
      },
      (page) => {
        const posts = page.items
        if (posts.length === 0) {
          const location = Option(args.subreddit).fold(
            () => "home feed",
            (sr) => `r/${sr}`,
          )
          return `No posts found in ${location} for the specified time period.`
        }

        const postSummaries = posts
          .map(formatPostInfo)
          .map((post, index) => formatPostSummary(post, index, page.source))
          .join("\n\n")

        const location = Option(args.subreddit).fold(
          () => "Home Feed",
          (sr) => `r/${sr}`,
        )
        return `# Top Posts from ${location} (${args.time_filter})

${postSummaries}${nextPageHint(page.after)}${sourceDisclaimer(page)}`
      },
    )
  },
})

server.addTool({
  name: "browse_subreddit",
  description:
    "Browse a subreddit — or the authenticated home feed when no subreddit is given — by sort order: hot, new, top, rising, or controversial. Read-only; works without credentials via RSS (titles and links only, no scores); if RSS fails, it falls back to the Arctic Shift archive's newest posts, which have no ranking. `time_filter` applies only to the top and controversial sorts. Returns a page of posts plus an `after` cursor. Use get_top_posts as a shortcut for the top sort, or search_reddit to find posts by keyword rather than by feed order.",
  annotations: {
    title: "Browse Subreddit",
    readOnlyHint: true,
    openWorldHint: true,
  },
  parameters: z.object({
    subreddit: z
      .string()
      .optional()
      .describe(
        "Subreddit to browse, without the r/ prefix (e.g. 'news'). Omit to use the authenticated home feed (requires credentials).",
      ),
    sort: z
      .enum(["hot", "new", "top", "rising", "controversial"])
      .default("hot")
      .describe(
        "Feed ordering: 'hot' (default), 'new', 'rising', 'top', or 'controversial'. 'top'/'controversial' honor `time_filter`.",
      ),
    time_filter: z
      .enum(["hour", "day", "week", "month", "year", "all"])
      .default("week")
      .describe("Time window; only applies to sort='top' or 'controversial'. Ignored otherwise. Default 'week'."),
    limit: z.number().min(1).max(100).default(10).describe("How many posts to return, 1–100 (default 10)."),
    after: z
      .string()
      .optional()
      .describe("Forward pagination cursor: the `after` value from a previous call. Omit for the first page."),
  }),
  execute: async (args) => {
    const client = unwrapClient()

    const result = await client.browseSubreddit(
      args.subreddit ?? "",
      args.sort,
      args.time_filter,
      args.limit,
      args.after,
    )
    return result.fold(
      (err) => {
        // eslint-disable-next-line functype/prefer-either
        throw new Error(`Failed to browse subreddit: ${err.message}`)
      },
      (page) => {
        const posts = page.items
        const location = Option(args.subreddit).fold(
          () => "home feed",
          (sr) => `r/${sr}`,
        )
        if (posts.length === 0) {
          return `No posts found in ${location}.`
        }

        const postSummaries = posts
          .map(formatPostInfo)
          .map((post, index) => formatPostSummary(post, index, page.source))
          .join("\n\n")

        const timeSuffix = args.sort === "top" || args.sort === "controversial" ? `, ${args.time_filter}` : ""
        const heading = location === "home feed" ? "Home Feed" : location
        return `# ${args.sort} posts from ${heading} (${args.sort}${timeSuffix})

${postSummaries}${nextPageHint(page.after)}${sourceDisclaimer(page)}`
      },
    )
  },
})

// Subreddit tools
server.addTool({
  name: "get_subreddit_info",
  description:
    "Get a subreddit's profile: title, description, subscriber and active-user counts, creation date, flags, wiki/link URLs, plus a community analysis and posting tips. Read-only; works without credentials via the Arctic Shift archive (scores lag). Returns metadata about the community itself — use browse_subreddit / get_top_posts for its posts, or get_subreddit_rules for its posting rules. Do NOT use this to find subreddits by topic — use search_reddit with type='sr'.",
  annotations: {
    title: "Get Subreddit Info",
    readOnlyHint: true,
    openWorldHint: true,
  },
  parameters: z.object({
    subreddit_name: z.string().describe("The subreddit name, without the r/ prefix (e.g. 'askscience')."),
  }),
  execute: async (args) => {
    const client = unwrapClient()

    const result = await client.getSubredditInfo(args.subreddit_name)
    return result.fold(
      (err) => {
        // eslint-disable-next-line functype/prefer-either
        throw new Error(`Failed to get subreddit info: ${err.message}`)
      },
      (subreddit) => {
        const formattedSubreddit = formatSubredditInfo(subreddit)

        return `# Subreddit Information: r/${formattedSubreddit.name}

## Overview
- Name: r/${formattedSubreddit.name}
- Title: ${formattedSubreddit.title}
- Subscribers: ${formattedSubreddit.stats.subscribers.toLocaleString()}
- Active Users: ${
          typeof formattedSubreddit.stats.activeUsers === "number"
            ? formattedSubreddit.stats.activeUsers.toLocaleString()
            : formattedSubreddit.stats.activeUsers
        }

## Description
${formattedSubreddit.description.short}

## Detailed Description
${formattedSubreddit.description.full}

## Metadata
- Created: ${formattedSubreddit.metadata.created}
- Flags: ${formattedSubreddit.metadata.flags.join(", ")}

## Links
- Subreddit: ${formattedSubreddit.links.subreddit}
- Wiki: ${formattedSubreddit.links.wiki}

## Community Analysis
- ${formattedSubreddit.communityAnalysis.replace(/\n {2}- /g, "\n- ")}

## Engagement Tips
- ${formattedSubreddit.engagementTips.replace(/\n {2}- /g, "\n- ")}${archiveDisclaimer(client)}`
      },
    )
  },
})

server.addTool({
  name: "get_subreddit_rules",
  description:
    "Get a subreddit's posting rules (each rule's name, what it applies to, and its description). Read-only; works without credentials via the Arctic Shift archive (scores lag). Returns the rules list, or a note when the subreddit lists none. Call this before create_post to check requirements and avoid auto-removal. For available post flairs use get_post_flairs instead.",
  annotations: {
    title: "Get Subreddit Rules",
    readOnlyHint: true,
    openWorldHint: true,
  },
  parameters: z.object({
    subreddit_name: z.string().describe("The subreddit name, without the r/ prefix (e.g. 'AskReddit')."),
  }),
  execute: async (args) => {
    const client = unwrapClient()

    const result = await client.getSubredditRules(args.subreddit_name)
    return result.fold(
      (err) => {
        // eslint-disable-next-line functype/prefer-either
        throw new Error(`Failed to get subreddit rules: ${err.message}`)
      },
      (rules) => {
        if (rules.length === 0) {
          return `r/${args.subreddit_name} has no listed subreddit-specific rules.`
        }

        const ruleList = rules
          .map((rule, index) => {
            const applies = rule.kind === "all" ? "posts & comments" : `${rule.kind}s`
            const detail = rule.description.trim() === "" ? "" : `\n${rule.description.trim()}`
            return `### ${index + 1}. ${rule.shortName} _(applies to ${applies})_${detail}`
          })
          .join("\n\n")

        return `# Posting Rules for r/${args.subreddit_name}

${ruleList}${archiveDisclaimer(client)}`
      },
    )
  },
})

server.addTool({
  name: "get_post_flairs",
  description:
    "List a subreddit's selectable link flairs (flair text + flair_id) for use with create_post. Read-only, but requires user credentials; many subreddits expose flairs only to members, so this can 403 or return empty without credentials. Pass a returned flair_id (and flair_text for text-editable flairs) to create_post. For the subreddit's posting rules use get_subreddit_rules instead.",
  annotations: {
    title: "Get Post Flairs",
    readOnlyHint: true,
    openWorldHint: true,
  },
  parameters: z.object({
    subreddit_name: z.string().describe("The subreddit name, without the r/ prefix (e.g. 'gadgets')."),
  }),
  execute: async (args) => {
    const client = unwrapClient()

    const result = await client.getPostFlairs(args.subreddit_name)
    return result.fold(
      (err) => {
        // eslint-disable-next-line functype/prefer-either
        throw new Error(`Failed to get post flairs: ${err.message}`)
      },
      (flairs) => {
        if (flairs.length === 0) {
          return `r/${args.subreddit_name} has no selectable link flairs (or none are visible to this account).`
        }

        const flairList = flairs
          .map((flair) => {
            const editable = flair.textEditable === true ? " _(text editable)_" : ""
            return `- ${flair.text}${editable} — \`flair_id: ${flair.id}\``
          })
          .join("\n")

        return `# Available Link Flairs for r/${args.subreddit_name}

${flairList}

Pass the desired \`flair_id\` to \`create_post\`.`
      },
    )
  },
})

server.addTool({
  name: "get_trending_subreddits",
  description:
    "Get the subreddits Reddit is currently featuring as trending/popular. Read-only, no parameters; requires OAuth credentials. Returns a list of subreddit names that changes through the day (cached briefly server-side). To find subreddits by keyword instead of by trend, use search_reddit with type='sr'.",
  annotations: {
    title: "Get Trending Subreddits",
    readOnlyHint: true,
    openWorldHint: true,
  },
  parameters: z.object({}),
  execute: async () => {
    const client = unwrapClient()

    const result = await client.getTrendingSubreddits()
    return result.fold(
      (err) => {
        // eslint-disable-next-line functype/prefer-either
        throw new Error(`Failed to get trending subreddits: ${err.message}`)
      },
      (trendingSubreddits) => `# Trending Subreddits

${trendingSubreddits.map((subreddit, index) => `${index + 1}. r/${subreddit}`).join("\n")}`,
    )
  },
})

// Search tools
server.addTool({
  name: "search_reddit",
  description:
    "Search Reddit for posts — or subreddits/users via `type` — optionally scoped to one subreddit, with sort and time filters. Read-only. Without credentials it uses the Arctic Shift archive, which needs `subreddit` for post search, matches subreddit names by prefix, and cannot search users. Returns a page of results (title, subreddit, author, score, comments, link) plus an `after` cursor for paging. Use this to find content by keyword; use browse_subreddit / get_top_posts to list a known subreddit's feed instead.",
  annotations: {
    title: "Search Reddit",
    readOnlyHint: true,
    openWorldHint: true,
  },
  parameters: z.object({
    query: z
      .string()
      .describe(
        "Search terms; supports Reddit operators (quotes for exact phrases, author:name, self:yes). Must be non-empty.",
      ),
    subreddit: z
      .string()
      .optional()
      .describe(
        "Restrict results to this subreddit, without the r/ prefix (e.g. 'python'). Omit to search all of Reddit.",
      ),
    sort: z
      .enum(["relevance", "hot", "top", "new", "comments"])
      .default("relevance")
      .describe(
        "Sort order. Prefer 'relevance' (default) for finding posts about a topic. Use 'top'/'hot' only for what's currently popular and 'new' for the latest — these rank by karma/recency and, especially combined with a narrow time_filter, can surface loosely-matching posts over the best topical results.",
      ),
    time_filter: z
      .enum(["hour", "day", "week", "month", "year", "all"])
      .default("all")
      .describe("Restrict to results from this recent window (e.g. 'week'). Default 'all' (no time limit)."),
    limit: z.number().min(1).max(100).default(10).describe("How many results to return, 1–100 (default 10)."),
    type: z
      .enum(["link", "sr", "user"])
      .default("link")
      .describe("What to search for: 'link' = posts (default), 'sr' = subreddits, 'user' = users."),
    after: z
      .string()
      .optional()
      .describe("Forward pagination cursor: the `after` value from a previous call. Omit for the first page."),
  }),
  execute: async (args) => {
    const client = unwrapClient()

    if (args.query.trim() === "") {
      // eslint-disable-next-line functype/prefer-either
      throw new Error("Search query cannot be empty")
    }

    const result = await client.searchReddit(args.query, {
      subreddit: args.subreddit,
      sort: args.sort,
      timeFilter: args.time_filter,
      limit: args.limit,
      type: args.type,
      after: args.after,
    })

    return result.fold(
      (err) => {
        // eslint-disable-next-line functype/prefer-either
        throw new Error(`Failed to search: ${err.message}`)
      },
      (page) => {
        const posts = page.items
        if (posts.length === 0) {
          const searchLocation = Option(args.subreddit).fold(
            () => "",
            (sr) => ` in r/${sr}`,
          )
          return `No results found for "${args.query}"${searchLocation}.`
        }

        const searchResults = posts
          .map((post, index) => {
            const flags = [...(post.over18 ? ["**NSFW**"] : []), ...(post.spoiler === true ? ["**Spoiler**"] : [])]

            return `### ${index + 1}. ${post.title} ${flags.join(" ")}
- Subreddit: r/${post.subreddit}
- Author: u/${post.author}
- Score: ${post.score.toLocaleString()} (${(post.upvoteRatio * 100).toFixed(1)}% upvoted)
- Comments: ${post.numComments.toLocaleString()}
- Posted: ${new Date(post.createdUtc * 1000).toLocaleString()}
- Link: https://reddit.com${post.permalink}`
          })
          .join("\n\n")

        const searchLocation = Option(args.subreddit).fold(
          () => "",
          (sr) => ` in r/${sr}`,
        )
        return `# Reddit Search Results for: "${args.query}"${searchLocation}

Sorted by: ${page.source !== "arctic" ? args.sort : args.type === "sr" ? "subscribers (archive)" : "newest first (archive)"} | Time: ${args.time_filter} | Type: ${args.type}

${searchResults}${nextPageHint(page.after)}${sourceDisclaimer(page)}`
      },
    )
  },
})

// Write tools (require user authentication)
server.addTool({
  name: "create_post",
  description:
    "Create a new text or link post in a subreddit. Mutating and NOT idempotent — each call publishes a separate post. Requires REDDIT_USERNAME and REDDIT_PASSWORD; fails without them. Returns the new post's id and URL. Check get_subreddit_rules and get_post_flairs first, since many subreddits require a flair or reject certain content. WARNING: rapid posting or duplicate content may trigger Reddit's spam detection and account bans — enable REDDIT_SAFE_MODE=standard for rate limiting and duplicate detection.",
  annotations: {
    title: "Create Post",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  parameters: z.object({
    subreddit: z.string().describe("Target subreddit, without the r/ prefix (e.g. 'test')."),
    title: z.string().describe("Post title (cannot be edited after creation)."),
    content: z
      .string()
      .describe(
        "For a self post (is_self=true): the body text, Reddit markdown supported. For a link post (is_self=false): the destination URL.",
      ),
    is_self: z
      .boolean()
      .default(true)
      .describe(
        "true = text/self post using `content` as the body (default); false = link post using `content` as the URL.",
      ),
    flair_id: z
      .string()
      .optional()
      .describe(
        "Link flair template id from get_post_flairs; many subreddits require one or the post is auto-removed.",
      ),
    flair_text: z
      .string()
      .optional()
      .describe("Custom flair text, allowed only for flairs whose template is text-editable."),
  }),
  execute: async (args) => {
    const client = unwrapClient()

    if (process.env.REDDIT_USERNAME === undefined || process.env.REDDIT_PASSWORD === undefined) {
      // eslint-disable-next-line functype/prefer-either
      throw new Error(
        "User authentication required. Please set REDDIT_USERNAME and REDDIT_PASSWORD environment variables.",
      )
    }

    const result = await client.createPost(
      args.subreddit,
      args.title,
      args.content,
      args.is_self,
      args.flair_id,
      args.flair_text,
    )
    return result.fold(
      (err) => {
        // eslint-disable-next-line functype/prefer-either
        throw new Error(`Failed to create post: ${err.message}`)
      },
      (post) => {
        const formattedPost = formatPostInfo(post)

        return `# Post Created Successfully

## Post Details
- Title: ${formattedPost.title}
- Subreddit: r/${formattedPost.subreddit}
- Type: ${formattedPost.type}
- Link: ${formattedPost.links.fullPost}

Your post has been successfully submitted to r/${formattedPost.subreddit}.`
      },
    )
  },
})

server.addTool({
  name: "reply_to_post",
  description:
    "Post a reply to an existing post or comment. Mutating and NOT idempotent — each call adds a new comment. Requires REDDIT_USERNAME and REDDIT_PASSWORD. The parent is identified by its thing id — t3_ for a post, t1_ for a comment — so this creates both top-level and nested replies. Returns the new comment's id. Use edit_comment to change a reply you already posted. WARNING: rapid or duplicate replies may trigger Reddit's spam detection; enable REDDIT_SAFE_MODE=standard for rate limiting and duplicate detection.",
  annotations: {
    title: "Reply to Post or Comment",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  parameters: z.object({
    post_id: z
      .string()
      .describe(
        "Parent thing id to reply under: t3_<id> for a post (creates a top-level comment) or t1_<id> for a comment (creates a nested reply).",
      ),
    content: z.string().describe("Reply body text; Reddit markdown supported."),
  }),
  execute: async (args) => {
    const client = unwrapClient()

    if (process.env.REDDIT_USERNAME === undefined || process.env.REDDIT_PASSWORD === undefined) {
      // eslint-disable-next-line functype/prefer-either
      throw new Error(
        "User authentication required. Please set REDDIT_USERNAME and REDDIT_PASSWORD environment variables.",
      )
    }

    const result = await client.replyToPost(args.post_id, args.content)
    return result.fold(
      (err) => {
        // eslint-disable-next-line functype/prefer-either
        throw new Error(`Failed to reply: ${err.message}`)
      },
      (comment) => `# Reply Posted Successfully

## Comment Details
- Posted to: ${args.post_id}
- Author: u/${process.env.REDDIT_USERNAME}
- Comment ID: ${comment.id}

Your reply has been successfully posted.`,
    )
  },
})

server.addTool({
  name: "delete_post",
  description:
    "Permanently delete one of your own posts. Mutating and destructive but idempotent — deleting an already-deleted post is a no-op. Requires REDDIT_USERNAME and REDDIT_PASSWORD, and only works on posts authored by the authenticated account. Only affects the post you name; use delete_comment for comments. WARNING: this cannot be undone — the content is removed, though the post id remains.",
  annotations: {
    title: "Delete Post",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  parameters: z.object({
    thing_id: z
      .string()
      .describe(
        "The post to delete: a full thing id 't3_<id>' or just the base36 post id '<id>' (the 't3_' prefix is added automatically). Must be a post you authored.",
      ),
  }),
  execute: async (args) => {
    const client = unwrapClient()

    if (process.env.REDDIT_USERNAME === undefined || process.env.REDDIT_PASSWORD === undefined) {
      // eslint-disable-next-line functype/prefer-either
      throw new Error(
        "User authentication required. Please set REDDIT_USERNAME and REDDIT_PASSWORD environment variables.",
      )
    }

    const result = await client.deletePost(args.thing_id)
    return result.fold(
      (err) => {
        // eslint-disable-next-line functype/prefer-either
        throw new Error(`Failed to delete post: ${err.message}`)
      },
      () => `# Post Deleted Successfully

The post ${args.thing_id} has been permanently deleted from Reddit.

**Note**: This action cannot be undone. The post content has been removed and cannot be recovered.`,
    )
  },
})

server.addTool({
  name: "delete_comment",
  description:
    "Permanently delete one of your own comments. Mutating and destructive but idempotent — deleting an already-deleted comment is a no-op. Requires REDDIT_USERNAME and REDDIT_PASSWORD, and only works on comments authored by the authenticated account. Only affects the comment you name; use delete_post for posts. WARNING: this cannot be undone — the content is removed, though the comment id remains.",
  annotations: {
    title: "Delete Comment",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  parameters: z.object({
    thing_id: z
      .string()
      .describe(
        "The comment to delete: a full thing id 't1_<id>' or just the base36 comment id '<id>' (the 't1_' prefix is added automatically). Must be a comment you authored.",
      ),
  }),
  execute: async (args) => {
    const client = unwrapClient()

    if (process.env.REDDIT_USERNAME === undefined || process.env.REDDIT_PASSWORD === undefined) {
      // eslint-disable-next-line functype/prefer-either
      throw new Error(
        "User authentication required. Please set REDDIT_USERNAME and REDDIT_PASSWORD environment variables.",
      )
    }

    const result = await client.deleteComment(args.thing_id)
    return result.fold(
      (err) => {
        // eslint-disable-next-line functype/prefer-either
        throw new Error(`Failed to delete comment: ${err.message}`)
      },
      () => `# Comment Deleted Successfully

The comment ${args.thing_id} has been permanently deleted from Reddit.

**Note**: This action cannot be undone. The comment content has been removed and cannot be recovered.`,
    )
  },
})

server.addTool({
  name: "edit_post",
  description:
    'Replace the body text of one of your own self-text posts. Mutating and idempotent (same text → same result); it overwrites the previous body. Requires REDDIT_USERNAME and REDDIT_PASSWORD, and works only on self posts you authored — titles and link posts cannot be edited. Adds an "edited" marker. Use create_post to make a new post, or edit_comment for comments. WARNING: rapid edits may trigger spam detection; enable REDDIT_SAFE_MODE for protection.',
  annotations: {
    title: "Edit Post",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  parameters: z.object({
    thing_id: z
      .string()
      .describe(
        "The post to edit: a full thing id 't3_<id>' or just the base36 post id '<id>' (the 't3_' prefix is added automatically). Must be a self-text post you authored.",
      ),
    new_text: z
      .string()
      .describe("Replacement body text; fully overwrites the current body. Reddit markdown supported."),
  }),
  execute: async (args) => {
    const client = unwrapClient()

    if (process.env.REDDIT_USERNAME === undefined || process.env.REDDIT_PASSWORD === undefined) {
      // eslint-disable-next-line functype/prefer-either
      throw new Error(
        "User authentication required. Please set REDDIT_USERNAME and REDDIT_PASSWORD environment variables.",
      )
    }

    const result = await client.editPost(args.thing_id, args.new_text)
    return result.fold(
      (err) => {
        // eslint-disable-next-line functype/prefer-either
        throw new Error(`Failed to edit post: ${err.message}`)
      },
      () => `# Post Edited Successfully

The post ${args.thing_id} has been updated with your new content.

**Note**:
- Only self (text) posts can be edited
- Post titles cannot be edited
- Link posts cannot be edited
- An "edited" marker will appear on your post`,
    )
  },
})

server.addTool({
  name: "edit_comment",
  description:
    'Replace the text of one of your own comments. Mutating and idempotent (same text → same result); it overwrites the previous content. Requires REDDIT_USERNAME and REDDIT_PASSWORD, and works only on comments you authored. Adds an "edited" marker. Use reply_to_post to add a new comment, or edit_post for posts. WARNING: rapid edits may trigger spam detection; enable REDDIT_SAFE_MODE for protection.',
  annotations: {
    title: "Edit Comment",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  parameters: z.object({
    thing_id: z
      .string()
      .describe(
        "The comment to edit: a full thing id 't1_<id>' or just the base36 comment id '<id>' (the 't1_' prefix is added automatically). Must be a comment you authored.",
      ),
    new_text: z
      .string()
      .describe("Replacement comment text; fully overwrites the current content. Reddit markdown supported."),
  }),
  execute: async (args) => {
    const client = unwrapClient()

    if (process.env.REDDIT_USERNAME === undefined || process.env.REDDIT_PASSWORD === undefined) {
      // eslint-disable-next-line functype/prefer-either
      throw new Error(
        "User authentication required. Please set REDDIT_USERNAME and REDDIT_PASSWORD environment variables.",
      )
    }

    const result = await client.editComment(args.thing_id, args.new_text)
    return result.fold(
      (err) => {
        // eslint-disable-next-line functype/prefer-either
        throw new Error(`Failed to edit comment: ${err.message}`)
      },
      () => `# Comment Edited Successfully

The comment ${args.thing_id} has been updated with your new content.

**Note**: An "edited" marker will appear on your comment to show it has been modified.`,
    )
  },
})

server.addTool({
  name: "save_content",
  description:
    "Save a post or comment to your account (a private bookmark, listed by get_my_saved). Mutating but idempotent — saving an already-saved item is a no-op. Requires REDDIT_USERNAME and REDDIT_PASSWORD; works on any post/comment you can see, not just your own. Accepts a full thing id (t3_ for a post, t1_ for a comment) — a bare id is treated as a post. Use unsave_content to undo.",
  annotations: {
    title: "Save Post or Comment",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  parameters: z.object({
    thing_id: z
      .string()
      .describe(
        "The post or comment to save: a full thing id 't3_<id>' (post) or 't1_<id>' (comment). A bare id is treated as a post.",
      ),
    category: z
      .string()
      .optional()
      .describe("Optional save category to file this under (Reddit Premium feature; ignored on other accounts)."),
  }),
  execute: async (args) => {
    const client = unwrapClient()

    if (process.env.REDDIT_USERNAME === undefined || process.env.REDDIT_PASSWORD === undefined) {
      // eslint-disable-next-line functype/prefer-either
      throw new Error(
        "User authentication required. Please set REDDIT_USERNAME and REDDIT_PASSWORD environment variables.",
      )
    }

    const result = await client.saveContent(args.thing_id, args.category)
    return result.fold(
      (err) => {
        // eslint-disable-next-line functype/prefer-either
        throw new Error(`Failed to save content: ${err.message}`)
      },
      () => `# Content Saved Successfully

${args.thing_id} has been saved to your account. Use get_my_saved to view your saved items.`,
    )
  },
})

server.addTool({
  name: "unsave_content",
  description:
    "Remove a post or comment from your saved items (undoes save_content). Mutating but idempotent — unsaving an item that isn't saved is a no-op. Requires REDDIT_USERNAME and REDDIT_PASSWORD. Accepts a full thing id (t3_ for a post, t1_ for a comment) — a bare id is treated as a post.",
  annotations: {
    title: "Unsave Post or Comment",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  parameters: z.object({
    thing_id: z
      .string()
      .describe(
        "The post or comment to unsave: a full thing id 't3_<id>' (post) or 't1_<id>' (comment). A bare id is treated as a post.",
      ),
  }),
  execute: async (args) => {
    const client = unwrapClient()

    if (process.env.REDDIT_USERNAME === undefined || process.env.REDDIT_PASSWORD === undefined) {
      // eslint-disable-next-line functype/prefer-either
      throw new Error(
        "User authentication required. Please set REDDIT_USERNAME and REDDIT_PASSWORD environment variables.",
      )
    }

    const result = await client.unsaveContent(args.thing_id)
    return result.fold(
      (err) => {
        // eslint-disable-next-line functype/prefer-either
        throw new Error(`Failed to unsave content: ${err.message}`)
      },
      () => `# Content Unsaved Successfully

${args.thing_id} has been removed from your saved items.`,
    )
  },
})

// Comment tools
server.addTool({
  name: "get_post_comments",
  description:
    "Get the comment thread for a post (by post id + subreddit), sorted best/top/new/controversial/old/qa. Read-only; works without credentials via the Arctic Shift archive (scores lag). Returns the post header plus threaded comments (author, OP/edited badges, score, body, nesting depth) up to `limit`. Long threads are truncated with 'load more' stubs — expand those with get_more_comments. Use get_reddit_post for just the post body, not the thread.",
  annotations: {
    title: "Get Post Comments",
    readOnlyHint: true,
    openWorldHint: true,
  },
  parameters: z.object({
    post_id: z
      .string()
      .describe(
        "Base36 post id — the segment after /comments/ in a permalink (e.g. '1abc23'). With or without a t3_ prefix.",
      ),
    subreddit: z.string().describe("The subreddit the post lives in, without the r/ prefix (e.g. 'movies')."),
    sort: z
      .enum(["best", "top", "new", "controversial", "old", "qa"])
      .default("best")
      .describe("Comment ordering: 'best' (default), 'top', 'new', 'controversial', 'old', or 'qa' (Q&A)."),
    limit: z
      .number()
      .min(1)
      .max(500)
      .default(100)
      .describe(
        "Maximum comments to return, 1–500 (default 100). Deeply nested replies may still be truncated as 'load more' stubs.",
      ),
  }),
  execute: async (args) => {
    const client = unwrapClient()

    if (args.post_id === "" || args.subreddit === "") {
      // eslint-disable-next-line functype/prefer-either
      throw new Error("post_id and subreddit are required")
    }

    const result = await client.getPostComments(args.post_id, args.subreddit, {
      sort: args.sort,
      limit: args.limit,
    })

    return result.fold(
      (err) => {
        // eslint-disable-next-line functype/prefer-either
        throw new Error(`Failed to get comments: ${err.message}`)
      },
      ({ post, comments, moreIds }) => {
        // Archive scores and counts lag, so the keyless header leaves them out.
        const statsLine = client.keyless
          ? ""
          : `- Score: ${post.score.toLocaleString()} | Comments: ${post.numComments.toLocaleString()}\n`
        const header = `# Comments for: ${post.title}

**Post by u/${post.author} in r/${post.subreddit}**
${statsLine}- Posted: ${new Date(post.createdUtc * 1000).toLocaleString()}

---

`

        if (comments.length === 0) {
          return `${header}No comments found for this post.`
        }

        const commentSummaries = comments
          .map((comment) => {
            const indent = "└─".repeat(Math.min(comment.depth ?? 0, 3))
            const authorBadge = comment.isSubmitter ? " **[OP]**" : ""
            const editedBadge = comment.edited ? " *(edited)*" : ""

            return `${indent} **u/${comment.author}**${authorBadge}${editedBadge} (${comment.score.toLocaleString()} points)

${comment.body}

---`
          })
          .join("\n\n")

        // get_more_comments takes up to 100 ids per call (Reddit's /api/morechildren cap).
        const moreHint =
          moreIds.length > 0
            ? `\n\n**${moreIds.length} more comments are collapsed.** Expand them with get_more_comments: link_id="t3_${post.id}", comment_ids=${JSON.stringify(moreIds.slice(0, 100))}${moreIds.length > 100 ? " (first 100 shown)" : ""}`
            : ""
        const sortNote =
          client.keyless && args.sort !== "best" ? `\n\n> sort="${args.sort}" is not applied to archive comments.` : ""

        return header + commentSummaries + moreHint + sortNote + archiveDisclaimer(client)
      },
    )
  },
})

server.addTool({
  name: "get_more_comments",
  description:
    "Expand truncated 'load more comments' stubs in a thread. Read-only; works without credentials via the Arctic Shift archive (scores lag). Pass the post's link id and the comment ids from a 'more' node (surfaced by get_post_comments) to fetch those hidden comments; returns the expanded comments (author, body excerpt, score, link). Call get_post_comments first to obtain the thread and its 'more' node ids — do NOT invent ids.",
  annotations: {
    title: "Get More Comments",
    readOnlyHint: true,
    openWorldHint: true,
  },
  parameters: z.object({
    link_id: z
      .string()
      .describe("The parent post's link id (base36, with or without the t3_ prefix) that the stub belongs to."),
    comment_ids: z
      .array(z.string())
      .min(1)
      .describe(
        "Base36 comment ids to expand, taken from a 'more' node returned by get_post_comments (not arbitrary ids).",
      ),
  }),
  execute: async (args) => {
    const client = unwrapClient()

    const result = await client.getMoreComments(args.link_id, args.comment_ids)
    return result.fold(
      (err) => {
        // eslint-disable-next-line functype/prefer-either
        throw new Error(`Failed to expand comments: ${err.message}`)
      },
      (comments) => {
        if (comments.length === 0) {
          return "No additional comments were returned for those ids."
        }

        const commentList = comments
          .map((comment, index) => {
            const formatted = formatCommentInfo(comment, 300)
            const flags = [...(comment.edited ? ["*(edited)*"] : []), ...(comment.isSubmitter ? ["**OP**"] : [])]
            return `### ${index + 1}. u/${comment.author} ${flags.join(" ")}
> ${formatted.content}

- Score: ${comment.score.toLocaleString()}
- Link: ${formatted.link}`
          })
          .join("\n\n")

        return `# Expanded Comments (${comments.length})

${commentList}${archiveDisclaimer(client)}`
      },
    )
  },
})

// ───────────────────────────── Facebook tools ─────────────────────────────
// These scrape public & private Facebook GROUPS (and Pages) for e-commerce customer
// research. Private groups require FACEBOOK_COOKIE from a logged-in account that is a
// member of the group, ideally with the optional Playwright browser engine installed.

server.addTool({
  name: "test_facebook_connection",
  description: "Check Facebook scraping configuration: session, engine, and Playwright availability.",
  parameters: z.object({}),
  execute: async () => {
    const client = getFacebookClient()
    const hasClient = client.fold(
      () => false,
      () => true,
    )
    if (!hasClient) {
      return "Facebook client not initialized."
    }
    const fb = client.orThrow(new Error("Facebook client not initialized"))
    const engine = await fb.engineName()
    const playwright = await isPlaywrightAvailable()

    return `Facebook Scraper Status:
- Session (cookies): ${fb.hasSession() ? "✓ loaded" : "✗ none (set FACEBOOK_COOKIE for groups)"}
- Active engine: ${engine}
- Playwright browser engine: ${playwright ? "✓ available" : "✗ not installed"}
- Private groups: ${fb.hasSession() ? "accessible if this account is a member" : "unavailable without a session"}

${playwright ? "" : "Tip: for private groups & full comment threads, run: npm install playwright && npx playwright install chromium"}`
  },
})

server.addTool({
  name: "facebook_get_group_posts",
  description:
    "Scrape recent posts from a public or private Facebook group's feed. Private groups require a " +
    "FACEBOOK_COOKIE session belonging to a member. Use this to gather customer discussions for persona research.",
  parameters: z.object({
    group: z.string().describe("Group id, slug, or full URL (e.g. '123456789' or a facebook.com/groups/... link)"),
    limit: z.number().min(1).max(100).default(25).describe("Maximum number of posts to retrieve"),
  }),
  execute: async (args) => {
    const fb = unwrapFacebookClient()
    const result = await fb.getGroupFeed(args.group, args.limit)
    return result.fold(
      (err) => {
        // eslint-disable-next-line functype/prefer-either
        throw new Error(err.message)
      },
      (posts) => formatFeed(`Facebook Group Feed: ${args.group}`, posts),
    )
  },
})

server.addTool({
  name: "facebook_get_post_comments",
  description:
    "Scrape the comment thread of a specific Facebook post (group or page). Pass the post's permalink URL. " +
    "Full threads with nested replies are most reliable with the Playwright browser engine.",
  parameters: z.object({
    post_url: z.string().describe("The Facebook post permalink URL"),
    limit: z.number().min(1).max(500).default(100).describe("Maximum number of comments to retrieve"),
  }),
  execute: async (args) => {
    const fb = unwrapFacebookClient()
    const result = await fb.getPostComments(args.post_url, args.limit)
    return result.fold(
      (err) => {
        // eslint-disable-next-line functype/prefer-either
        throw new Error(err.message)
      },
      (data) => formatPostComments(data),
    )
  },
})

server.addTool({
  name: "facebook_get_group_info",
  description: "Get metadata about a Facebook group: name, privacy (public/private), member count, and description.",
  parameters: z.object({
    group: z.string().describe("Group id, slug, or full URL"),
  }),
  execute: async (args) => {
    const fb = unwrapFacebookClient()
    const result = await fb.getGroupInfo(args.group)
    return result.fold(
      (err) => {
        // eslint-disable-next-line functype/prefer-either
        throw new Error(err.message)
      },
      (group) => formatGroupInfo(group),
    )
  },
})

server.addTool({
  name: "facebook_search_groups",
  description:
    "Search Facebook for groups matching a query (e.g. a product niche). Returns group names and URLs to feed " +
    "into facebook_get_group_posts. Most reliable with a logged-in session + browser engine.",
  parameters: z.object({
    query: z.string().describe("Search query, e.g. a product niche or interest"),
    limit: z.number().min(1).max(50).default(20).describe("Maximum number of groups to return"),
  }),
  execute: async (args) => {
    const fb = unwrapFacebookClient()
    if (args.query.trim() === "") {
      // eslint-disable-next-line functype/prefer-either
      throw new Error("Search query cannot be empty")
    }
    const result = await fb.searchGroups(args.query, args.limit)
    return result.fold(
      (err) => {
        // eslint-disable-next-line functype/prefer-either
        throw new Error(err.message)
      },
      (groups) => formatGroupSearch(args.query, groups),
    )
  },
})

server.addTool({
  name: "facebook_get_page_posts",
  description:
    "Scrape recent posts from a public Facebook Page feed (e.g. a brand or competitor page). " +
    "Pages are public, so this works without a session in most regions.",
  parameters: z.object({
    page: z.string().describe("Page name, slug, or full URL (e.g. 'nike' or a facebook.com/... link)"),
    limit: z.number().min(1).max(100).default(25).describe("Maximum number of posts to retrieve"),
  }),
  execute: async (args) => {
    const fb = unwrapFacebookClient()
    const result = await fb.getPageFeed(args.page, args.limit)
    return result.fold(
      (err) => {
        // eslint-disable-next-line functype/prefer-either
        throw new Error(err.message)
      },
      (posts) => formatFeed(`Facebook Page Feed: ${args.page}`, posts),
    )
  },
})

// ───────────────────────────── Amazon tools ─────────────────────────────
// These scrape Amazon product REVIEWS for e-commerce customer research. The free HTTP engine
// reads the first (public) pages of reviews; for depth, set AMAZON_COOKIE from a logged-in
// browser (optional Playwright browser engine) or AMAZON_API_KEY for a reliable reviews API.

server.addTool({
  name: "test_amazon_connection",
  description: "Check Amazon scraping configuration: session cookies, engine, paid API, and Playwright availability.",
  parameters: z.object({}),
  execute: async () => {
    const client = getAmazonClient()
    const hasClient = client.fold(
      () => false,
      () => true,
    )
    if (!hasClient) {
      return "Amazon client not initialized."
    }
    const amz = client.orThrow(new Error("Amazon client not initialized"))
    const engine = await amz.activeEngineName()
    const playwright = await isPlaywrightAvailable()

    return `Amazon Scraper Status:
- Session (cookies): ${amz.hasSession() ? "✓ loaded (can page deeper into reviews)" : "✗ none (only first public pages)"}
- Active engine: ${engine}
- Playwright browser engine: ${playwright ? "✓ available" : "✗ not installed"}
- Reviews API: ${engine === "api" ? "✓ configured (most reliable)" : "✗ not configured (set AMAZON_API_KEY)"}

${engine === "api" || amz.hasSession() ? "" : "Tip: for full review history, set AMAZON_COOKIE from a logged-in browser, or AMAZON_API_KEY (Unwrangle/Rainforest)."}`
  },
})

server.addTool({
  name: "amazon_search_products",
  description:
    "Search Amazon for products matching a query (e.g. a niche like 'magnesium glycinate'). Returns product names " +
    "and ASINs to feed into amazon_get_product_reviews. Use this when the user names a niche but no specific product. " +
    "Amazon search is bot-protected when logged out, so it's most reliable with a logged-in AMAZON_COOKIE + the " +
    "browser engine (run `pnpm run setup`).",
  parameters: z.object({
    query: z.string().describe("Search query, e.g. a product niche or keyword"),
    limit: z.number().min(1).max(50).default(15).describe("Maximum number of products to return"),
    marketplace: z.string().optional().describe("Marketplace TLD, e.g. 'com', 'co.uk', 'de'"),
  }),
  execute: async (args) => {
    const amz = unwrapAmazonClient()
    if (args.query.trim() === "") {
      // eslint-disable-next-line functype/prefer-either
      throw new Error("Search query cannot be empty")
    }
    const result = await amz.searchProducts(args.query, { limit: args.limit, marketplace: args.marketplace })
    return result.fold(
      (err) => {
        // eslint-disable-next-line functype/prefer-either
        throw new Error(err.message)
      },
      (products) => formatProductSearch(args.query, products),
    )
  },
})

server.addTool({
  name: "amazon_get_product_reviews",
  description:
    "Scrape customer reviews for an Amazon product to mine voice-of-customer language. Pass a 10-character ASIN " +
    "or any Amazon product/review URL. Returns the product's rating summary plus individual reviews (star rating, " +
    "title, body, verified-purchase flag, date, helpful votes). To gather depth, when no single star_filter is " +
    "pinned it automatically fans out across a 5★/3★/1★ spread (what they love / balanced / biggest complaints) and " +
    "dedupes (Amazon caps each view at ~100 reviews, so the ceiling is a few hundred/product). Needs a logged-in " +
    "AMAZON_COOKIE or AMAZON_API_KEY; some products are gated to a fixed ~8-review 'limited selection' that no " +
    "scraper can exceed.",
  parameters: z.object({
    product: z.string().describe("A 10-character ASIN (e.g. 'B0XXXXXXXX') or an Amazon product/review URL"),
    limit: z.number().min(1).max(500).default(50).describe("Maximum number of reviews to retrieve"),
    sort: z.enum(["recent", "helpful"]).default("recent").describe("Order reviews by most recent or most helpful"),
    star_filter: z
      .enum(["all", "five", "four", "three", "two", "one", "positive", "critical"])
      .default("all")
      .describe("Only return reviews with this star rating (or positive/critical)"),
    verified_only: z.boolean().default(false).describe("Only include verified-purchase reviews"),
    marketplace: z
      .string()
      .optional()
      .describe("Marketplace TLD override, e.g. 'com', 'co.uk', 'de' (auto-detected from a full URL)"),
  }),
  execute: async (args) => {
    const amz = unwrapAmazonClient()
    const result = await amz.getProductReviews(args.product, {
      limit: args.limit,
      sort: args.sort as AmazonReviewSort,
      star: args.star_filter as AmazonStarFilter,
      reviewerType: args.verified_only ? "verified" : "all",
      marketplace: args.marketplace,
    })
    return result.fold(
      (err) => {
        // eslint-disable-next-line functype/prefer-either
        throw new Error(err.message)
      },
      (data) => formatProductWithReviews(data),
    )
  },
})

server.addTool({
  name: "amazon_get_product_info",
  description:
    "Get an Amazon product's metadata and rating summary (title, brand, average stars, total ratings, and the " +
    "per-star distribution when available) without pulling full review bodies. Pass an ASIN or product URL.",
  parameters: z.object({
    product: z.string().describe("A 10-character ASIN or an Amazon product/review URL"),
    marketplace: z.string().optional().describe("Marketplace TLD override, e.g. 'com', 'co.uk', 'de'"),
  }),
  execute: async (args) => {
    const amz = unwrapAmazonClient()
    const result = await amz.getProductInfo(args.product, args.marketplace)
    return result.fold(
      (err) => {
        // eslint-disable-next-line functype/prefer-either
        throw new Error(err.message)
      },
      (product) => formatProduct(product),
    )
  },
})

// ───────────────────────────── Quora tools ─────────────────────────────
// These scrape Quora Q&A threads for e-commerce customer research. Quora embeds answers as
// schema.org QAPage JSON-LD, so question pages parse even logged-out; search/topic feeds and deep
// answer threads are gated, so for those set QUORA_COOKIE from a logged-in browser (browser engine).

server.addTool({
  name: "test_quora_connection",
  description: "Check Quora scraping configuration: session cookies, engine, and Playwright availability.",
  parameters: z.object({}),
  execute: async () => {
    const client = getQuoraClient()
    const hasClient = client.fold(
      () => false,
      () => true,
    )
    if (!hasClient) {
      return "Quora client not initialized."
    }
    const quora = client.orThrow(new Error("Quora client not initialized"))
    const engine = await quora.activeEngineName()
    const playwright = await isPlaywrightAvailable()

    return `Quora Scraper Status:
- Session (cookies): ${quora.hasSession() ? "✓ loaded (can read deeper answer threads + search/topic feeds)" : "✗ none (question pages only, from embedded JSON-LD)"}
- Active engine: ${engine}
- Playwright browser engine: ${playwright ? "✓ available" : "✗ not installed"}

${quora.hasSession() ? "" : "Tip: for search/topic feeds and deeper threads, set QUORA_COOKIE from a logged-in browser (run `pnpm run setup`)."}`
  },
})

server.addTool({
  name: "quora_search",
  description:
    "Search Quora for questions matching a query (e.g. a niche like 'magnesium for sleep'). Returns question " +
    "titles and URLs to feed into quora_get_question - Quora questions are pure voice-of-customer (people stating " +
    "their pains/desires/questions). Quora search is gated when logged out, so it's most reliable with a logged-in " +
    "QUORA_COOKIE + the browser engine (run `pnpm run setup`).",
  parameters: z.object({
    query: z.string().describe("Search query, e.g. a product niche or customer question"),
    limit: z.number().min(1).max(50).default(15).describe("Maximum number of questions to return"),
  }),
  execute: async (args) => {
    const quora = unwrapQuoraClient()
    if (args.query.trim() === "") {
      // eslint-disable-next-line functype/prefer-either
      throw new Error("Search query cannot be empty")
    }
    const result = await quora.searchQuestions(args.query, { limit: args.limit })
    return result.fold(
      (err) => {
        // eslint-disable-next-line functype/prefer-either
        throw new Error(err.message)
      },
      (questions) => formatQuestionCards(`Quora Search: "${args.query}"`, questions),
    )
  },
})

server.addTool({
  name: "quora_get_question",
  description:
    "Scrape a Quora question and its answers to mine voice-of-customer language. Pass a quora.com question URL or " +
    "its slug. Returns the question plus individual answers (author, body, upvote count, date) - the upvote count is " +
    "the crowd-validation signal. Question pages parse from embedded JSON-LD even logged-out; deeper threads need a " +
    "logged-in QUORA_COOKIE with the browser engine.",
  parameters: z.object({
    question: z
      .string()
      .describe("A quora.com question URL (or its slug, e.g. 'What-is-the-best-magnesium-for-sleep')"),
    limit: z.number().min(1).max(200).default(50).describe("Maximum number of answers to retrieve"),
  }),
  execute: async (args) => {
    const quora = unwrapQuoraClient()
    const result = await quora.getQuestion(args.question, { maxAnswers: args.limit })
    return result.fold(
      (err) => {
        // eslint-disable-next-line functype/prefer-either
        throw new Error(err.message)
      },
      (data) => formatQuestionWithAnswers(data),
    )
  },
})

server.addTool({
  name: "quora_get_topic_questions",
  description:
    "Fetch the questions in a Quora topic or Space - the highest-signal 'what does this niche actually ask?' query. " +
    "Pass a topic name (e.g. 'Magnesium'), a /topic/... URL, or a Space (q/<slug>) URL. Returns question cards to " +
    "feed into quora_get_question. Topic feeds are JS-heavy, so most reliable with a logged-in QUORA_COOKIE + the " +
    "browser engine (run `pnpm run setup`).",
  parameters: z.object({
    topic: z.string().describe("A topic name, a quora.com /topic/... URL, or a Space (q/<slug>) URL"),
    limit: z.number().min(1).max(50).default(25).describe("Maximum number of questions to return"),
  }),
  execute: async (args) => {
    const quora = unwrapQuoraClient()
    const result = await quora.getTopicQuestions(args.topic, { limit: args.limit })
    return result.fold(
      (err) => {
        // eslint-disable-next-line functype/prefer-either
        throw new Error(err.message)
      },
      (questions) => formatQuestionCards(`Quora Topic: "${args.topic}"`, questions),
    )
  },
})

// ──────────────── Meta Ad Library tools (competitor ad spying) ────────────────
// Scrape the public Meta (Facebook/Instagram) Ad Library: find a brand's advertiser pages by its
// bare domain, then fetch their ads with copy/CTA/media. Most robust with META_ADS_ENGINE=browser
// (Playwright) reusing your Facebook login; a paid META_ADS_API_KEY is the hands-off path at scale.

server.addTool({
  name: "meta_ads_find_brands",
  description:
    "Discover advertisers running ads in the Meta (Facebook/Instagram) Ad Library. BEST INPUT: a brand's " +
    "bare domain (e.g. 'vitalityextracts.com', no https://) - a unique domain surfaces the brand's whole " +
    "connected page network (its main page PLUS affiliate/advertorial pages). A niche keyword also works but is " +
    "noisier. Returns distinct advertiser cards (page name, page id, # of ads seen, sample copy) ranked by ad " +
    "volume; feed one into meta_ads_get_advertiser_ads.",
  parameters: z.object({
    query: z.string().describe("A brand's bare domain (recommended, e.g. 'vitalityextracts.com') or a niche keyword"),
    country: z.string().default("US").describe("Ad Library country (ISO code, e.g. 'US', 'GB', or 'ALL')"),
    active_status: z
      .enum(["all", "active", "inactive"])
      .default("active")
      .describe("Only include ads with this status"),
    limit: z.number().min(1).max(100).default(25).describe("Maximum number of advertisers to return"),
  }),
  execute: async (args) => {
    const meta = unwrapMetaAdsClient()
    if (args.query.trim() === "") {
      // eslint-disable-next-line functype/prefer-either
      throw new Error("Search query cannot be empty")
    }
    const result = await meta.findBrands(args.query, {
      country: args.country,
      activeStatus: args.active_status as MetaAdActiveStatus,
      limit: args.limit,
    })
    return result.fold(
      (err) => {
        // eslint-disable-next-line functype/prefer-either
        throw new Error(err.message)
      },
      (brands) => formatBrands(args.query, brands),
    )
  },
})

server.addTool({
  name: "meta_ads_get_advertiser_ads",
  description:
    "Fetch an advertiser's ads from the Meta Ad Library with their full ad copy, headline, CTA, landing page, " +
    "platforms and run-length. Pass a page id, an Ad Library URL (with view_all_page_id=), or a page name/domain. " +
    "Filter by media type (image/video/etc.), active status and platform. Sorts by longest-running first by " +
    "default - the strongest free 'winning ad' signal (a long-running, heavily-duplicated creative is almost " +
    "certainly profitable).",
  parameters: z.object({
    advertiser: z
      .string()
      .describe("A page id, an Ad Library URL (view_all_page_id=...), or a page name / brand domain"),
    country: z.string().default("US").describe("Ad Library country (ISO code, e.g. 'US', 'GB', or 'ALL')"),
    media_type: z
      .enum(["all", "image", "video", "meme", "none"])
      .default("all")
      .describe("Only include ads of this media type"),
    active_status: z.enum(["all", "active", "inactive"]).default("all").describe("Only include ads with this status"),
    platform: z
      .enum(["facebook", "instagram", "messenger", "audience_network", "threads"])
      .optional()
      .describe("Only include ads delivered on this platform"),
    sort: z
      .enum(["relevance", "newest", "longest_running"])
      .default("longest_running")
      .describe("Order ads; longest_running surfaces likely winners first"),
    limit: z.number().min(1).max(200).default(50).describe("Maximum number of ads to return"),
  }),
  execute: async (args) => {
    const meta = unwrapMetaAdsClient()
    const result = await meta.getAdvertiserAds(args.advertiser, {
      country: args.country,
      mediaType: args.media_type as MetaAdMediaType,
      activeStatus: args.active_status as MetaAdActiveStatus,
      platform: args.platform as MetaAdPlatform | undefined,
      sort: args.sort as MetaAdSort,
      limit: args.limit,
    })
    return result.fold(
      (err) => {
        // eslint-disable-next-line functype/prefer-either
        throw new Error(err.message)
      },
      (data) => formatAdvertiserAds(data),
    )
  },
})

server.addTool({
  name: "meta_ads_download_creatives",
  description:
    "Download an advertiser's ad creative FILES (static images and/or videos) from the Meta Ad Library to a local " +
    "folder, so you can swipe them. Pass a page id, an Ad Library URL (view_all_page_id=), or a brand domain. Files " +
    "are saved under <output_dir or META_ADS_DOWNLOAD_DIR or 'meta-ads-creatives'>/<advertiser>/, named by ad id, " +
    "with the correct extension sniffed from the file bytes. Defaults to static images. For VIDEOS, when the local " +
    "whisper.cpp toolchain is installed it also TRANSCRIBES each video to a `.txt` script plus a combined " +
    "`.script.md` (ad copy + spoken script). NOTE: this writes files to your local disk.",
  parameters: z.object({
    advertiser: z
      .string()
      .describe("A page id, an Ad Library URL (view_all_page_id=...), or a page name / brand domain"),
    country: z.string().default("US").describe("Ad Library country (ISO code, e.g. 'US', 'GB', or 'ALL')"),
    what: z
      .enum(["images", "videos", "all"])
      .default("images")
      .describe("Which creatives to download: static images, videos, or both"),
    transcribe: z
      .enum(["auto", "off"])
      .default("auto")
      .describe("Transcribe downloaded videos to a text script via local whisper.cpp (auto = when installed)"),
    media_type: z
      .enum(["all", "image", "video", "meme", "none"])
      .optional()
      .describe("Which ads to pull before downloading (default: follows `what`)"),
    active_status: z.enum(["all", "active", "inactive"]).default("all").describe("Only include ads with this status"),
    limit: z.number().min(1).max(200).default(50).describe("Maximum number of ads to pull"),
    max_files: z.number().min(1).max(300).default(50).describe("Hard cap on the number of files downloaded"),
    output_dir: z
      .string()
      .optional()
      .describe("Base output directory (default: META_ADS_DOWNLOAD_DIR env, else 'meta-ads-creatives')"),
  }),
  execute: async (args) => {
    const meta = unwrapMetaAdsClient()
    const threadsEnv = process.env.META_ADS_WHISPER_THREADS
    const result = await meta.downloadAdvertiserCreatives(args.advertiser, {
      country: args.country,
      what: args.what as MetaDownloadWhat,
      mediaType: args.media_type as MetaAdMediaType | undefined,
      activeStatus: args.active_status as MetaAdActiveStatus,
      transcribe: args.transcribe as MetaTranscribeMode,
      transcribeFast: (process.env.META_ADS_WHISPER_FAST ?? "false") === "true",
      transcribeThreads: threadsEnv !== undefined && Number(threadsEnv) > 0 ? Number(threadsEnv) : undefined,
      limit: args.limit,
      maxFiles: args.max_files,
      baseDir: args.output_dir ?? process.env.META_ADS_DOWNLOAD_DIR,
    })
    return result.fold(
      (err) => {
        // eslint-disable-next-line functype/prefer-either
        throw new Error(err.message)
      },
      (manifest) => formatDownloadManifest(manifest),
    )
  },
})

server.addTool({
  name: "test_meta_ads_connection",
  description:
    "Check Meta Ad Library scraping configuration: session cookies, engine, paid API, and Playwright availability.",
  parameters: z.object({}),
  execute: async () => {
    const client = getMetaAdsClient()
    const hasClient = client.fold(
      () => false,
      () => true,
    )
    if (!hasClient) {
      return "Meta Ad Library client not initialized."
    }
    const meta = client.orThrow(new Error("Meta Ad Library client not initialized"))
    const engine = await meta.activeEngineName()
    const playwright = await isPlaywrightAvailable()

    return `Meta Ad Library Scraper Status:
- Session (cookies): ${meta.hasSession() ? "✓ loaded (reuses your Facebook login)" : "✗ none (public reads still work)"}
- Active engine: ${engine}
- Playwright browser engine: ${playwright ? "✓ available (most robust)" : "✗ not installed"}
- Reviews/ads API: ${engine === "api" ? "✓ configured (most reliable)" : "✗ not configured (set META_ADS_API_KEY)"}

${
  engine === "api" || playwright
    ? "Tip: search a brand's bare domain (e.g. 'vitalityextracts.com') to surface its whole connected page network."
    : "Tip: install Playwright (npm install playwright && npx playwright install chromium) for the robust browser engine, or set META_ADS_API_KEY."
}`
  },
})

// ──────────────── Customer persona tools (Schwartz framework) ────────────────
// Platform-agnostic: feed in comments/posts/reviews scraped from Facebook, Reddit AND/OR Amazon.

server.addTool({
  name: "analyze_voice_of_customer",
  description:
    "Mine a corpus of customer discussion (Facebook/Reddit comments & posts, Amazon reviews) into voice-of-customer " +
    "buckets: pains, desires, objections, questions, emotional triggers, product mentions, recurring phrases, and verbatim quotes.",
  parameters: z.object({
    texts: z.array(z.string()).min(1).describe("Array of raw text snippets (comments/posts) to analyze"),
  }),
  execute: (args) => {
    const voc = mineVoiceOfCustomer(args.texts)
    const list = (items: readonly string[]) =>
      items.length === 0 ? "_(none detected)_" : items.map((i) => `- ${i}`).join("\n")
    return Promise.resolve(`# Voice of Customer Analysis

_Analyzed ${args.texts.length} item(s)._

## Pains & Frustrations
${list(voc.pains)}

## Desires
${list(voc.desires)}

## Objections & Skepticism
${list(voc.objections)}

## Questions
${list(voc.questions)}

## Emotional Triggers
${list(voc.emotionalTriggers)}

## Product / Solution Mentions
${list(voc.productMentions)}

## Recurring Phrases (their words)
${list(voc.vocabulary)}

## Verbatim Quotes
${list(voc.quotes)}`)
  },
})

/* eslint-disable functype/no-imperative-loops, functype/prefer-map -- these tools fan out over
   sources/posts/comments and accumulate rows; nested loops are the clearest expression. */

// One flat row of voice-of-customer data. Each post/product/question emits a row_type="post" row,
// then its comments (row_type="comment"), reviews (row_type="review"), or Quora answers
// (row_type="answer") sharing the same post_id - so the parent<->child relationship is explicit
// (group or sort by post_id). For Amazon, the product is the "post" (post_id = ASIN) and each
// review is a "review" row. For Quora, the question is the "post" (post_id = slug) and each answer
// is an "answer" row (with any answer comments as "comment" rows under the same post_id).
//
// `upvotes` is the platform's social-proof signal so you can rank by what the crowd validated:
// Reddit = comment/post score, Facebook = reactions/likes, Amazon = "found helpful" votes,
// Quora = answer upvotes.
type VocRow = {
  platform: "facebook" | "reddit" | "amazon" | "quora"
  source_url: string
  post_id: string
  post_url: string
  row_type: "post" | "comment" | "review" | "answer"
  author: string
  timestamp: string
  upvotes: string
  category: string
  text: string
}

const VOC_COLUMNS = [
  "platform",
  "source_url",
  "post_id",
  "post_url",
  "row_type",
  "author",
  "timestamp",
  "upvotes",
  "category",
  "text",
]

const oneLineText = (s: string): string => s.replace(/\s+/g, " ").trim()

// Render an optional engagement count as a CSV cell (blank when the platform didn't expose one).
const votesCell = (n: number | undefined): string => (n === undefined ? "" : String(n))

// Pick the best voice-of-customer category for an Amazon review: trust the text cues first,
// then fall back to the star rating (low stars → pain, high stars → desire).
function classifyReview(text: string, rating: number | undefined): string {
  const category = classifyComment(text)
  if (category !== "other") {
    return category
  }
  if (rating !== undefined && rating <= 2) {
    return "pain"
  }
  if (rating !== undefined && rating >= 4) {
    return "desire"
  }
  return "other"
}

// Flatten a scraped Quora question into VocRows: the question as a "post", each answer as an
// "answer" row, and any answer comments as "comment" rows - all sharing the question slug as post_id.
function quoraRowsFor(data: QuoraQuestionWithAnswers, sourceUrl: string): VocRow[] {
  const rows: VocRow[] = []
  const postId = data.question.slug
  const postUrl = data.question.url
  rows.push({
    platform: "quora",
    source_url: sourceUrl,
    post_id: postId,
    post_url: postUrl,
    row_type: "post",
    author: "",
    timestamp: "",
    upvotes: "",
    category: classifyComment(data.question.title),
    text: oneLineText(data.question.title),
  })
  for (const answer of data.answers) {
    const answerUrl = answer.permalink ?? postUrl
    rows.push({
      platform: "quora",
      source_url: sourceUrl,
      post_id: postId,
      post_url: answerUrl,
      row_type: "answer",
      author: answer.author,
      timestamp: answer.date ?? "",
      upvotes: votesCell(answer.upvotes),
      category: classifyComment(answer.body),
      text: oneLineText(answer.body),
    })
    for (const c of answer.comments ?? []) {
      rows.push({
        platform: "quora",
        source_url: sourceUrl,
        post_id: postId,
        post_url: answerUrl,
        row_type: "comment",
        author: c.author,
        timestamp: "",
        upvotes: votesCell(c.upvotes),
        category: classifyComment(c.body),
        text: oneLineText(c.body),
      })
    }
  }
  return rows
}

// Deep-scrape posts AND their comment threads from Facebook groups, subreddits, Amazon products,
// and/or Quora questions/topics (each Amazon product becomes a "post" row with its reviews as
// "review" rows; each Quora question becomes a "post" row with its answers as "answer" rows).
async function gatherVoiceRows(opts: {
  readonly facebookGroups: readonly string[]
  readonly subreddits: readonly string[]
  readonly amazonProducts: readonly string[]
  readonly quoraQuestions: readonly string[]
  readonly quoraTopics: readonly string[]
  readonly postsPerSource: number
  readonly amazonReviewLimit: number
  readonly quoraAnswerLimit: number
  readonly redditTime: string
  readonly amazonSort: string
  readonly errors: string[]
}): Promise<VocRow[]> {
  const rows: VocRow[] = []

  for (const group of opts.facebookGroups) {
    const fb = unwrapFacebookClient()
    const result = await fb.getGroupComments(group, { postLimit: opts.postsPerSource })
    result.fold(
      (err) => {
        opts.errors.push(`Facebook "${group}": ${err.message}`)
      },
      (data) => {
        for (const thread of data.threads) {
          const postId = thread.post.id
          const postUrl = thread.post.permalink ?? data.groupUrl
          rows.push({
            platform: "facebook",
            source_url: data.groupUrl,
            post_id: postId,
            post_url: postUrl,
            row_type: "post",
            author: thread.post.author,
            timestamp: thread.post.timestamp ?? "",
            upvotes: votesCell(thread.post.likeCount),
            category: classifyComment(thread.post.text),
            text: oneLineText(thread.post.text),
          })
          for (const c of thread.comments) {
            rows.push({
              platform: "facebook",
              source_url: data.groupUrl,
              post_id: postId,
              post_url: postUrl,
              row_type: "comment",
              author: c.author,
              timestamp: c.timestamp ?? "",
              upvotes: votesCell(c.likeCount),
              category: classifyComment(c.text),
              text: oneLineText(c.text),
            })
          }
        }
      },
    )
  }

  for (const sub of opts.subreddits) {
    const reddit = unwrapClient()
    const cleanSub = sub.replace(/^r\//i, "")
    const sourceUrl = `https://reddit.com/r/${cleanSub}`
    const postsResult = await reddit.getTopPosts(cleanSub, opts.redditTime, opts.postsPerSource)
    const posts = postsResult.fold(
      (err) => {
        opts.errors.push(`Reddit r/${cleanSub}: ${err.message}`)
        return [] as readonly RedditPost[]
      },
      (page) => page.items,
    )
    for (const post of posts) {
      const postUrl = `https://reddit.com${post.permalink}`
      const postText = [post.title, post.selftext].filter((t) => t !== undefined && t.trim() !== "").join("\n")
      rows.push({
        platform: "reddit",
        source_url: sourceUrl,
        post_id: post.id,
        post_url: postUrl,
        row_type: "post",
        author: post.author,
        timestamp: new Date(post.createdUtc * 1000).toISOString(),
        upvotes: votesCell(post.score),
        category: classifyComment(postText),
        text: oneLineText(postText),
      })
      const commentsResult = await reddit.getPostComments(post.id, cleanSub, { limit: 200 })
      commentsResult.fold(
        () => undefined,
        ({ comments }) => {
          for (const c of comments) {
            rows.push({
              platform: "reddit",
              source_url: sourceUrl,
              post_id: post.id,
              post_url: postUrl,
              row_type: "comment",
              author: c.author,
              timestamp: new Date(c.createdUtc * 1000).toISOString(),
              upvotes: votesCell(c.score),
              category: classifyComment(c.body),
              text: oneLineText(c.body),
            })
          }
        },
      )
    }
  }

  for (const product of opts.amazonProducts) {
    const amz = unwrapAmazonClient()
    const result = await amz.getProductReviews(product, {
      limit: opts.amazonReviewLimit,
      sort: opts.amazonSort as AmazonReviewSort,
    })
    result.fold(
      (err) => {
        opts.errors.push(`Amazon "${product}": ${err.message}`)
      },
      (data) => {
        const postId = data.product.asin
        const productUrl = data.product.url
        rows.push({
          platform: "amazon",
          source_url: productUrl,
          post_id: postId,
          post_url: productUrl,
          row_type: "post",
          author: data.product.brand ?? "",
          timestamp: "",
          upvotes: "",
          category: "other",
          text: oneLineText(data.product.title),
        })
        for (const review of data.reviews) {
          // Combine the headline + body so short reviews still carry their title's signal.
          const reviewText = oneLineText([review.title, review.body].filter((t) => t.trim() !== "").join(" — "))
          rows.push({
            platform: "amazon",
            source_url: productUrl,
            post_id: postId,
            post_url: review.permalink ?? productUrl,
            row_type: "review",
            author: review.author,
            timestamp: review.date ?? "",
            // Amazon's "N people found this helpful" - the closest analog to an upvote.
            upvotes: votesCell(review.helpfulVotes),
            category: classifyReview(reviewText, review.rating),
            text: reviewText,
          })
        }
      },
    )
  }

  for (const ref of opts.quoraQuestions) {
    const quora = unwrapQuoraClient()
    const result = await quora.getQuestion(ref, { maxAnswers: opts.quoraAnswerLimit })
    result.fold(
      (err) => {
        opts.errors.push(`Quora "${ref}": ${err.message}`)
      },
      (data) => {
        rows.push(...quoraRowsFor(data, data.question.url))
      },
    )
  }

  // For a topic/Space, list its questions then open each (capped at postsPerSource) for its answers.
  for (const topic of opts.quoraTopics) {
    const quora = unwrapQuoraClient()
    const topicUrl = buildTopicUrl(topic)
    const listResult = await quora.getTopicQuestions(topic, { limit: opts.postsPerSource })
    const questions = listResult.fold(
      (err) => {
        opts.errors.push(`Quora topic "${topic}": ${err.message}`)
        return []
      },
      (q) => q,
    )
    for (const question of questions) {
      const result = await quora.getQuestion(question.url, { maxAnswers: opts.quoraAnswerLimit })
      result.fold(
        () => undefined,
        (data) => {
          rows.push(...quoraRowsFor(data, topicUrl))
        },
      )
    }
  }

  return rows
}

server.addTool({
  name: "build_customer_persona",
  description:
    "Build a Schwartz 'Breakthrough Advertising' customer persona brief from customer discussion. Provide raw " +
    "'texts' and/or a 'facebook_group'/'subreddits'/'amazon_products'/'quora_questions'/'quora_topics' to auto-scrape " +
    "(it pulls POSTS *and* their COMMENTS, Amazon products *and* their REVIEWS, and Quora questions *and* their " +
    "ANSWERS). Returns mined evidence organized into mass desire, awareness stages, and market sophistication, plus " +
    "synthesis steps.",
  parameters: z.object({
    texts: z.array(z.string()).default([]).describe("Raw customer discussion snippets to analyze (optional)"),
    facebook_group: z.string().optional().describe("Optional Facebook group id/slug/URL - posts + comments scraped"),
    subreddits: z.array(z.string()).default([]).describe("Optional subreddits to scrape posts + comments from"),
    amazon_products: z
      .array(z.string())
      .default([])
      .describe("Optional Amazon ASINs or product URLs to scrape reviews from"),
    quora_questions: z
      .array(z.string())
      .default([])
      .describe("Optional Quora question URLs/slugs to scrape answers from"),
    quora_topics: z
      .array(z.string())
      .default([])
      .describe("Optional Quora topic names or topic/Space URLs to scrape questions + answers from"),
    posts_per_source: z
      .number()
      .min(1)
      .max(100)
      .default(25)
      .describe("Posts/questions to open per Facebook/Reddit/Quora-topic source"),
    amazon_review_limit: z.number().min(1).max(500).default(50).describe("Reviews to pull per Amazon product"),
    quora_answer_limit: z.number().min(1).max(200).default(50).describe("Answers to pull per Quora question"),
    reddit_time: z
      .enum(["hour", "day", "week", "month", "year", "all"])
      .default("month")
      .describe("Reddit time window"),
    product_context: z.string().optional().describe("Optional product/niche context to frame the persona"),
  }),
  execute: async (args) => {
    const errors: string[] = []
    const fbGroups =
      args.facebook_group !== undefined && args.facebook_group.trim() !== "" ? [args.facebook_group.trim()] : []
    const rows =
      fbGroups.length > 0 ||
      args.subreddits.length > 0 ||
      args.amazon_products.length > 0 ||
      args.quora_questions.length > 0 ||
      args.quora_topics.length > 0
        ? await gatherVoiceRows({
            facebookGroups: fbGroups,
            subreddits: args.subreddits,
            amazonProducts: args.amazon_products,
            quoraQuestions: args.quora_questions,
            quoraTopics: args.quora_topics,
            postsPerSource: args.posts_per_source,
            amazonReviewLimit: args.amazon_review_limit,
            quoraAnswerLimit: args.quora_answer_limit,
            redditTime: args.reddit_time,
            amazonSort: "recent",
            errors,
          })
        : []

    // Feed posts plus valuable comments/reviews/answers into the persona corpus.
    const scrapedTexts = rows
      .filter((r) => r.text.trim().length > 0 && (r.row_type === "post" || isValuableComment(r.text)))
      .map((r) => r.text)
    const texts = [...args.texts, ...scrapedTexts]
    if (texts.length === 0) {
      // eslint-disable-next-line functype/prefer-either
      throw new Error(
        "Provide 'texts' and/or a 'facebook_group'/'subreddits'/'amazon_products'/'quora_questions'/'quora_topics' " +
          "with accessible content.",
      )
    }

    const sources = [
      ...fbGroups.map((g) => `FB:${g}`),
      ...args.subreddits.map((s) => `r/${s.replace(/^r\//i, "")}`),
      ...args.amazon_products.map((p) => `AMZN:${p}`),
      ...args.quora_questions.map((q) => `QUORA:${q}`),
      ...args.quora_topics.map((t) => `QUORA-TOPIC:${t}`),
    ]
    const sourceLabel =
      sources.length > 0
        ? `${sources.join(", ")} (${scrapedTexts.length} posts + comments)${args.texts.length > 0 ? " + supplied texts" : ""}`
        : "supplied discussion corpus"

    return buildPersonaBrief({ texts, productContext: args.product_context, sourceLabel })
  },
})

server.addTool({
  name: "export_comments_csv",
  description:
    "Scrape Facebook groups, Reddit subreddits, Amazon products, and/or Quora questions/topics to a CSV - one row " +
    "per POST/PRODUCT/QUESTION and per COMMENT/REVIEW/ANSWER, linked by a shared post_id (row_type 'post', 'comment', " +
    "'review', or 'answer'; Amazon post_id = ASIN, Quora post_id = slug). Columns: platform, source_url, post_id, " +
    "post_url, row_type, author, timestamp, upvotes, category (pain/desire/objection/question/other), text. The " +
    "'upvotes' column is the crowd-validation signal (Reddit score, Facebook reactions, Amazon 'found helpful' votes, " +
    "Quora answer upvotes) - sort by it to rank pains/desires by social proof. Sort by post_id to see each post with " +
    "its comments/reviews/answers. Low-value reactions are filtered out by default.",
  parameters: z.object({
    facebook_groups: z
      .array(z.string())
      .default([])
      .describe("Facebook group ids, slugs, or URLs to scrape (must be a member of private ones)"),
    subreddits: z.array(z.string()).default([]).describe("Subreddit names to scrape (without the r/)"),
    amazon_products: z.array(z.string()).default([]).describe("Amazon ASINs or product URLs to scrape reviews from"),
    quora_questions: z.array(z.string()).default([]).describe("Quora question URLs/slugs to scrape answers from"),
    quora_topics: z
      .array(z.string())
      .default([])
      .describe("Quora topic names or topic/Space URLs to scrape questions + answers from"),
    posts_per_source: z
      .number()
      .min(1)
      .max(200)
      .default(30)
      .describe("How many recent posts/questions to open per FB/Reddit/Quora-topic source"),
    amazon_review_limit: z.number().min(1).max(500).default(50).describe("How many reviews to pull per Amazon product"),
    quora_answer_limit: z.number().min(1).max(200).default(50).describe("How many answers to pull per Quora question"),
    min_words: z
      .number()
      .min(1)
      .max(50)
      .default(4)
      .describe("Minimum words for a comment/review/answer to count as valuable"),
    include_low_value: z.boolean().default(false).describe("Keep low-signal reactions too (default: filter them out)"),
    reddit_time: z
      .enum(["hour", "day", "week", "month", "year", "all"])
      .default("month")
      .describe("Time window for Reddit top posts"),
    output_path: z
      .string()
      .optional()
      .describe("Where to save the CSV (default: ./voice-of-customer-<timestamp>.csv in the project folder)"),
  }),
  execute: async (args) => {
    if (
      args.facebook_groups.length === 0 &&
      args.subreddits.length === 0 &&
      args.amazon_products.length === 0 &&
      args.quora_questions.length === 0 &&
      args.quora_topics.length === 0
    ) {
      // eslint-disable-next-line functype/prefer-either
      throw new Error(
        "Provide at least one entry in facebook_groups, subreddits, amazon_products, quora_questions, or quora_topics.",
      )
    }

    const errors: string[] = []
    const rows = await gatherVoiceRows({
      facebookGroups: args.facebook_groups,
      subreddits: args.subreddits,
      amazonProducts: args.amazon_products,
      quoraQuestions: args.quora_questions,
      quoraTopics: args.quora_topics,
      postsPerSource: args.posts_per_source,
      amazonReviewLimit: args.amazon_review_limit,
      quoraAnswerLimit: args.quora_answer_limit,
      redditTime: args.reddit_time,
      amazonSort: "recent",
      errors,
    })

    // Keep every post/product; filter comments AND reviews by value. Drop empties and exact dupes.
    const seen = new Set<string>()
    const kept = rows.filter((r) => {
      if (r.text.trim() === "") {
        return false
      }
      if (r.row_type !== "post" && !args.include_low_value && !isValuableComment(r.text, args.min_words)) {
        return false
      }
      const key = `${r.platform}|${r.row_type}|${r.text.toLowerCase()}`
      if (seen.has(key)) {
        return false
      }
      seen.add(key)
      return true
    })

    if (kept.length === 0) {
      const detail = errors.length > 0 ? `\n\nIssues:\n- ${errors.join("\n- ")}` : ""
      // eslint-disable-next-line functype/prefer-either
      throw new Error(`Nothing was scraped. Make sure you're logged in and a member of any private groups.${detail}`)
    }

    const stamp = new Date().toISOString().replace(/:/g, "-").replace(/\..+$/, "").replace("T", "_")
    const fileName = `voice-of-customer-${stamp}.csv`
    const target =
      args.output_path !== undefined && args.output_path.trim() !== ""
        ? isAbsolute(args.output_path)
          ? args.output_path
          : join(process.cwd(), args.output_path)
        : join(process.cwd(), fileName)

    writeFileSync(target, toCsv(VOC_COLUMNS, kept as unknown as Record<string, string>[]), "utf8")

    const postCount = kept.filter((r) => r.row_type === "post").length
    const commentCount = kept.filter((r) => r.row_type === "comment").length
    const reviewCount = kept.filter((r) => r.row_type === "review").length
    const answerCount = kept.filter((r) => r.row_type === "answer").length
    const fbCount = kept.filter((r) => r.platform === "facebook").length
    const redditCount = kept.filter((r) => r.platform === "reddit").length
    const amazonCount = kept.filter((r) => r.platform === "amazon").length
    const quoraCount = kept.filter((r) => r.platform === "quora").length
    const cats = ["pain", "desire", "objection", "question", "other"]
      .map((cat) => `${cat}=${kept.filter((r) => r.category === cat).length}`)
      .join(", ")
    const preview = kept
      .slice(0, 5)
      .map((r) => `- [${r.platform} · ${r.row_type} · ${r.category}] ${r.text.slice(0, 100)}`)
      .join("\n")

    return `# Voice-of-Customer CSV exported ✅

Saved **${kept.length}** rows (${postCount} posts/products/questions + ${commentCount} comments + ${reviewCount} reviews + ${answerCount} answers) to:
\`${target}\`

- Platform: facebook=${fbCount}, reddit=${redditCount}, amazon=${amazonCount}, quora=${quoraCount}
- Category: ${cats}
- Columns: ${VOC_COLUMNS.join(", ")}
- 🔗 Each comment/review links to its post/product via **post_id** (sort by post_id to group them).
${errors.length > 0 ? `\n⚠️ Some sources had issues:\n- ${errors.join("\n- ")}\n` : ""}
### Preview (first 5 rows)
${preview}`
  },
})
/* eslint-enable functype/no-imperative-loops, functype/prefer-map */

// Initialize and start server
async function main() {
  await setupRedditClient()
  await setupFacebookClient()
  await setupAmazonClient()
  await setupQuoraClient()
  await setupMetaAdsClient()

  const useHttp = process.env.TRANSPORT_TYPE === "httpStream" || process.env.TRANSPORT_TYPE === "http"
  const port = parseInt(process.env.PORT ?? "3000")
  const host = process.env.HOST ?? "127.0.0.1"

  if (useHttp) {
    console.error(`[Setup] Starting HTTP server on ${host}:${port}`)
    await server.start({
      transportType: "httpStream",
      httpStream: {
        port,
        host,
        endpoint: "/mcp",
      },
    })
    console.error(`[Setup] HTTP server ready at http://${host}:${port}/mcp`)
    console.error(`[Setup] SSE endpoint available at http://${host}:${port}/sse`)
  } else {
    console.error("[Setup] Starting in stdio mode")
    if (process.stdin.isTTY) {
      console.error(
        "[Setup] ⚠ stdin is a terminal. This server speaks MCP JSON-RPC over stdio and expects an MCP client " +
          "(Claude Desktop, Claude Code, MCP Inspector) on the other end — typed input will cause JSON parse errors.",
      )
      console.error("[Setup]   Test interactively: npx @modelcontextprotocol/inspector npx reddit-mcp-server")
      console.error("[Setup]   Or run as HTTP:       TRANSPORT_TYPE=httpStream npx reddit-mcp-server")
    }
    await server.start({
      transportType: "stdio",
    })
  }
}

// Handle graceful shutdown
process.on("SIGINT", () => {
  console.error("[Shutdown] Shutting down Reddit MCP Server...")
  process.exit(0)
})

process.on("SIGTERM", () => {
  console.error("[Shutdown] Shutting down Reddit MCP Server...")
  process.exit(0)
})

void main().catch(console.error)

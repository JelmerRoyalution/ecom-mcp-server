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
import type { BotDisclosureConfig, CacheConfig, RedditAuthMode, RedditSafeMode, SafeModeConfig } from "./types"
import { toCsv } from "./utils/csv"
import { formatPostInfo, formatSubredditInfo, formatUserInfo } from "./utils/formatters"

// A current desktop Chrome UA - used for Facebook fetches when none is provided.
const DEFAULT_FACEBOOK_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

// A current desktop Chrome UA - used for Amazon fetches when none is provided.
const DEFAULT_AMAZON_UA =
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
  })

  console.error("[Setup] Reddit client initialized")
  console.error(`[Setup] Authentication mode: ${authMode}`)

  if (authMode === "anonymous" || !hasCredentials) {
    console.error("[Setup] Using anonymous Reddit API (~10 req/min)")
    console.error("[Setup] No authentication required - ready to use!")
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
groups, AND Amazon product reviews, then turns them into customer personas using Eugene Schwartz's
"Breakthrough Advertising" framework.

Reddit capabilities:
- Fetch Reddit posts, comments, and user information
- Get subreddit details and statistics
- Search Reddit content across posts and subreddits
- Create posts and reply to posts/comments (with authentication)
- Edit your own posts and comments (with authentication)
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

Customer-persona workflow (Schwartz "Breakthrough Advertising"):
- analyze_voice_of_customer: mine a corpus of comments/posts/reviews into pains, desires, objections,
  questions, emotional triggers, product mentions, and verbatim quotes
- build_customer_persona: assemble a persona brief organized by mass desire, the 5 awareness stages, and
  the 5 market-sophistication levels - then synthesize the persona from that evidence
- These persona tools are platform-agnostic: feed them text scraped from Reddit, Facebook, Amazon, or all.

For Reddit write operations (posting, replying, editing, deleting), ensure REDDIT_USERNAME and REDDIT_PASSWORD are configured.

IMPORTANT - research data ethics:
- Scraped discussion is for aggregate customer-persona research only. Do NOT de-anonymize, profile, or
  re-identify individuals, and do NOT republish people's verbatim posts/comments/reviews as-is.
- Respect Facebook's, Reddit's, and Amazon's Terms; only access private groups you are legitimately a
  member of, and use your own logged-in session for any Amazon depth scraping.

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
  description: "Test the Reddit MCP Server connection and configuration",
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
- Write Access: ${hasWriteAccess} ${hasWriteAccess === "✓" ? "Available" : "Read-only mode"}
- Version: ${VERSION}

Ready to handle Reddit API requests!`)
  },
})

// User tools
server.addTool({
  name: "get_user_info",
  description: "Get detailed information about a Reddit user including karma, account status, and activity analysis",
  parameters: z.object({
    username: z.string().describe("The Reddit username (without u/ prefix)"),
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
- Account Status: ${formattedUser.accountStatus.join(", ")}
- Account Created: ${formattedUser.accountCreated}
- Profile URL: ${formattedUser.profileUrl}

## Activity Analysis
- ${formattedUser.activityAnalysis.replace(/\n {2}- /g, "\n- ")}

## Recommendations
- ${formattedUser.recommendations.replace(/\n {2}- /g, "\n- ")}`
      },
    )
  },
})

server.addTool({
  name: "get_user_posts",
  description: "Get recent posts by a Reddit user with sorting and filtering options",
  parameters: z.object({
    username: z.string().describe("The Reddit username (without u/ prefix)"),
    sort: z.enum(["new", "hot", "top"]).default("new").describe("Sort order for posts"),
    time_filter: z
      .enum(["hour", "day", "week", "month", "year", "all"])
      .default("all")
      .describe("Time filter for top posts"),
    limit: z.number().min(1).max(100).default(10).describe("Number of posts to retrieve"),
  }),
  execute: async (args) => {
    const client = unwrapClient()

    const result = await client.getUserPosts(args.username, {
      sort: args.sort,
      timeFilter: args.time_filter,
      limit: args.limit,
    })

    return result.fold(
      (err) => {
        // eslint-disable-next-line functype/prefer-either
        throw new Error(`Failed to get user posts: ${err.message}`)
      },
      (posts) => {
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

${postSummaries}`
      },
    )
  },
})

server.addTool({
  name: "get_user_comments",
  description: "Get recent comments by a Reddit user with sorting and filtering options",
  parameters: z.object({
    username: z.string().describe("The Reddit username (without u/ prefix)"),
    sort: z.enum(["new", "hot", "top"]).default("new").describe("Sort order for comments"),
    time_filter: z
      .enum(["hour", "day", "week", "month", "year", "all"])
      .default("all")
      .describe("Time filter for top comments"),
    limit: z.number().min(1).max(100).default(10).describe("Number of comments to retrieve"),
  }),
  execute: async (args) => {
    const client = unwrapClient()

    const result = await client.getUserComments(args.username, {
      sort: args.sort,
      timeFilter: args.time_filter,
      limit: args.limit,
    })

    return result.fold(
      (err) => {
        // eslint-disable-next-line functype/prefer-either
        throw new Error(`Failed to get user comments: ${err.message}`)
      },
      (comments) => {
        if (comments.length === 0) {
          return `No comments found for u/${args.username} with the specified filters.`
        }

        const commentSummaries = comments
          .map((comment, index) => {
            const truncatedBody = comment.body.length > 300 ? `${comment.body.substring(0, 300)}...` : comment.body

            const flags = [...(comment.edited ? ["*(edited)*"] : []), ...(comment.isSubmitter ? ["**OP**"] : [])]

            return `### ${index + 1}. Comment ${flags.join(" ")}
In r/${comment.subreddit} on "${comment.submissionTitle}"

> ${truncatedBody}

- Score: ${comment.score.toLocaleString()}
- Posted: ${new Date(comment.createdUtc * 1000).toLocaleString()}
- Link: https://reddit.com${comment.permalink}`
          })
          .join("\n\n")

        return `# Comments by u/${args.username} (${args.sort} - ${args.time_filter})

${commentSummaries}`
      },
    )
  },
})

// Post tools
server.addTool({
  name: "get_reddit_post",
  description:
    "Get detailed information about a specific Reddit post including content, stats, and engagement analysis",
  parameters: z.object({
    subreddit: z.string().describe("The subreddit name (without r/ prefix)"),
    post_id: z.string().describe("The Reddit post ID"),
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
${formattedPost.bestTimeToEngage}`
      },
    )
  },
})

server.addTool({
  name: "get_top_posts",
  description: "Get top posts from a subreddit or from the Reddit home feed",
  parameters: z.object({
    subreddit: z.string().optional().describe("The subreddit name (without r/ prefix). Leave empty for home feed"),
    time_filter: z
      .enum(["hour", "day", "week", "month", "year", "all"])
      .default("week")
      .describe("Time period for top posts"),
    limit: z.number().min(1).max(100).default(10).describe("Number of posts to retrieve"),
  }),
  execute: async (args) => {
    const client = unwrapClient()

    const result = await client.getTopPosts(args.subreddit ?? "", args.time_filter, args.limit)
    return result.fold(
      (err) => {
        // eslint-disable-next-line functype/prefer-either
        throw new Error(`Failed to get top posts: ${err.message}`)
      },
      (posts) => {
        if (posts.length === 0) {
          const location = Option(args.subreddit).fold(
            () => "home feed",
            (sr) => `r/${sr}`,
          )
          return `No posts found in ${location} for the specified time period.`
        }

        const formattedPosts = posts.map(formatPostInfo)
        const postSummaries = formattedPosts
          .map(
            (post, index) => `### ${index + 1}. ${post.title}
- Author: u/${post.author}
- Score: ${post.stats.score.toLocaleString()} (${(post.stats.upvoteRatio * 100).toFixed(1)}% upvoted)
- Comments: ${post.stats.comments.toLocaleString()}
- Posted: ${post.metadata.posted}
- Link: ${post.links.shortLink}`,
          )
          .join("\n\n")

        const location = Option(args.subreddit).fold(
          () => "Home Feed",
          (sr) => `r/${sr}`,
        )
        return `# Top Posts from ${location} (${args.time_filter})

${postSummaries}`
      },
    )
  },
})

server.addTool({
  name: "browse_subreddit",
  description:
    "Browse posts from a subreddit or the Reddit home feed with a sort order (hot, new, top, rising, controversial). " +
    "The time_filter only applies to top and controversial sorts.",
  parameters: z.object({
    subreddit: z.string().optional().describe("The subreddit name (without r/ prefix). Leave empty for home feed"),
    sort: z.enum(["hot", "new", "top", "rising", "controversial"]).default("hot").describe("Sort order for posts"),
    time_filter: z
      .enum(["hour", "day", "week", "month", "year", "all"])
      .default("week")
      .describe("Time period (only applies to top and controversial sorts)"),
    limit: z.number().min(1).max(100).default(10).describe("Number of posts to retrieve"),
  }),
  execute: async (args) => {
    const client = unwrapClient()

    const result = await client.browseSubreddit(args.subreddit ?? "", args.sort, args.time_filter, args.limit)
    return result.fold(
      (err) => {
        // eslint-disable-next-line functype/prefer-either
        throw new Error(`Failed to browse subreddit: ${err.message}`)
      },
      (posts) => {
        const location = Option(args.subreddit).fold(
          () => "home feed",
          (sr) => `r/${sr}`,
        )
        if (posts.length === 0) {
          return `No posts found in ${location}.`
        }

        const formattedPosts = posts.map(formatPostInfo)
        const postSummaries = formattedPosts
          .map(
            (post, index) => `### ${index + 1}. ${post.title}
- Author: u/${post.author}
- Score: ${post.stats.score.toLocaleString()} (${(post.stats.upvoteRatio * 100).toFixed(1)}% upvoted)
- Comments: ${post.stats.comments.toLocaleString()}
- Posted: ${post.metadata.posted}
- Link: ${post.links.shortLink}`,
          )
          .join("\n\n")

        const timeSuffix = args.sort === "top" || args.sort === "controversial" ? `, ${args.time_filter}` : ""
        const heading = location === "home feed" ? "Home Feed" : location
        return `# ${args.sort} posts from ${heading} (${args.sort}${timeSuffix})

${postSummaries}`
      },
    )
  },
})

// Subreddit tools
server.addTool({
  name: "get_subreddit_info",
  description: "Get detailed information about a subreddit including description, stats, and community analysis",
  parameters: z.object({
    subreddit_name: z.string().describe("The subreddit name (without r/ prefix)"),
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
- ${formattedSubreddit.engagementTips.replace(/\n {2}- /g, "\n- ")}`
      },
    )
  },
})

server.addTool({
  name: "get_trending_subreddits",
  description: "Get a list of currently trending subreddits",
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
  description: "Search Reddit for posts and content across subreddits",
  parameters: z.object({
    query: z.string().describe("Search query"),
    subreddit: z.string().optional().describe("Limit search to specific subreddit (without r/ prefix)"),
    sort: z.enum(["relevance", "hot", "top", "new", "comments"]).default("relevance").describe("Sort order"),
    time_filter: z.enum(["hour", "day", "week", "month", "year", "all"]).default("all").describe("Time filter"),
    limit: z.number().min(1).max(100).default(10).describe("Number of results"),
    type: z.enum(["link", "sr", "user"]).default("link").describe("Type of content to search"),
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
    })

    return result.fold(
      (err) => {
        // eslint-disable-next-line functype/prefer-either
        throw new Error(`Failed to search: ${err.message}`)
      },
      (posts) => {
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

Sorted by: ${args.sort} | Time: ${args.time_filter} | Type: ${args.type}

${searchResults}`
      },
    )
  },
})

// Write tools (require user authentication)
server.addTool({
  name: "create_post",
  description:
    "Create a new post in a subreddit (requires REDDIT_USERNAME and REDDIT_PASSWORD). " +
    "WARNING: Rapid posting or duplicate content may trigger Reddit's spam detection and result in account bans. " +
    "Consider enabling REDDIT_SAFE_MODE=standard for protection.",
  parameters: z.object({
    subreddit: z.string().describe("The subreddit name (without r/ prefix)"),
    title: z.string().describe("The post title"),
    content: z.string().describe("The post content (text for self posts, URL for link posts)"),
    is_self: z.boolean().default(true).describe("Whether this is a self post (text) or link post"),
  }),
  execute: async (args) => {
    const client = unwrapClient()

    if (process.env.REDDIT_USERNAME === undefined || process.env.REDDIT_PASSWORD === undefined) {
      // eslint-disable-next-line functype/prefer-either
      throw new Error(
        "User authentication required. Please set REDDIT_USERNAME and REDDIT_PASSWORD environment variables.",
      )
    }

    const result = await client.createPost(args.subreddit, args.title, args.content, args.is_self)
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
    "Post a reply to an existing Reddit post or comment (requires REDDIT_USERNAME and REDDIT_PASSWORD). " +
    "WARNING: Rapid commenting or duplicate content may trigger Reddit's spam detection. " +
    "Enable REDDIT_SAFE_MODE=standard for rate limiting and duplicate detection.",
  parameters: z.object({
    post_id: z.string().describe("The Reddit post ID (thing_id, e.g., t3_xxxxx for posts, t1_xxxxx for comments)"),
    content: z.string().describe("The reply content"),
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
    "Delete your own Reddit post (requires REDDIT_USERNAME and REDDIT_PASSWORD). WARNING: This action is permanent and cannot be undone!",
  parameters: z.object({
    thing_id: z
      .string()
      .describe(
        "The full Reddit thing ID (e.g., 't3_abc123' for posts) or just the post ID (e.g., 'abc123'). The 't3_' prefix will be added automatically if missing.",
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
    "Delete your own Reddit comment (requires REDDIT_USERNAME and REDDIT_PASSWORD). WARNING: This action is permanent and cannot be undone!",
  parameters: z.object({
    thing_id: z
      .string()
      .describe(
        "The full Reddit thing ID (e.g., 't1_abc123' for comments) or just the comment ID (e.g., 'abc123'). The 't1_' prefix will be added automatically if missing.",
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
    "Edit your own Reddit post (self-text posts only, requires REDDIT_USERNAME and REDDIT_PASSWORD). " +
    "You can only edit the text content of self posts, not titles or link posts. " +
    "WARNING: Rapid edits may trigger spam detection. Enable REDDIT_SAFE_MODE for protection.",
  parameters: z.object({
    thing_id: z
      .string()
      .describe(
        "The full Reddit thing ID (e.g., 't3_abc123' for posts) or just the post ID (e.g., 'abc123'). The 't3_' prefix will be added automatically if missing.",
      ),
    new_text: z.string().describe("The new text content for the post. Supports Reddit markdown formatting."),
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
    "Edit your own Reddit comment (requires REDDIT_USERNAME and REDDIT_PASSWORD). " +
    "Update the text content of a comment you previously posted. " +
    "WARNING: Rapid edits may trigger spam detection. Enable REDDIT_SAFE_MODE for protection.",
  parameters: z.object({
    thing_id: z
      .string()
      .describe(
        "The full Reddit thing ID (e.g., 't1_abc123' for comments) or just the comment ID (e.g., 'abc123'). The 't1_' prefix will be added automatically if missing.",
      ),
    new_text: z.string().describe("The new text content for the comment. Supports Reddit markdown formatting."),
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

// Comment tools
server.addTool({
  name: "get_post_comments",
  description: "Get comments from a specific Reddit post",
  parameters: z.object({
    post_id: z.string().describe("The Reddit post ID"),
    subreddit: z.string().describe("The subreddit name (without r/ prefix)"),
    sort: z.enum(["best", "top", "new", "controversial", "old", "qa"]).default("best").describe("Comment sort order"),
    limit: z.number().min(1).max(500).default(100).describe("Maximum number of comments to retrieve"),
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
      ({ post, comments }) => {
        const header = `# Comments for: ${post.title}

**Post by u/${post.author} in r/${post.subreddit}**
- Score: ${post.score.toLocaleString()} | Comments: ${post.numComments.toLocaleString()}
- Posted: ${new Date(post.createdUtc * 1000).toLocaleString()}

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

        return header + commentSummaries
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

// One flat row of voice-of-customer data. Each post/product emits a row_type="post" row, then
// its comments (row_type="comment") or reviews (row_type="review") sharing the same post_id - so
// the parent<->child relationship is explicit (group or sort by post_id). For Amazon, the
// product is the "post" (post_id = ASIN) and each review is a "review" row.
//
// `upvotes` is the platform's social-proof signal so you can rank by what the crowd validated:
// Reddit = comment/post score, Facebook = reactions/likes, Amazon = "found helpful" votes.
type VocRow = {
  platform: "facebook" | "reddit" | "amazon"
  source_url: string
  post_id: string
  post_url: string
  row_type: "post" | "comment" | "review"
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

// Deep-scrape posts AND their comment threads from Facebook groups, subreddits, and/or Amazon
// products (each Amazon product becomes a "post" row with its reviews as "review" rows).
async function gatherVoiceRows(opts: {
  readonly facebookGroups: readonly string[]
  readonly subreddits: readonly string[]
  readonly amazonProducts: readonly string[]
  readonly postsPerSource: number
  readonly amazonReviewLimit: number
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
        return []
      },
      (p) => p,
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

  return rows
}

server.addTool({
  name: "build_customer_persona",
  description:
    "Build a Schwartz 'Breakthrough Advertising' customer persona brief from customer discussion. Provide raw " +
    "'texts' and/or a 'facebook_group'/'subreddits'/'amazon_products' to auto-scrape (it pulls POSTS *and* their " +
    "COMMENTS, and Amazon products *and* their REVIEWS). Returns mined evidence organized into mass desire, " +
    "awareness stages, and market sophistication, plus synthesis steps.",
  parameters: z.object({
    texts: z.array(z.string()).default([]).describe("Raw customer discussion snippets to analyze (optional)"),
    facebook_group: z.string().optional().describe("Optional Facebook group id/slug/URL - posts + comments scraped"),
    subreddits: z.array(z.string()).default([]).describe("Optional subreddits to scrape posts + comments from"),
    amazon_products: z
      .array(z.string())
      .default([])
      .describe("Optional Amazon ASINs or product URLs to scrape reviews from"),
    posts_per_source: z.number().min(1).max(100).default(25).describe("Posts to open per Facebook/Reddit source"),
    amazon_review_limit: z.number().min(1).max(500).default(50).describe("Reviews to pull per Amazon product"),
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
      fbGroups.length > 0 || args.subreddits.length > 0 || args.amazon_products.length > 0
        ? await gatherVoiceRows({
            facebookGroups: fbGroups,
            subreddits: args.subreddits,
            amazonProducts: args.amazon_products,
            postsPerSource: args.posts_per_source,
            amazonReviewLimit: args.amazon_review_limit,
            redditTime: args.reddit_time,
            amazonSort: "recent",
            errors,
          })
        : []

    // Feed posts plus valuable comments/reviews into the persona corpus.
    const scrapedTexts = rows
      .filter((r) => r.text.trim().length > 0 && (r.row_type === "post" || isValuableComment(r.text)))
      .map((r) => r.text)
    const texts = [...args.texts, ...scrapedTexts]
    if (texts.length === 0) {
      // eslint-disable-next-line functype/prefer-either
      throw new Error(
        "Provide 'texts' and/or a 'facebook_group'/'subreddits'/'amazon_products' with accessible content.",
      )
    }

    const sources = [
      ...fbGroups.map((g) => `FB:${g}`),
      ...args.subreddits.map((s) => `r/${s.replace(/^r\//i, "")}`),
      ...args.amazon_products.map((p) => `AMZN:${p}`),
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
    "Scrape Facebook groups, Reddit subreddits, and/or Amazon products to a CSV - one row per POST/PRODUCT and per " +
    "COMMENT/REVIEW, linked by a shared post_id (row_type 'post', 'comment', or 'review'; Amazon post_id = ASIN). " +
    "Columns: platform, source_url, post_id, post_url, row_type, author, timestamp, upvotes, category " +
    "(pain/desire/objection/question/other), text. The 'upvotes' column is the crowd-validation signal (Reddit " +
    "score, Facebook reactions, Amazon 'found helpful' votes) - sort by it to rank pains/desires by social proof. " +
    "Sort by post_id to see each post with its comments/reviews. Low-value reactions are filtered out by default.",
  parameters: z.object({
    facebook_groups: z
      .array(z.string())
      .default([])
      .describe("Facebook group ids, slugs, or URLs to scrape (must be a member of private ones)"),
    subreddits: z.array(z.string()).default([]).describe("Subreddit names to scrape (without the r/)"),
    amazon_products: z.array(z.string()).default([]).describe("Amazon ASINs or product URLs to scrape reviews from"),
    posts_per_source: z
      .number()
      .min(1)
      .max(200)
      .default(30)
      .describe("How many recent posts to open per FB/Reddit source"),
    amazon_review_limit: z.number().min(1).max(500).default(50).describe("How many reviews to pull per Amazon product"),
    min_words: z.number().min(1).max(50).default(4).describe("Minimum words for a comment/review to count as valuable"),
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
    if (args.facebook_groups.length === 0 && args.subreddits.length === 0 && args.amazon_products.length === 0) {
      // eslint-disable-next-line functype/prefer-either
      throw new Error("Provide at least one entry in facebook_groups, subreddits, or amazon_products.")
    }

    const errors: string[] = []
    const rows = await gatherVoiceRows({
      facebookGroups: args.facebook_groups,
      subreddits: args.subreddits,
      amazonProducts: args.amazon_products,
      postsPerSource: args.posts_per_source,
      amazonReviewLimit: args.amazon_review_limit,
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
    const fbCount = kept.filter((r) => r.platform === "facebook").length
    const redditCount = kept.filter((r) => r.platform === "reddit").length
    const amazonCount = kept.filter((r) => r.platform === "amazon").length
    const cats = ["pain", "desire", "objection", "question", "other"]
      .map((cat) => `${cat}=${kept.filter((r) => r.category === cat).length}`)
      .join(", ")
    const preview = kept
      .slice(0, 5)
      .map((r) => `- [${r.platform} · ${r.row_type} · ${r.category}] ${r.text.slice(0, 100)}`)
      .join("\n")

    return `# Voice-of-Customer CSV exported ✅

Saved **${kept.length}** rows (${postCount} posts/products + ${commentCount} comments + ${reviewCount} reviews) to:
\`${target}\`

- Platform: facebook=${fbCount}, reddit=${redditCount}, amazon=${amazonCount}
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

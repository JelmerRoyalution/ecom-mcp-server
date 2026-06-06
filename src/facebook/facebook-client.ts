/* eslint-disable functype/prefer-either --
 * Imperative-to-functional boundary for the Facebook scraping client, mirroring reddit-client.ts.
 * Each public method returns Either<Error, T>; the try/catch blocks capture thrown errors from
 * the fetch engines and parsers into Either.left at the method boundary.
 */
import type { Either } from "functype"
import { Left, Option, Right } from "functype"

import { ResponseCache } from "../client/response-cache"
import { BrowserFetchEngine, type FacebookFetchEngine, HttpFetchEngine, isPlaywrightAvailable } from "./engines"
import {
  extractGroupId,
  parseGroupFeed,
  parseGroupInfo,
  parseGroupSearchResults,
  parsePostWithComments,
} from "./parsers"
import type { FacebookClientConfig, FacebookGroup, FacebookPost, FacebookPostWithComments } from "./types"

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

const MBASIC = "https://mbasic.facebook.com"
const WWW = "https://www.facebook.com"
const HOST_RE = /^https?:\/\/(?:www|m|mbasic|web|touch)\.facebook\.com/i

export class FacebookClient {
  private readonly config: FacebookClientConfig
  private readonly cache?: ResponseCache
  private engine?: FacebookFetchEngine
  private enginePromise?: Promise<FacebookFetchEngine>
  private lastRequestTime = 0

  constructor(config: FacebookClientConfig) {
    this.config = config
    this.cache = config.cache?.enabled === true ? new ResponseCache({ maxBytes: config.cache.maxBytes }) : undefined
  }

  /** True when an authenticated session (c_user + xs) is configured. */
  hasSession(): boolean {
    return this.config.session !== undefined
  }

  /** Resolve and memoize the active fetch engine, honoring `auto` selection. */
  private async getEngine(): Promise<FacebookFetchEngine> {
    if (this.engine !== undefined) {
      return this.engine
    }
    this.enginePromise ??= this.createEngine().then((engine) => {
      this.engine = engine
      return engine
    })
    return this.enginePromise
  }

  private async createEngine(): Promise<FacebookFetchEngine> {
    const { engine } = this.config
    const wantBrowser =
      engine === "browser" || (engine === "auto" && this.hasSession() && (await isPlaywrightAvailable()))

    if (wantBrowser) {
      return new BrowserFetchEngine({
        session: this.config.session,
        userAgent: this.config.userAgent,
        headless: this.config.headless,
        locale: this.config.locale,
      })
    }
    return new HttpFetchEngine({
      cookieHeader: this.config.session?.cookieHeader,
      userAgent: this.config.userAgent,
      locale: this.config.locale,
    })
  }

  /** Name of the resolved engine (for status reporting). */
  async engineName(): Promise<"http" | "browser"> {
    return (await this.getEngine()).name
  }

  private async pace(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestTime
    if (this.lastRequestTime > 0 && elapsed < this.config.minDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, this.config.minDelayMs - elapsed))
    }
    this.lastRequestTime = Date.now()
  }

  /** Rewrite any facebook.com host in `url` to the host the active engine prefers. */
  private hostFor(engine: FacebookFetchEngine): string {
    return engine.name === "browser" ? WWW : MBASIC
  }

  private normalizeUrl(url: string, host: string): string {
    if (HOST_RE.test(url)) {
      return url.replace(HOST_RE, host)
    }
    if (url.startsWith("/")) {
      return `${host}${url}`
    }
    return `${host}/${url}`
  }

  /** Fetch HTML through the engine, with adaptive caching and anti-bot pacing. */
  private async fetchHtml(url: string, opts: { readonly scrolls?: number } = {}): Promise<string> {
    const cached = this.cache?.get(url)
    if (cached !== undefined) {
      return cached.body
    }
    await this.pace()
    const engine = await this.getEngine()
    const html = await engine.fetchHtml(url, opts)
    this.cache?.set(url, html, 200)
    return html
  }

  async getGroupFeed(groupRef: string, limit = 25): Promise<Either<Error, readonly FacebookPost[]>> {
    try {
      const groupId = extractGroupId(groupRef)
      if (groupId === "") {
        return Left(new Error("A group id, slug, or URL is required."))
      }
      const engine = await this.getEngine()
      const url = `${this.hostFor(engine)}/groups/${groupId}`
      // More posts → more scrolling in the browser engine.
      const scrolls = Math.max(3, Math.ceil(limit / 6))
      const html = await this.fetchHtml(url, { scrolls })
      const posts = parseGroupFeed(html, { groupId })
      if (posts.length === 0) {
        return Left(
          new Error(
            `No posts parsed from group "${groupId}". The group may be private and not joined by this session, ` +
              `empty, or Facebook changed its markup. Try FACEBOOK_ENGINE=browser with valid member cookies.`,
          ),
        )
      }
      return Right(posts.slice(0, limit))
    } catch (error) {
      return Left(new Error(`Failed to read group feed: ${toError(error).message}`))
    }
  }

  async getPageFeed(pageRef: string, limit = 25): Promise<Either<Error, readonly FacebookPost[]>> {
    try {
      const slug = pageRef
        .trim()
        .replace(HOST_RE, "")
        .replace(/^\/+|\/+$/g, "")
      if (slug === "") {
        return Left(new Error("A page name, slug, or URL is required."))
      }
      const engine = await this.getEngine()
      const url = `${this.hostFor(engine)}/${slug}`
      const scrolls = Math.max(3, Math.ceil(limit / 6))
      const html = await this.fetchHtml(url, { scrolls })
      const posts = parseGroupFeed(html, {})
      if (posts.length === 0) {
        return Left(new Error(`No posts parsed from page "${slug}". The page may not exist or be region-restricted.`))
      }
      return Right(posts.slice(0, limit))
    } catch (error) {
      return Left(new Error(`Failed to read page feed: ${toError(error).message}`))
    }
  }

  async getPostComments(postUrl: string, limit = 100): Promise<Either<Error, FacebookPostWithComments>> {
    try {
      if (postUrl.trim() === "") {
        return Left(new Error("A post permalink URL is required."))
      }
      const engine = await this.getEngine()
      const url = this.normalizeUrl(postUrl.trim(), this.hostFor(engine))
      const groupId = Option(url.match(/groups\/([^/?#]+)/)?.[1]).fold(
        () => "",
        (id) => id,
      )
      // Cap scrolling so a high comment limit can't explode into hundreds of scrolls per post.
      const scrolls = Math.min(10, Math.max(3, Math.ceil(limit / 12)))
      const html = await this.fetchHtml(url, { scrolls })
      const { post, comments } = parsePostWithComments(html, groupId !== "" ? { groupId } : {})
      return Right({ post, comments: comments.slice(0, limit) })
    } catch (error) {
      return Left(new Error(`Failed to read post comments: ${toError(error).message}`))
    }
  }

  /**
   * Deep-scrape a group's discussions: read the feed, then open each post and pull its
   * comment thread. There is no per-comment cap - callers filter by value instead.
   */
  async getGroupComments(
    groupRef: string,
    opts: { readonly postLimit?: number; readonly commentLimit?: number } = {},
  ): Promise<Either<Error, { readonly groupUrl: string; readonly threads: readonly FacebookPostWithComments[] }>> {
    try {
      const groupId = extractGroupId(groupRef)
      if (groupId === "") {
        return Left(new Error("A group id, slug, or URL is required."))
      }
      const postLimit = opts.postLimit ?? 30
      const commentLimit = opts.commentLimit ?? 120
      const posts = (await this.getGroupFeed(groupRef, postLimit)).orThrow()

      const threads: FacebookPostWithComments[] = []
      for (const post of posts) {
        if (post.permalink === undefined || post.permalink === "") {
          continue
        }
        const result = await this.getPostComments(post.permalink, commentLimit)
        result.fold(
          () => undefined,
          (data) => {
            // Keep the feed post (richer permalink + text) for context, with the parsed comments.
            threads.push({ post, comments: data.comments })
          },
        )
      }

      return Right({ groupUrl: `${WWW}/groups/${groupId}`, threads })
    } catch (error) {
      return Left(new Error(`Failed to read group comments: ${toError(error).message}`))
    }
  }

  async getGroupInfo(groupRef: string): Promise<Either<Error, FacebookGroup>> {
    try {
      const groupId = extractGroupId(groupRef)
      if (groupId === "") {
        return Left(new Error("A group id, slug, or URL is required."))
      }
      const engine = await this.getEngine()
      const url = `${this.hostFor(engine)}/groups/${groupId}`
      const html = await this.fetchHtml(url, { scrolls: 1 })
      return Right(parseGroupInfo(html, groupId, `${WWW}/groups/${groupId}`))
    } catch (error) {
      return Left(new Error(`Failed to read group info: ${toError(error).message}`))
    }
  }

  async searchGroups(query: string, limit = 20): Promise<Either<Error, readonly FacebookGroup[]>> {
    try {
      if (query.trim() === "") {
        return Left(new Error("A search query is required."))
      }
      const engine = await this.getEngine()
      const url = `${this.hostFor(engine)}/search/groups/?q=${encodeURIComponent(query.trim())}`
      const html = await this.fetchHtml(url, { scrolls: 2 })
      const groups = parseGroupSearchResults(html)
      return Right(groups.slice(0, limit))
    } catch (error) {
      return Left(new Error(`Failed to search groups: ${toError(error).message}`))
    }
  }

  async close(): Promise<void> {
    if (this.engine !== undefined) {
      await this.engine.close()
    }
  }
}

// Singleton instance (mirrors the Reddit client pattern).
const clientHolder: { instance: Option<FacebookClient> } = { instance: Option.none() }

export function initializeFacebookClient(config: FacebookClientConfig): FacebookClient {
  const client = new FacebookClient(config)
  clientHolder.instance = Option(client)
  return client
}

export function getFacebookClient(): Option<FacebookClient> {
  return clientHolder.instance
}

/* eslint-disable functype/no-let, @typescript-eslint/no-explicit-any, functype/no-imperative-loops, functype/prefer-either --
 * This module is the external-IO boundary for Facebook fetching. The HTTP engine wraps the
 * native fetch API and the browser engine dynamically loads the optional Playwright peer and
 * drives a stateful Chromium session. Both are inherently imperative effects; the surrounding
 * FacebookClient re-wraps their results into Either at the method boundary.
 */
import { parseCookieString } from "./cookies"
import type { FacebookSession } from "./types"

/** A pluggable source of raw Facebook HTML. */
export type FacebookFetchEngine = {
  readonly name: "http" | "browser"
  /** Fetch fully-formed HTML for a URL. `scrolls` hints how aggressively to lazy-load. */
  fetchHtml(url: string, opts?: { readonly scrolls?: number }): Promise<string>
  close(): Promise<void>
}

const LOGIN_WALL = /(log in to continue|you must log in|please log in|isn't available|content not found)/i
const BLOCKED = /(temporarily blocked|you can't use this feature|checkpoint required|confirm your identity)/i

/** Throw a descriptive error if the returned HTML is a login wall or a soft block. */
export function assertNotBlocked(html: string, url: string): void {
  const head = html.slice(0, 4000).toLowerCase()
  if (BLOCKED.test(head)) {
    throw new Error(
      `Facebook returned a security checkpoint for ${url}. Slow down (raise FACEBOOK_MIN_DELAY_MS), ` +
        `re-authenticate with fresh cookies, or switch to the browser engine.`,
    )
  }
  if (LOGIN_WALL.test(head) && !/role="article"|m_group_stories|m_story_permalink/.test(html)) {
    throw new Error(
      `Facebook served a login wall for ${url}. This usually means the session cookies are missing, ` +
        `expired, or not a member of a private group. Refresh FACEBOOK_COOKIE from a logged-in browser.`,
    )
  }
}

/**
 * Lightweight engine: a single `fetch` per URL against the mobile site with the
 * session cookie replayed. No JS execution, so best for public Pages and as a
 * fallback. Private groups and full comment threads are more reliable via browser.
 */
export class HttpFetchEngine implements FacebookFetchEngine {
  readonly name = "http" as const
  private readonly cookieHeader?: string
  private readonly userAgent: string
  private readonly locale: string

  constructor(config: { cookieHeader?: string; userAgent: string; locale: string }) {
    this.cookieHeader = config.cookieHeader
    this.userAgent = config.userAgent
    this.locale = config.locale
  }

  async fetchHtml(url: string): Promise<string> {
    const headers: Record<string, string> = {
      "User-Agent": this.userAgent,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": `${this.locale.replace("_", "-")},en;q=0.9`,
      "Upgrade-Insecure-Requests": "1",
    }
    if (this.cookieHeader !== undefined && this.cookieHeader !== "") {
      headers["Cookie"] = this.cookieHeader
    }

    const response = await fetch(url, { headers, redirect: "follow" })
    if (!response.ok && response.status !== 404) {
      throw new Error(`HTTP ${response.status} fetching ${url}`)
    }
    const html = await response.text()
    assertNotBlocked(html, url)
    return html
  }

  async close(): Promise<void> {
    // Stateless - nothing to release.
  }
}

/** Indirect specifier keeps the bundler and tsc from resolving the optional peer. */
async function loadPlaywright(): Promise<any> {
  const specifier = "playwright"
  const mod: any = await import(specifier)
  return mod.chromium ?? mod.default?.chromium
}

/**
 * Browser engine: drives a logged-in Chromium via Playwright. This is the only
 * dependable way to reach PRIVATE groups and expand full comment threads in 2025+,
 * because Facebook server-renders the mobile/desktop site with JavaScript.
 *
 * Playwright is an OPTIONAL peer dependency. If it (or its browser binary) is not
 * installed, construction of this engine fails with actionable install guidance.
 */
export class BrowserFetchEngine implements FacebookFetchEngine {
  readonly name = "browser" as const
  private readonly session?: FacebookSession
  private readonly userAgent: string
  private readonly headless: boolean
  private readonly locale: string
  private browser: any
  private context: any

  constructor(config: { session?: FacebookSession; userAgent: string; headless: boolean; locale: string }) {
    this.session = config.session
    this.userAgent = config.userAgent
    this.headless = config.headless
    this.locale = config.locale
  }

  private async ensureContext(): Promise<any> {
    if (this.context !== undefined) {
      return this.context
    }

    let chromium: any
    try {
      chromium = await loadPlaywright()
    } catch {
      throw new Error(
        "The browser engine requires the optional 'playwright' package. Install it with " +
          "`npm install playwright && npx playwright install chromium`, then set FACEBOOK_ENGINE=browser.",
      )
    }
    if (chromium === undefined) {
      throw new Error("Playwright is installed but no Chromium build was found. Run `npx playwright install chromium`.")
    }

    try {
      this.browser = await chromium.launch({ headless: this.headless })
    } catch (err) {
      throw new Error(
        `Failed to launch Chromium (${err instanceof Error ? err.message : String(err)}). ` +
          "Run `npx playwright install chromium` to download the browser binary.",
        { cause: err },
      )
    }

    this.context = await this.browser.newContext({
      userAgent: this.userAgent,
      locale: this.locale.replace("_", "-"),
      viewport: { width: 1280, height: 1800 },
    })

    if (this.session !== undefined) {
      const cookies = parseCookieString(this.session.cookieHeader)
      const toAdd = Object.entries(cookies).map(([name, value]) => ({
        name,
        value,
        domain: ".facebook.com",
        path: "/",
        httpOnly: false,
        secure: true,
      }))
      await this.context.addCookies(toAdd)
    }

    return this.context
  }

  async fetchHtml(url: string, opts: { readonly scrolls?: number } = {}): Promise<string> {
    const context = await this.ensureContext()
    const page = await context.newPage()
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 })

      const scrolls = opts.scrolls ?? 4
      for (let i = 0; i < scrolls; i++) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
        await page.waitForTimeout(1_500)
        // Best-effort: expand truncated post bodies and reveal more comments.
        await clickAll(page, [
          "text=/^See more$/i",
          "text=/View more comments/i",
          "text=/View previous comments/i",
          "text=/more comments/i",
        ])
      }

      const html: string = await page.content()
      assertNotBlocked(html, url)
      return html
    } finally {
      await page.close()
    }
  }

  async close(): Promise<void> {
    if (this.context !== undefined) {
      await this.context.close().catch(() => undefined)
      this.context = undefined
    }
    if (this.browser !== undefined) {
      await this.browser.close().catch(() => undefined)
      this.browser = undefined
    }
  }
}

async function clickAll(page: any, selectors: readonly string[]): Promise<void> {
  for (const selector of selectors) {
    try {
      const elements = await page.$$(selector)
      for (const el of elements.slice(0, 10)) {
        await el.click({ timeout: 1_000 }).catch(() => undefined)
        await page.waitForTimeout(400)
      }
    } catch {
      // Selector not present on this page - ignore.
    }
  }
}

/** Is the optional Playwright peer importable in this runtime? */
export async function isPlaywrightAvailable(): Promise<boolean> {
  try {
    const chromium = await loadPlaywright()
    return chromium !== undefined
  } catch {
    return false
  }
}

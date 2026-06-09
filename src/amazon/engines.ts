/* eslint-disable functype/no-let, @typescript-eslint/no-explicit-any, functype/no-imperative-loops, functype/prefer-either --
 * This module is the external-IO boundary for Amazon fetching. The HTTP engine wraps the
 * native fetch API and the browser engine dynamically loads the optional Playwright peer and
 * drives a Chromium session. Both are inherently imperative effects; the surrounding
 * AmazonClient re-wraps their results into Either at the method boundary. Mirrors
 * facebook/engines.ts.
 */
import { parseCookieString } from "../facebook/cookies"

/** A pluggable source of raw Amazon HTML. */
export type AmazonFetchEngine = {
  readonly name: "http" | "browser"
  /** Fetch fully-formed HTML for a URL. `scrolls` hints how aggressively to lazy-load. */
  fetchHtml(url: string, opts?: { readonly scrolls?: number }): Promise<string>
  close(): Promise<void>
}

const ROBOT_CHECK =
  /(robot check|type the characters you see in this image|enter the characters you see below|to discuss automated access to amazon data|sorry, we just need to make sure you're not a robot|api-services-support@amazon\.com)/i

/** Throw a descriptive error if the returned HTML is an Amazon anti-bot / CAPTCHA page. */
export function assertNotBlocked(html: string, url: string): void {
  const head = html.slice(0, 6000)
  if (ROBOT_CHECK.test(head)) {
    throw new Error(
      `Amazon served an anti-bot "robot check" for ${url}. Slow down (raise AMAZON_MIN_DELAY_MS), switch to ` +
        `AMAZON_ENGINE=browser with a logged-in AMAZON_COOKIE, or configure AMAZON_API_KEY for a reliable reviews API.`,
    )
  }
}

/** Resolve the Amazon TLD ("com", "co.uk", …) from a URL so cookies attach to the right domain. */
function amazonDomainFromUrl(url: string): string {
  const m = url.match(/amazon\.([a-z.]{2,6})\//i)
  return m !== null ? `.amazon.${m[1].toLowerCase().replace(/\.$/, "")}` : ".amazon.com"
}

/**
 * Lightweight engine: a single `fetch` per URL against `/product-reviews/{ASIN}` with the
 * session cookie replayed. No JS execution. Good for the first pages of reviews; Amazon may
 * gate depth or serve a robot check, which `assertNotBlocked` surfaces with guidance.
 */
export class HttpFetchEngine implements AmazonFetchEngine {
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
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
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
 * Browser engine: drives a Chromium via Playwright. More robust against Amazon's anti-bot
 * defences than raw fetch, and can replay a logged-in `AMAZON_COOKIE` session to page deeper
 * into a product's reviews. Playwright is an OPTIONAL peer dependency.
 */
export class BrowserFetchEngine implements AmazonFetchEngine {
  readonly name = "browser" as const
  private readonly cookieHeader?: string
  private readonly userAgent: string
  private readonly headless: boolean
  private readonly locale: string
  private browser: any
  private context: any

  constructor(config: { cookieHeader?: string; userAgent: string; headless: boolean; locale: string }) {
    this.cookieHeader = config.cookieHeader
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
          "`npm install playwright && npx playwright install chromium`, then set AMAZON_ENGINE=browser.",
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

    return this.context
  }

  private async applyCookies(url: string): Promise<void> {
    if (this.cookieHeader === undefined || this.cookieHeader === "") {
      return
    }
    const domain = amazonDomainFromUrl(url)
    const cookies = parseCookieString(this.cookieHeader)
    const toAdd = Object.entries(cookies).map(([name, value]) => ({
      name,
      value,
      domain,
      path: "/",
      httpOnly: false,
      secure: true,
    }))
    await this.context.addCookies(toAdd)
  }

  async fetchHtml(url: string, opts: { readonly scrolls?: number } = {}): Promise<string> {
    const context = await this.ensureContext()
    await this.applyCookies(url)
    const page = await context.newPage()
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 })
      // Reviews render server-side, but a couple of gentle scrolls trigger any lazy widgets.
      const scrolls = opts.scrolls ?? 2
      for (let i = 0; i < scrolls; i++) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
        await page.waitForTimeout(800)
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

/** Is the optional Playwright peer importable in this runtime? */
export async function isPlaywrightAvailable(): Promise<boolean> {
  try {
    const chromium = await loadPlaywright()
    return chromium !== undefined
  } catch {
    return false
  }
}

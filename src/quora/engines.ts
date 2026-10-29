/* eslint-disable functype/no-let, @typescript-eslint/no-explicit-any, functype/no-imperative-loops, functype/prefer-either --
 * This module is the external-IO boundary for Quora fetching. The HTTP engine wraps the native
 * fetch API and the browser engine dynamically loads the optional Playwright peer and drives a
 * Chromium session (scrolling to lazy-load more answers and replaying a QUORA_COOKIE session).
 * Both are inherently imperative effects; the surrounding QuoraClient re-wraps their results into
 * Either at the method boundary. Mirrors amazon/engines.ts.
 */
import { parseCookieString } from "../facebook/cookies"
import { localizeQuoraUrl, quoraHostForCookie } from "./parsers"

/** A pluggable source of raw Quora HTML. */
export type QuoraFetchEngine = {
  readonly name: "http" | "browser"
  /** Fetch fully-formed HTML for a URL. `scrolls` hints how aggressively to lazy-load answers. */
  fetchHtml(url: string, opts?: { readonly scrolls?: number }): Promise<string>
  close(): Promise<void>
}

const BLOCK_CHECK =
  /(detected unusual activity|to continue, please verify|access to this page has been denied|please enable javascript and cookies|px-captcha|are you a robot)/i

/** Throw a descriptive error if the returned HTML is a Quora anti-bot / verification page. */
export function assertNotBlocked(html: string, url: string): void {
  const head = html.slice(0, 6000)
  if (BLOCK_CHECK.test(head)) {
    throw new Error(
      `Quora served an anti-bot / verification page for ${url}. Slow down (raise QUORA_MIN_DELAY_MS), or switch to ` +
        `QUORA_ENGINE=browser with a logged-in QUORA_COOKIE (run \`pnpm run setup\`).`,
    )
  }
}

/**
 * Lightweight engine: a single `fetch` per URL with the session cookie replayed. No JS execution.
 * Quora typically returns HTTP 403 / an unrendered shell to plain fetch, so this is best-effort
 * only (the parser falls back to schema.org JSON-LD on the rare render that ships it). The browser
 * engine is the real path. `assertNotBlocked` surfaces verification pages with guidance.
 */
export class HttpFetchEngine implements QuoraFetchEngine {
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
 * Browser engine: drives a Chromium via Playwright. More robust against Quora's anti-bot defences
 * and its login-wall overlay than raw fetch, scrolls to lazy-load further answers, and can replay a
 * logged-in `QUORA_COOKIE` session. Playwright is an OPTIONAL peer dependency.
 */
export class BrowserFetchEngine implements QuoraFetchEngine {
  readonly name = "browser" as const
  private readonly cookieHeader?: string
  private readonly userAgent: string
  private readonly headless: boolean
  private readonly locale: string
  /** Account language subdomain (e.g. `nl.quora.com`) derived from the session, to dodge the
   * "add language" interstitial that gates search/topic feeds. */
  private readonly languageHost?: string
  /** The OneTrust consent banner blocks Quora's gated XHRs until dismissed; once handled in a
   * context, the consent cookie persists so later fetches don't re-show it. */
  private consentHandled = false
  private browser: any
  private context: any

  constructor(config: { cookieHeader?: string; userAgent: string; headless: boolean; locale: string }) {
    this.cookieHeader = config.cookieHeader
    this.userAgent = config.userAgent
    this.headless = config.headless
    this.locale = config.locale
    this.languageHost = quoraHostForCookie(config.cookieHeader)
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
          "`npm install playwright && npx playwright install chromium`, then set QUORA_ENGINE=browser.",
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

    if (this.cookieHeader !== undefined && this.cookieHeader !== "") {
      const cookies = parseCookieString(this.cookieHeader)
      const toAdd = Object.entries(cookies).map(([name, value]) => ({
        name,
        value,
        domain: ".quora.com",
        path: "/",
        httpOnly: false,
        secure: true,
      }))
      await this.context.addCookies(toAdd)
    }

    return this.context
  }

  /**
   * Dismiss the OneTrust cookie-consent banner if present (EU/GDPR). Quora does not fetch its
   * search/topic results until consent is resolved, and OneTrust only takes effect after a reload,
   * so the caller reloads once when this returns true. Prefers a reject-all control; falls back to
   * accept (this runs in an ephemeral scrape context, not the user's real browsing session).
   */
  private dismissConsent(page: any): Promise<boolean> {
    return page
      .evaluate(() => {
        const ids = ["onetrust-reject-all-handler", "onetrust-accept-btn-handler", "accept-recommended-btn-handler"]
        for (const id of ids) {
          const el = document.getElementById(id)
          if (el !== null) {
            el.click()
            return true
          }
        }
        return false
      })
      .catch(() => false)
  }

  async fetchHtml(url: string, opts: { readonly scrolls?: number } = {}): Promise<string> {
    const context = await this.ensureContext()
    const page = await context.newPage()
    const target = localizeQuoraUrl(url, this.languageHost)
    try {
      await page.goto(target, { waitUntil: "domcontentloaded", timeout: 45_000 })
      await page.waitForTimeout(1_500)

      // EU consent gate: dismiss the OneTrust banner once per context, then reload so Quora fetches
      // the gated search/topic results (validated: results only appear after consent + reload).
      if (!this.consentHandled && (await this.dismissConsent(page))) {
        this.consentHandled = true
        await page.waitForTimeout(800)
        await page.goto(target, { waitUntil: "domcontentloaded", timeout: 45_000 })
        await page.waitForTimeout(1_800)
      }

      // Answers / results lazy-load as you scroll; a few passes pull the full set.
      const scrolls = opts.scrolls ?? 4
      for (let i = 0; i < scrolls; i++) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
        await page.waitForTimeout(1_200)
      }
      const html: string = await page.content()
      assertNotBlocked(html, target)
      return html
    } finally {
      await page.close().catch(() => undefined)
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

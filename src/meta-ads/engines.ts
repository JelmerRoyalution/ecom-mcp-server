/* eslint-disable functype/no-let, @typescript-eslint/no-explicit-any, functype/no-imperative-loops, functype/prefer-either --
 * External-IO boundary for Meta Ad Library fetching. Unlike the HTML-scraping modules, the Ad
 * Library is a JSON/GraphQL SPA, so engines return raw intercepted GraphQL pages (not HTML):
 *   - HttpFetchEngine harvests tokens from the page, then POSTs `/api/graphql/` directly.
 *   - BrowserFetchEngine drives Chromium and intercepts the XHR GraphQL responses Meta's own JS
 *     issues (the robust path - no hand-rolled tokens/doc_id).
 * Both are inherently imperative effects; the MetaAdsClient re-wraps results into Either.
 */
import { parseCookieString } from "../facebook/cookies"
import { buildGraphqlBody, buildSessionId, buildVariables, harvestTokens } from "./tokens"
import type { MetaAdSearchParams } from "./types"
import { buildAdLibraryUrl } from "./urls"

const GRAPHQL_URL = "https://www.facebook.com/api/graphql/"
const SEARCH_FRIENDLY_NAME = "AdLibrarySearchPaginationQuery"
const PAGE_SIZE = 30

/** A pluggable source of raw Ad Library GraphQL pages. */
export type MetaAdsFetchEngine = {
  readonly name: "http" | "browser"
  /** Fetch up to `pages` raw GraphQL JSON pages for a search. */
  fetchAdPages(params: MetaAdSearchParams, opts: { readonly pages: number }): Promise<readonly unknown[]>
  close(): Promise<void>
}

const CHECKPOINT =
  /(temporarily blocked|you can't use this feature|checkpoint required|confirm your identity|log in to continue)/i

/** Best-effort: parse a GraphQL response body (Meta sometimes returns multiple JSON objects). */
function safeParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text)
  } catch {
    const line = text.split("\n").find((l) => l.trim().startsWith("{"))
    if (line === undefined) return undefined
    try {
      return JSON.parse(line)
    } catch {
      return undefined
    }
  }
}

/** Read the pagination cursor straight off a response body without a full parse. */
function readCursor(text: string): { endCursor?: string; hasNext: boolean } {
  const c = text.match(/"end_cursor":"([^"]*)"/)
  const h = text.match(/"has_next_page":(true|false)/)
  return { endCursor: c !== null && c[1] !== "" ? c[1] : undefined, hasNext: h !== null ? h[1] === "true" : false }
}

/**
 * Lightweight engine: GET the Ad Library page to harvest `lsd`/`fb_dtsg`/`doc_id`, then POST the
 * internal `/api/graphql/` endpoint directly, paginating on `end_cursor`. Fast and dependency-free,
 * but brittle when Meta rotates `doc_id` or markup - it throws actionable guidance when it can't
 * assemble a request, pointing at the browser engine / API.
 */
export class HttpFetchEngine implements MetaAdsFetchEngine {
  readonly name = "http" as const
  private readonly cookieHeader?: string
  private readonly userAgent: string
  private readonly locale: string

  constructor(config: { cookieHeader?: string; userAgent: string; locale: string }) {
    this.cookieHeader = config.cookieHeader
    this.userAgent = config.userAgent
    this.locale = config.locale
  }

  async fetchAdPages(params: MetaAdSearchParams, opts: { readonly pages: number }): Promise<readonly unknown[]> {
    const pageUrl = buildAdLibraryUrl(params)
    const html = await this.getHtml(pageUrl)
    if (CHECKPOINT.test(html.slice(0, 4000))) {
      throw new Error(
        `Meta returned a security checkpoint for the Ad Library. Slow down (raise META_ADS_MIN_DELAY_MS), ` +
          `or switch to META_ADS_ENGINE=browser with Playwright.`,
      )
    }

    const tokens = harvestTokens(html)
    if (tokens.docId === undefined || tokens.fbDtsg === undefined || tokens.lsd === undefined) {
      throw new Error(
        "The HTTP engine could not harvest Meta's Ad Library tokens/doc_id (Meta changes these often). " +
          "Set META_ADS_ENGINE=browser (needs Playwright: `npm install playwright && npx playwright install chromium`), " +
          "or configure META_ADS_API_KEY for a managed provider.",
      )
    }

    const sessionId = buildSessionId()
    const pages: unknown[] = []
    let cursor: string | undefined = undefined

    for (let i = 0; i < opts.pages; i++) {
      const variables = buildVariables(params, { cursor, first: PAGE_SIZE, sessionId })
      const body = buildGraphqlBody({ tokens, variables, docId: tokens.docId, friendlyName: SEARCH_FRIENDLY_NAME })
      const text = await this.postGraphql(body, tokens.lsd, pageUrl)
      const json = safeParseJson(text)
      if (json !== undefined) pages.push(json)
      const { endCursor, hasNext } = readCursor(text)
      if (!hasNext || endCursor === undefined) break
      cursor = endCursor
    }

    return pages
  }

  private async getHtml(url: string): Promise<string> {
    const headers: Record<string, string> = {
      "User-Agent": this.userAgent,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": `${this.locale.replace("_", "-")},en;q=0.9`,
    }
    if (this.cookieHeader !== undefined && this.cookieHeader !== "") headers["Cookie"] = this.cookieHeader
    const response = await fetch(url, { headers, redirect: "follow" })
    if (!response.ok) throw new Error(`HTTP ${response.status} fetching the Ad Library page`)
    return response.text()
  }

  private async postGraphql(body: string, lsd: string, referer: string): Promise<string> {
    const headers: Record<string, string> = {
      "User-Agent": this.userAgent,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "*/*",
      "X-FB-LSD": lsd,
      "X-FB-Friendly-Name": SEARCH_FRIENDLY_NAME,
      Origin: "https://www.facebook.com",
      Referer: referer,
    }
    if (this.cookieHeader !== undefined && this.cookieHeader !== "") headers["Cookie"] = this.cookieHeader
    const response = await fetch(GRAPHQL_URL, { method: "POST", headers, body, redirect: "follow" })
    if (!response.ok) throw new Error(`HTTP ${response.status} from Meta's GraphQL endpoint`)
    return response.text()
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
 * Browser engine: drives Chromium via Playwright, navigates the real Ad Library URL, and intercepts
 * the XHR GraphQL responses Meta's own JS issues - the most robust path, since we never hand-roll
 * `fb_dtsg`/`doc_id`. Scrolls to trigger pagination. Playwright is an OPTIONAL peer dependency.
 */
export class BrowserFetchEngine implements MetaAdsFetchEngine {
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
    if (this.context !== undefined) return this.context

    let chromium: any
    try {
      chromium = await loadPlaywright()
    } catch {
      throw new Error(
        "The browser engine requires the optional 'playwright' package. Install it with " +
          "`npm install playwright && npx playwright install chromium`, then set META_ADS_ENGINE=browser.",
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
        domain: ".facebook.com",
        path: "/",
        httpOnly: false,
        secure: true,
      }))
      await this.context.addCookies(toAdd)
    }

    return this.context
  }

  async fetchAdPages(params: MetaAdSearchParams, opts: { readonly pages: number }): Promise<readonly unknown[]> {
    const context = await this.ensureContext()
    const page = await context.newPage()
    const captured: unknown[] = []

    page.on("response", (resp: any) => {
      const url = resp.url()
      if (typeof url !== "string" || !url.includes("/api/graphql/")) return
      resp
        .text()
        .then((text: string) => {
          if (text.includes("ad_archive_id") || text.includes("search_results_connection")) {
            const json = safeParseJson(text)
            if (json !== undefined) captured.push(json)
          }
        })
        .catch(() => undefined)
    })

    try {
      const url = buildAdLibraryUrl(params)
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 })
      await page.waitForTimeout(2_500)

      let lastLen = -1
      let idle = 0
      for (let i = 0; i < opts.pages * 4 && captured.length < opts.pages; i++) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
        await page.waitForTimeout(1_800)
        if (captured.length === lastLen) {
          idle += 1
          if (idle >= 3) break
        } else {
          idle = 0
          lastLen = captured.length
        }
      }

      if (captured.length === 0) {
        const content: string = await page.content()
        if (CHECKPOINT.test(content.slice(0, 4000))) {
          throw new Error(
            "Meta served a security checkpoint / login wall for the Ad Library. Slow down " +
              "(raise META_ADS_MIN_DELAY_MS) or re-authenticate with a fresh META_ADS_COOKIE / FACEBOOK_COOKIE.",
          )
        }
      }

      return captured
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

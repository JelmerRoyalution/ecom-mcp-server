/* eslint-disable functype/prefer-either --
 * Imperative-to-functional boundary for the Quora scraping client, mirroring amazon-client.ts.
 * Each public method returns Either<Error, T>; the try/catch blocks capture thrown errors from the
 * fetch engines and the parsers into Either.left at the method boundary.
 */
import type { Either } from "functype"
import { Left, Option, Right } from "functype"

import { ResponseCache } from "../client/response-cache"
import { BrowserFetchEngine, HttpFetchEngine, isPlaywrightAvailable, type QuoraFetchEngine } from "./engines"
import {
  buildQuestionUrl,
  buildSearchUrl,
  buildTopicUrl,
  extractSlug,
  looksLoginGated,
  parseQuestionCards,
  parseQuestionPage,
} from "./parsers"
import type { QuoraClientConfig, QuoraQuestion, QuoraQuestionWithAnswers } from "./types"

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

export type GetQuestionOptions = {
  readonly maxAnswers?: number
}

export type SearchOptions = {
  readonly limit?: number
}

export class QuoraClient {
  private readonly config: QuoraClientConfig
  private readonly cache?: ResponseCache
  private engine?: QuoraFetchEngine
  private enginePromise?: Promise<QuoraFetchEngine>
  private lastRequestTime = 0

  constructor(config: QuoraClientConfig) {
    this.config = config
    this.cache = config.cache?.enabled === true ? new ResponseCache({ maxBytes: config.cache.maxBytes }) : undefined
  }

  /** True when an authenticated cookie session is configured. */
  hasSession(): boolean {
    return this.config.session !== undefined
  }

  /** Name of the active engine, for status reporting. */
  async activeEngineName(): Promise<"http" | "browser"> {
    return (await this.getEngine()).name
  }

  private async getEngine(): Promise<QuoraFetchEngine> {
    if (this.engine !== undefined) {
      return this.engine
    }
    this.enginePromise ??= this.createEngine().then((engine) => {
      this.engine = engine
      return engine
    })
    return this.enginePromise
  }

  private async createEngine(): Promise<QuoraFetchEngine> {
    const { engine } = this.config
    // Browser is preferred for `auto` whenever Playwright is present - the Quora SPA is hostile to
    // plain fetch past a question's first answers, and a real Chromium handles the login-wall overlay.
    const wantBrowser = engine === "browser" || (engine === "auto" && (await isPlaywrightAvailable()))

    if (wantBrowser) {
      return new BrowserFetchEngine({
        cookieHeader: this.config.session?.cookieHeader,
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

  private async pace(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestTime
    if (this.lastRequestTime > 0 && elapsed < this.config.minDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, this.config.minDelayMs - elapsed))
    }
    this.lastRequestTime = Date.now()
  }

  /** Fetch HTML through the engine, with caching and anti-bot pacing. */
  private async fetchHtml(url: string): Promise<string> {
    const cached = this.cache?.get(url)
    if (cached !== undefined) {
      return cached.body
    }
    await this.pace()
    const engine = await this.getEngine()
    const html = await engine.fetchHtml(url)
    this.cache?.set(url, html, 200)
    return html
  }

  /**
   * Scrape a Quora question and its answers. Pass a question URL or a bare slug. The browser engine
   * renders the page and the parser reads each answer (author, body, best-effort upvotes/date) from
   * the annotated DOM - this works even logged-out for question pages; a logged-in QUORA_COOKIE
   * exposes more (e.g. exact upvote counts and gated threads).
   */
  async getQuestion(ref: string, opts: GetQuestionOptions = {}): Promise<Either<Error, QuoraQuestionWithAnswers>> {
    try {
      const slug = extractSlug(ref)
      if (slug === undefined) {
        return Left(
          new Error(`Could not find a Quora question in "${ref}". Pass a quora.com question URL or its slug.`),
        )
      }
      const url = buildQuestionUrl(slug)
      const html = await this.fetchHtml(url)
      const parsed = parseQuestionPage(html, url)

      if (parsed.answers.length === 0) {
        // Quora serves an "Error" shell for slugs that don't exist or have been removed/merged.
        if (parsed.question.title === "" || /^Error$/i.test(parsed.question.title)) {
          return Left(
            new Error(
              `Quora has no question at "${url}" (it may not exist, or was merged/removed). Use quora_search to find ` +
                `the current URL, or pass a different question.`,
            ),
          )
        }
        if (looksLoginGated(html, 0)) {
          return Left(
            new Error(
              `Quora gated "${parsed.question.title}" behind a login wall (no answers parsed). Set QUORA_ENGINE=browser ` +
                `with a logged-in QUORA_COOKIE (run \`pnpm run setup\`) to read the thread.`,
            ),
          )
        }
        return Left(
          new Error(
            `No answers parsed for "${parsed.question.title}". The question may have no answers, or need QUORA_ENGINE=` +
              `browser with a logged-in QUORA_COOKIE (run \`pnpm run setup\`).`,
          ),
        )
      }

      const max = opts.maxAnswers ?? 50
      return Right({ question: parsed.question, answers: parsed.answers.slice(0, max) })
    } catch (error) {
      return Left(new Error(`Failed to scrape Quora question: ${toError(error).message}`))
    }
  }

  /**
   * Search Quora for questions matching a query (a niche/keyword). Returns question cards to feed
   * into {@link getQuestion}. Logged-out search is JS-heavy and gated, so this is most reliable via
   * the browser engine with a logged-in QUORA_COOKIE.
   */
  async searchQuestions(query: string, opts: SearchOptions = {}): Promise<Either<Error, readonly QuoraQuestion[]>> {
    try {
      if (query.trim() === "") {
        return Left(new Error("A search query is required."))
      }
      const url = buildSearchUrl(query)
      const html = await this.fetchHtml(url)
      const questions = parseQuestionCards(html)
      if (questions.length === 0) {
        return Left(
          new Error(
            `No questions parsed for "${query}". Quora search is gated when logged out - set QUORA_ENGINE=browser ` +
              `with a logged-in QUORA_COOKIE (run \`pnpm run setup\`), or pass a question URL directly to quora_get_question.`,
          ),
        )
      }
      return Right(questions.slice(0, opts.limit ?? 15))
    } catch (error) {
      return Left(new Error(`Failed to search Quora: ${toError(error).message}`))
    }
  }

  /**
   * Fetch the questions in a Quora topic or Space - the highest-signal "what does this niche ask?"
   * query. Pass a topic name, a `/topic/...` URL, or a Space (`q/<slug>`) URL.
   */
  async getTopicQuestions(topic: string, opts: SearchOptions = {}): Promise<Either<Error, readonly QuoraQuestion[]>> {
    try {
      if (topic.trim() === "") {
        return Left(new Error("A topic name or URL is required."))
      }
      const url = buildTopicUrl(topic)
      const html = await this.fetchHtml(url)
      const questions = parseQuestionCards(html)
      if (questions.length === 0) {
        return Left(
          new Error(
            `No questions parsed for topic "${topic}". Topic feeds are JS-heavy - set QUORA_ENGINE=browser with a ` +
              `logged-in QUORA_COOKIE (run \`pnpm run setup\`) for reliable results.`,
          ),
        )
      }
      return Right(questions.slice(0, opts.limit ?? 25))
    } catch (error) {
      return Left(new Error(`Failed to fetch Quora topic questions: ${toError(error).message}`))
    }
  }

  async close(): Promise<void> {
    if (this.engine !== undefined) {
      await this.engine.close()
    }
  }
}

// Singleton instance (mirrors the Reddit + Facebook + Amazon + Meta Ads client pattern).
const clientHolder: { instance: Option<QuoraClient> } = { instance: Option.none() }

export function initializeQuoraClient(config: QuoraClientConfig): QuoraClient {
  const client = new QuoraClient(config)
  clientHolder.instance = Option(client)
  return client
}

export function getQuoraClient(): Option<QuoraClient> {
  return clientHolder.instance
}

/* eslint-disable functype/prefer-either --
 * Imperative-to-functional boundary for the Meta Ad Library client, mirroring amazon-client.ts.
 * Each public method returns Either<Error, T>; the try/catch blocks capture thrown errors from the
 * fetch engines, the paid API and the parser into Either.left at the method boundary.
 */
import { join } from "node:path"

import type { Either } from "functype"
import { Left, Option, Right } from "functype"

import { ResponseCache } from "../client/response-cache"
import { fetchViaApi } from "./api-engine"
import { downloadCreatives, slugify } from "./downloader"
import { BrowserFetchEngine, HttpFetchEngine, isPlaywrightAvailable, type MetaAdsFetchEngine } from "./engines"
import { aggregateBrands, filterAds, parseAdsPages, sortAds } from "./parsers"
import { detectTranscribeTools, type TranscribeTools } from "./transcribe"
import type {
  MetaAd,
  MetaAdActiveStatus,
  MetaAdBrand,
  MetaAdMediaType,
  MetaAdPlatform,
  MetaAdsClientConfig,
  MetaAdSearchParams,
  MetaAdSort,
  MetaAdvertiserAds,
  MetaDownloadManifest,
  MetaDownloadWhat,
  MetaTranscribeMode,
} from "./types"
import { parseAdvertiserRef } from "./urls"

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

export type FindBrandsOptions = {
  readonly country?: string
  readonly activeStatus?: MetaAdActiveStatus
  readonly limit?: number
}

export type GetAdvertiserAdsOptions = {
  readonly country?: string
  readonly mediaType?: MetaAdMediaType
  readonly activeStatus?: MetaAdActiveStatus
  readonly platform?: MetaAdPlatform
  readonly sort?: MetaAdSort
  readonly limit?: number
}

export type DownloadCreativesOptions = {
  readonly country?: string
  readonly mediaType?: MetaAdMediaType
  readonly activeStatus?: MetaAdActiveStatus
  readonly what?: MetaDownloadWhat
  readonly limit?: number
  readonly maxFiles?: number
  /** Base directory; the advertiser's creatives land in `<baseDir>/<advertiser-slug>/`. */
  readonly baseDir?: string
  /** Transcribe downloaded videos (`auto` = when the local whisper.cpp toolchain is present). */
  readonly transcribe?: MetaTranscribeMode
  readonly transcribeFast?: boolean
  readonly transcribeThreads?: number
}

export class MetaAdsClient {
  private readonly config: MetaAdsClientConfig
  private readonly cache?: ResponseCache
  private engine?: MetaAdsFetchEngine
  private enginePromise?: Promise<MetaAdsFetchEngine>
  private lastRequestTime = 0

  constructor(config: MetaAdsClientConfig) {
    this.config = config
    this.cache = config.cache?.enabled === true ? new ResponseCache({ maxBytes: config.cache.maxBytes }) : undefined
  }

  /** True when an (optional) session cookie is configured. */
  hasSession(): boolean {
    return this.config.session !== undefined
  }

  /** True when a paid API is configured and should be used. */
  private useApi(): boolean {
    return this.config.api !== undefined && (this.config.engine === "api" || this.config.engine === "auto")
  }

  /** Name of the active engine, for status reporting. */
  async activeEngineName(): Promise<"http" | "browser" | "api"> {
    if (this.useApi()) {
      return "api"
    }
    return (await this.getEngine()).name
  }

  private async getEngine(): Promise<MetaAdsFetchEngine> {
    if (this.engine !== undefined) {
      return this.engine
    }
    this.enginePromise ??= this.createEngine().then((engine) => {
      this.engine = engine
      return engine
    })
    return this.enginePromise
  }

  private async createEngine(): Promise<MetaAdsFetchEngine> {
    const { engine } = this.config
    // Browser is preferred for `auto` even WITHOUT a session - the Ad Library is public, and a real
    // Chromium intercepting the GraphQL JSON is far more robust than hand-rolling tokens/doc_id.
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

  /** Fetch raw GraphQL pages through the engine, with caching + anti-bot pacing. */
  private async fetchPages(params: MetaAdSearchParams, pages: number): Promise<readonly unknown[]> {
    const key = `metaads:${pages}:${JSON.stringify(params)}`
    const cached = this.cache?.get(key)
    if (cached !== undefined) {
      try {
        return JSON.parse(cached.body) as unknown[]
      } catch {
        // Corrupt cache entry - fall through and refetch.
      }
    }
    await this.pace()
    const result = await (await this.getEngine()).fetchAdPages(params, { pages })
    this.cache?.set(key, JSON.stringify(result), 200)
    return result
  }

  /** Collect ads for a search - via the paid API when configured, else the engine + parser. */
  private async collectAds(params: MetaAdSearchParams): Promise<readonly MetaAd[]> {
    if (this.useApi()) {
      const { api } = this.config
      if (api === undefined) {
        throw new Error("Meta Ads API engine selected but no API key is configured.")
      }
      await this.pace()
      return fetchViaApi({ provider: api.provider, apiKey: api.key, params, maxPages: this.config.maxPages })
    }
    const pages = await this.fetchPages(params, this.config.maxPages)
    return parseAdsPages(pages).ads
  }

  /**
   * Discover advertisers for a query. A bare domain (e.g. `vitalityextracts.com`) is the most
   * effective input - it surfaces the brand's whole connected page network. Ads are de-duplicated
   * into distinct advertiser cards, ranked by ad volume.
   */
  async findBrands(query: string, opts: FindBrandsOptions = {}): Promise<Either<Error, readonly MetaAdBrand[]>> {
    try {
      const q = query.trim()
      if (q === "") {
        return Left(
          new Error("A search query is required - a brand's bare domain works best, e.g. 'vitalityextracts.com'."),
        )
      }
      const country = opts.country ?? this.config.country
      const params: MetaAdSearchParams = {
        q,
        country,
        activeStatus: opts.activeStatus ?? "active",
        mediaType: "all",
        searchType: "keyword_unordered",
      }
      const ads = await this.collectAds(params)
      const brands = aggregateBrands(ads, country)
      if (brands.length === 0) {
        return Left(
          new Error(
            `No advertisers found for "${q}". Pass a brand's bare domain (e.g. 'vitalityextracts.com') for best ` +
              `results, or set META_ADS_ENGINE=browser (Playwright) / META_ADS_API_KEY.`,
          ),
        )
      }
      return Right(brands.slice(0, opts.limit ?? 25))
    } catch (error) {
      return Left(new Error(`Failed to search the Meta Ad Library: ${toError(error).message}`))
    }
  }

  /**
   * Fetch an advertiser's ads with full copy. The advertiser may be a numeric page id, an Ad Library
   * URL (`view_all_page_id=`), or a page name / domain (keyword search). Filters by media type,
   * active status and platform, and sorts (default: longest-running, i.e. likely winners first).
   */
  async getAdvertiserAds(
    advertiser: string,
    opts: GetAdvertiserAdsOptions = {},
  ): Promise<Either<Error, MetaAdvertiserAds>> {
    try {
      const trimmed = advertiser.trim()
      if (trimmed === "") {
        return Left(new Error("An advertiser is required (page id, page name, or an Ad Library URL)."))
      }
      const country = opts.country ?? this.config.country
      const mediaType = opts.mediaType ?? "all"
      const activeStatus = opts.activeStatus ?? "all"
      const ref = parseAdvertiserRef(trimmed)
      const params: MetaAdSearchParams =
        ref.kind === "page"
          ? { viewAllPageId: ref.pageId, country, activeStatus, mediaType, platform: opts.platform, searchType: "page" }
          : { q: ref.q, country, activeStatus, mediaType, platform: opts.platform, searchType: "keyword_unordered" }

      const raw = await this.collectAds(params)
      const filtered = filterAds(raw, { mediaType, activeStatus, platform: opts.platform })
      const sorted = sortAds(filtered, opts.sort ?? "longest_running")
      const limited = sorted.slice(0, opts.limit ?? 50)

      if (limited.length === 0) {
        return Left(
          new Error(
            `No ads parsed for "${trimmed}". They may have no ads matching your filters running right now, or Meta ` +
              `gated the request. Try active_status=all / media_type=all, or set META_ADS_ENGINE=browser (Playwright) ` +
              `or META_ADS_API_KEY.`,
          ),
        )
      }

      const top = limited[0]
      return Right({
        advertiser: trimmed,
        pageId: ref.kind === "page" ? ref.pageId : top.pageId,
        pageName: top.pageName,
        ads: limited,
        hasMore: sorted.length > limited.length,
      })
    } catch (error) {
      return Left(new Error(`Failed to fetch advertiser ads: ${toError(error).message}`))
    }
  }

  /**
   * Download an advertiser's creative files (static images and/or videos) to disk. Reuses
   * {@link getAdvertiserAds} to find the ads, then writes each creative into
   * `<baseDir>/<advertiser-slug>/`, bounded by `maxFiles`. Returns a manifest of what was saved.
   */
  async downloadAdvertiserCreatives(
    advertiser: string,
    opts: DownloadCreativesOptions = {},
  ): Promise<Either<Error, MetaDownloadManifest>> {
    try {
      const what = opts.what ?? "images"
      // Pull the media type matching what we'll download, unless the caller pinned one.
      const mediaType: MetaAdMediaType =
        opts.mediaType ?? (what === "videos" ? "video" : what === "all" ? "all" : "image")
      const adsEither = await this.getAdvertiserAds(advertiser, {
        country: opts.country,
        mediaType,
        activeStatus: opts.activeStatus ?? "all",
        sort: "longest_running",
        limit: opts.limit ?? 50,
      })
      const data = adsEither.fold(
        (err) => {
          throw err
        },
        (d) => d,
      )

      // Resolve the local transcription toolchain when videos are in scope.
      const wantTranscribe = (what === "videos" || what === "all") && (opts.transcribe ?? "auto") !== "off"
      const readiness = wantTranscribe ? detectTranscribeTools() : undefined
      const transcribe: { tools: TranscribeTools; threads?: number; fast?: boolean } | undefined =
        readiness?.ready === true
          ? { tools: readiness.tools, fast: opts.transcribeFast, threads: opts.transcribeThreads }
          : undefined
      const note = readiness?.ready === false ? readiness.guidance : undefined

      const dir = join(opts.baseDir ?? "meta-ads-creatives", slugify(data.pageName ?? advertiser))
      const manifest = await downloadCreatives(data.ads, {
        advertiser: data.pageName ?? advertiser,
        dir,
        what,
        maxFiles: opts.maxFiles ?? 50,
        userAgent: this.config.userAgent,
        minDelayMs: Math.min(this.config.minDelayMs, 1200),
        transcribe,
      })

      if (manifest.saved.length === 0) {
        return Left(
          new Error(
            `Found ${data.ads.length} ad(s) for "${advertiser}" but downloaded 0 creatives ` +
              `(${manifest.failed} fetch failure(s)). The CDN links may have expired - re-run, or try what="all".`,
          ),
        )
      }
      return Right(note !== undefined ? { ...manifest, note } : manifest)
    } catch (error) {
      return Left(new Error(`Failed to download creatives: ${toError(error).message}`))
    }
  }

  async close(): Promise<void> {
    if (this.engine !== undefined) {
      await this.engine.close()
    }
  }
}

// Singleton instance (mirrors the Reddit + Facebook + Amazon client pattern).
const clientHolder: { instance: Option<MetaAdsClient> } = { instance: Option.none() }

export function initializeMetaAdsClient(config: MetaAdsClientConfig): MetaAdsClient {
  const client = new MetaAdsClient(config)
  clientHolder.instance = Option(client)
  return client
}

export function getMetaAdsClient(): Option<MetaAdsClient> {
  return clientHolder.instance
}

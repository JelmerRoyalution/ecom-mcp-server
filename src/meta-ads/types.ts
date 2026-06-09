import type { CacheConfig } from "../types"

/**
 * Meta Ad Library scraping engine selection.
 *
 * - `http`    - lightweight `fetch`: harvest the page's `lsd`/`fb_dtsg`/`doc_id` tokens, then POST
 *               the internal `/api/graphql/` endpoint directly. Fast and dependency-free, but
 *               brittle when Meta rotates `doc_id` or markup - best-effort.
 * - `browser` - Playwright-driven Chromium that navigates the real Ad Library URL and intercepts
 *               the GraphQL JSON responses (Meta's own JS builds the tokens for us). The most
 *               robust path. Requires the optional `playwright` peer dependency + a browser binary.
 * - `api`     - route through a paid provider (e.g. ScrapeCreators) that handles proxies, tokens
 *               and pagination. Needs META_ADS_API_KEY.
 * - `auto`    - prefer `api` when a key is set, else `browser` when Playwright is available,
 *               otherwise fall back to `http`. (Unlike the other modules, browser is preferred even
 *               without a session cookie, because the Ad Library is public.)
 */
export type MetaAdsEngine = "auto" | "http" | "browser" | "api"

/** Paid Ad Library API providers behind the optional `api` engine. */
export type MetaAdsApiProvider = "scrapecreators"

/** Active-status filter for the Ad Library search. */
export type MetaAdActiveStatus = "all" | "active" | "inactive"

/** Media-type filter for the Ad Library search. */
export type MetaAdMediaType = "all" | "image" | "video" | "meme" | "none"

/** Publisher-platform filter. */
export type MetaAdPlatform = "facebook" | "instagram" | "messenger" | "audience_network" | "threads"

/** Meta's ad rendering format. `DCO`/`DPA`/`CAROUSEL` carry their real creatives in `cards[]`. */
export type MetaAdDisplayFormat = "IMAGE" | "VIDEO" | "CAROUSEL" | "DCO" | "DPA" | string

/** Result ordering. `longest_running` is the strongest free "winning ad" proxy. */
export type MetaAdSort = "relevance" | "newest" | "longest_running"

/**
 * An (optional) Meta session. The Ad Library is public, so a session is not required - it only
 * smooths Meta's anti-bot defences. Reuses the same `facebook.com` login as the Facebook module.
 */
export type MetaAdsSession = {
  /** Full `key=value; key=value` Cookie header to replay. */
  readonly cookieHeader: string
}

export type MetaAdsClientConfig = {
  /** Optional session cookies (improves reliability; not required for public reads). */
  readonly session?: MetaAdsSession
  readonly engine: MetaAdsEngine
  /** Default Ad Library country (ISO code, e.g. `US`, `GB`, or `ALL`). */
  readonly country: string
  readonly userAgent: string
  /** Minimum delay (ms) enforced between successive requests (anti-bot pacing). */
  readonly minDelayMs: number
  /** Run the browser engine headless. Headful lowers detection but needs a display. */
  readonly headless: boolean
  readonly locale: string
  /** Hard cap on result pages fetched per query (each page ≈ 30 ads). */
  readonly maxPages: number
  /** Optional paid-API credentials enabling the `api` engine. */
  readonly api?: { readonly provider: MetaAdsApiProvider; readonly key: string }
  readonly cache?: CacheConfig
}

/** How to search the Ad Library - keyword/domain (`keyword_*`) or a specific advertiser (`page`). */
export type MetaAdSearchType = "keyword_unordered" | "keyword_exact_phrase" | "page"

/** Normalized search parameters shared by the URL builder, the engines and the parser. */
export type MetaAdSearchParams = {
  /** Keyword or bare domain (e.g. `vitalityextracts.com`); used with `keyword_*` search types. */
  readonly q?: string
  /** Numeric page id; used with the `page` search type to fetch one advertiser's ads. */
  readonly viewAllPageId?: string
  readonly country: string
  readonly activeStatus: MetaAdActiveStatus
  readonly mediaType: MetaAdMediaType
  readonly platform?: MetaAdPlatform
  readonly searchType: MetaAdSearchType
}

/** One creative variant within an ad (the top-level snapshot, or a carousel/DCO card). */
export type MetaAdCreative = {
  /** Primary ad copy (`snapshot.body.text`). */
  readonly body?: string
  /** Headline (`snapshot.title`). */
  readonly title?: string
  /** Display-link domain (`snapshot.caption`, e.g. `vitalityextracts.com`). */
  readonly caption?: string
  readonly linkDescription?: string
  readonly ctaText?: string
  readonly ctaType?: string
  /** Landing-page URL (`snapshot.link_url`). */
  readonly linkUrl?: string
  readonly imageUrls: readonly string[]
  readonly videoUrls: readonly string[]
  readonly videoPreviewImageUrl?: string
}

/** A single ad (one `collated_results[]` entry) from the Ad Library. */
export type MetaAd = {
  /** The "Library ID" (`ad_archive_id`). */
  readonly adArchiveId: string
  readonly pageId: string
  readonly pageName: string
  readonly pageProfileUri?: string
  readonly pageLikeCount?: number
  readonly pageCategories?: readonly string[]
  readonly isActive: boolean
  /** ISO date derived from the epoch `start_date`. */
  readonly startDate?: string
  /** ISO date derived from the epoch `end_date`. */
  readonly endDate?: string
  /** Days the ad has been running (derived from `startDate`) - a winning-ad signal. */
  readonly daysRunning?: number
  readonly displayFormat?: MetaAdDisplayFormat
  readonly publisherPlatforms: readonly string[]
  /** How many near-duplicate creatives Meta grouped (`collation_count`) - a scaling signal. */
  readonly collationCount?: number
  /** Resolved creative (falls back to the first `cards[]` entry for DCO/DPA/CAROUSEL). */
  readonly creative: MetaAdCreative
  /** Carousel/DCO/DPA children, when present. */
  readonly cards?: readonly MetaAdCreative[]
  /** Deep link to the single ad: `…/ads/library/?id=<adArchiveId>`. */
  readonly snapshotUrl: string
  // EU-only transparency (usually absent for US/commercial ads):
  readonly currency?: string
  readonly spendLowerBound?: number
  readonly spendUpperBound?: number
  readonly impressionsText?: string
}

/** A distinct advertiser surfaced by brand discovery (de-duped by `pageId`). */
export type MetaAdBrand = {
  readonly pageId: string
  readonly pageName: string
  readonly pageProfileUri?: string
  readonly pageLikeCount?: number
  readonly pageCategories?: readonly string[]
  /** How many of the query's ads run from this page. */
  readonly adCountSeen: number
  readonly sampleAdCopy?: string
  /** Link to this advertiser's ads in the Ad Library (`…/?view_all_page_id=<pageId>`). */
  readonly snapshotUrl: string
}

/** All ads for one advertiser/page. */
export type MetaAdvertiserAds = {
  readonly advertiser: string
  readonly pageId?: string
  readonly pageName?: string
  readonly ads: readonly MetaAd[]
  readonly hasMore: boolean
}

/** Which creatives to download. */
export type MetaCreativeKind = "image" | "video"

/** What to fetch in a creative download. */
export type MetaDownloadWhat = "images" | "videos" | "all"

/** Whether to transcribe downloaded videos. `auto` = transcribe when the local toolchain is present. */
export type MetaTranscribeMode = "auto" | "off"

/** One downloaded creative file. */
export type MetaSavedCreative = {
  readonly adArchiveId: string
  readonly pageName: string
  readonly kind: MetaCreativeKind
  readonly file: string
  readonly bytes: number
  readonly daysRunning?: number
  readonly snapshotUrl: string
  /** Path to the transcript `.txt` (videos only, when transcription ran). */
  readonly transcriptFile?: string
  /** Transcript length in characters (videos only). */
  readonly transcriptChars?: number
}

/** Result of downloading an advertiser's creatives to disk. */
export type MetaDownloadManifest = {
  readonly advertiser: string
  readonly dir: string
  readonly saved: readonly MetaSavedCreative[]
  readonly failed: number
  readonly totalBytes: number
  /** Number of videos transcribed in this run. */
  readonly transcribed?: number
  /** Actionable note when transcription was requested but couldn't run. */
  readonly note?: string
}

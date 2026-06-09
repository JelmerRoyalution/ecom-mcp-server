# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is an e-commerce customer-research MCP (Model Context Protocol) server. It began as a Reddit MCP server and has been expanded to **also scrape public and private Facebook groups**, **Amazon product reviews**, and the **Meta (Facebook/Instagram) Ad Library** (competitor ad spying), and to turn scraped discussions into **customer personas using Eugene Schwartz's "Breakthrough Advertising" framework**. It's built with TypeScript and uses FastMCP to expose Reddit, Facebook, Amazon, Meta-Ad-Library, and persona-building tools to AI assistants.

> Note: the npm package is still named `reddit-mcp-server` (the published identity / `mcpName` is unchanged); the repository directory is `ecom-mcp-server` reflecting the broadened scope.

## Available Tools

### Read-only Tools (Client Credentials Only)

- `get_reddit_post` - Get a specific Reddit post with engagement analysis
- `get_top_posts` - Get top posts from a subreddit or home feed
- `browse_subreddit` - Browse a subreddit or home feed by sort order (hot, new, top, rising, controversial); `time_filter` applies only to top/controversial
- `get_user_info` - Get detailed information about a Reddit user
- `get_subreddit_info` - Get subreddit details, stats, and community insights
- `get_trending_subreddits` - Get currently trending/popular subreddits
- `search_reddit` - Search for posts across Reddit with filters
- `get_post_comments` - Get comments from a specific post with threading
- `get_user_posts` - Get posts submitted by a specific user
- `get_user_comments` - Get comments made by a specific user

### Write Tools (User Credentials Required)

**IMPORTANT**: These tools require both REDDIT_USERNAME and REDDIT_PASSWORD to be configured.

- `create_post` - Create a new post in a subreddit (text or link)
- `reply_to_post` - Post a reply to an existing Reddit post or comment
- `edit_post` - Edit your own Reddit post (self-text posts only, titles cannot be edited)
- `edit_comment` - Edit your own Reddit comment
- `delete_post` - **PERMANENTLY** delete your own Reddit post (cannot be undone!)
- `delete_comment` - **PERMANENTLY** delete your own Reddit comment (cannot be undone!)

### Facebook Tools (Scraping)

Scrape public and private Facebook groups/pages for customer-discussion research. Private groups require a `FACEBOOK_COOKIE` session belonging to a member of the group; the optional Playwright **browser engine** is the most reliable path (Facebook's Groups Graph API was removed in April 2024 and `mbasic` was largely retired in Dec 2024, so authenticated-session scraping is the only viable route).

- `facebook_get_group_posts` - Scrape recent posts from a group's feed (public or private)
- `facebook_get_post_comments` - Scrape the comment thread of a Facebook post (by permalink URL)
- `facebook_get_group_info` - Group metadata: name, privacy, member count, description
- `facebook_search_groups` - Search Facebook for groups by niche
- `facebook_get_page_posts` - Scrape a public Facebook Page feed
- `test_facebook_connection` - Report session/engine/Playwright status

### Amazon Tools (Reviews Scraping)

Scrape Amazon product reviews for customer-research. Amazon shows logged-out visitors only a handful of "featured" reviews; depth requires either an `AMAZON_COOKIE` session (logged-in, replayed via the optional Playwright browser engine - the same pattern as Facebook private groups) or a paid reviews API (`AMAZON_API_KEY`, provider Unwrangle/Rainforest). The free HTTP engine reads the first public pages best-effort and surfaces a clear "login wall" message when Amazon serves no review content. Accepts a bare 10-char ASIN or any Amazon product/review URL (marketplace auto-detected).

- `amazon_search_products` - Search Amazon by niche/keyword → product cards (ASIN, title, rating) to feed into `amazon_get_product_reviews`. Best-effort: Amazon search is bot-protected logged-out, so most reliable with `AMAZON_COOKIE` + browser engine. Use when the user names a niche but no specific product.
- `amazon_get_product_reviews` - Scrape a product's reviews (stars, title, body, verified-purchase, date, country, helpful votes) plus its rating summary; supports `sort`, `star_filter`, `verified_only`, `marketplace`
- `amazon_get_product_info` - Product metadata + rating summary (average stars, total ratings, per-star distribution) without review bodies
- `test_amazon_connection` - Report session/engine/API/Playwright status

### Meta Ad Library Tools (Competitor Ad Spying)

Scrape the **public** Meta (Facebook/Instagram) Ad Library - the capability behind ad-spy tools like Atria/Foreplay/Winning Hunter. The official Graph `ads_archive` API only covers political/issue ads, so this targets the same internal GraphQL endpoint (`facebook.com/api/graphql/`, `AdLibrarySearchPaginationQuery`) the public web UI calls, returning JSON (ad copy, headline, CTA, image/video URLs, landing page, page name, run-dates, active status, platforms). The Ad Library is public, so no login is required; a Facebook session only smooths anti-bot. Self-contained `src/meta-ads/` module; **JSON-first** (the browser engine intercepts the GraphQL response, the parser normalizes JSON - it does NOT scrape HTML). Standalone (no persona-pipeline integration).

- `meta_ads_find_brands` - Discover advertisers. **Best input = a brand's bare domain** (e.g. `vitalityextracts.com`, no `https://`): a unique domain surfaces the brand's whole **connected page network** (main page + affiliate/advertorial pages). De-dupes ads into distinct advertiser cards ranked by ad volume. Niche keywords also work but are noisier.
- `meta_ads_get_advertiser_ads` - Fetch an advertiser's ads (page id, Ad Library URL, or name/domain) with full copy/CTA/media. Filters: `media_type`, `active_status`, `platform`. Defaults to `sort=longest_running` - the strongest free "winning ad" signal (a long-running, heavily-duplicated creative is almost certainly profitable). The formatter leads each ad with `daysRunning` + `collationCount` (variant count).
- `meta_ads_download_creatives` - Download an advertiser's creative **files** (static images and/or videos) to `<META_ADS_DOWNLOAD_DIR or 'meta-ads-creatives'>/<advertiser>/`, named by ad id. `src/meta-ads/downloader.ts` sniffs the real file type from magic bytes (Facebook's CDN mislabels types - e.g. serves PNGs as `image/jpeg`), paces requests, dedupes by URL, and caps at `max_files`. For **videos**, when the local whisper.cpp toolchain is present (`transcribe: auto`), it also transcribes each to a `<base>.txt` script plus a combined `<base>.script.md` (ad copy + spoken script) via `src/meta-ads/transcribe.ts`. Writes to local disk.
- `test_meta_ads_connection` - Report session/engine/API/Playwright status

**Engines** (`META_ADS_ENGINE`, three-tier like Amazon): `browser` (Playwright intercepts the GraphQL JSON - most robust, the default when Playwright is present, preferred even without a cookie); `http` (harvests `lsd`/`fb_dtsg`/`doc_id` from the page then POSTs `/api/graphql/` - brittle when Meta rotates `doc_id`); `api` (optional paid provider, ScrapeCreators, via `META_ADS_API_KEY`). By default the session **reuses `FACEBOOK_COOKIE`** (same `facebook.com` login), so `pnpm run setup` wires it up automatically. **Critical parser detail:** DCO/DPA/CAROUSEL ads carry `{{product.name}}`-style templates at the top level with the real creatives + media URLs in `snapshot.cards[]`, so the parser resolves the creative from `cards[]` in those cases.

### Customer Persona Tools (Schwartz "Breakthrough Advertising")

Platform-agnostic - feed them text scraped from Reddit, Facebook, Amazon, or any mix.

- `analyze_voice_of_customer` - Mine a corpus into pains, desires, objections, questions, emotional triggers, product mentions, recurring phrases, and verbatim quotes
- `build_customer_persona` - Produce a persona brief organized by **mass desire**, the **5 awareness stages**, and the **5 market-sophistication levels**, with synthesis instructions for the LLM. Accepts raw `texts` and/or `facebook_group`/`subreddits`/`amazon_products` to auto-scrape **posts AND their comments**, and **products AND their reviews** (via the shared `gatherVoiceRows` helper in `index.ts`).
- `export_comments_csv` - Deep-scrape Facebook groups, subreddits, and/or Amazon products to a **CSV**, one row per **post/product and comment/review**, linked by a shared `post_id` with a `row_type` of `post`/`comment`/`review` (Amazon `post_id` = ASIN). Columns: `platform, source_url, post_id, post_url, row_type, author, timestamp, upvotes, category, text` (ISO timestamps for Reddit; rendered labels for Facebook/Amazon). The **`upvotes`** column is the per-row crowd-validation signal - Reddit `score` (post+comment), Facebook reactions (`likeCount`), Amazon "found helpful" votes (`helpfulVotes`); blank when the platform exposed none (populated via the `votesCell` helper in `index.ts`). All three platforms share `gatherVoiceRows` (Facebook: `getGroupComments` feed→post→thread; Reddit: top posts→comments; Amazon: `getProductReviews` per ASIN). Posts/products are always kept; comments **and reviews** are value-filtered via `isValuableComment` and tagged via `classifyComment` (Amazon reviews additionally fall back to the star rating: ≤2★→pain, ≥4★→desire, via `classifyReview`). CSV serialization in `src/utils/csv.ts`. Output files match `voice-of-customer-*.csv` and are git-ignored (may contain personal data).

### Server Modes

The server supports two transport modes:

1. **HTTP Server (Default)**: Runs on port 3000 with `/mcp` endpoint
   - Used for Docker deployments and direct execution
   - Access via: `http://localhost:3000/mcp`
   - SSE endpoint: `http://localhost:3000/sse`

2. **Stdio Mode**: For CLI and npx usage
   - Automatically enabled when using `npx reddit-mcp-server` or the bin entry point
   - Used for integration with Claude Desktop and other MCP clients

## Development Commands

```bash
# Install dependencies
pnpm install

# Build TypeScript to JavaScript with tsup
pnpm build

# Run the MCP inspector for development/testing
pnpm inspect

# Build and run inspector in one command
pnpm dev

# Build and start the server via npx
pnpm start

# Format code with Prettier
pnpm format

# Check code formatting
pnpm format:check

# Lint code with ESLint
pnpm lint

# Fix linting issues
pnpm lint:fix
```

## Architecture

### Core Components

1. **Reddit Client** (`src/client/reddit-client.ts`): Singleton pattern implementation that handles:
   - OAuth2 authentication (client credentials and password flow)
   - Automatic token refresh via axios interceptors
   - Rate limiting and error handling
   - Both read-only and authenticated operations

2. **Tool Modules** (`src/tools/`): Modular organization by functionality:
   - `post-tools.ts`: Post creation, retrieval, and management
   - `comment-tools.ts`: Comment retrieval and threading
   - `subreddit-tools.ts`: Subreddit info, statistics, trending
   - `user-tools.ts`: User information and engagement insights
   - `search-tools.ts`: Reddit search functionality

3. **Type Definitions** (`src/types.ts`): Comprehensive TypeScript types for all Reddit entities

4. **Facebook Module** (`src/facebook/`): Self-contained Facebook scraping subsystem:
   - `facebook-client.ts`: Singleton client (mirrors the Reddit client's `Either`/`Option` pattern) - engine selection, request pacing, response caching, URL building. Methods: `getGroupFeed`, `getPostComments`, `getGroupInfo`, `getPageFeed`, `searchGroups`.
   - `engines.ts`: Pluggable fetch engines behind `FacebookFetchEngine`. `HttpFetchEngine` (native `fetch` against `mbasic.facebook.com`) and `BrowserFetchEngine` (lazy-loads the optional `playwright` peer, drives a logged-in Chromium, scrolls + expands comments). `isPlaywrightAvailable()` gates `auto` selection.
   - `parsers.ts`: The single source of truth that turns Facebook mobile/rendered HTML into structured posts/comments/groups via Cheerio. Tolerant, layered selectors with fallbacks. **Fully unit-tested with fixtures** - both engines feed HTML into these same parsers.
   - `cookies.ts`: Parse/validate session cookies (requires `c_user` + `xs`).
   - `cookie-extractor.ts`: **Auto-grabs the Facebook login from a locally installed, logged-in browser** (Chrome/Brave/Edge/Arc/Chromium/Vivaldi/Opera) so users never copy‑paste cookies. Two strategies: (1) **direct decryption** on macOS/Linux - reads the cookie SQLite DB (`sqlite3` CLI) + the OS keychain "Safe Storage" key (`security` on macOS) + AES‑128‑CBC, stripping the newer 32‑byte `sha256(host_key)` prefix; (2) a **Playwright fallback** that lets the real browser binary decrypt its own cookies (covers Windows DPAPI/App‑Bound). Used by `pnpm run setup` (writes `.env`) and by the runtime `FACEBOOK_COOKIE_FROM` option.
   - `format.ts`: Markdown formatters for tool output.
   - `types.ts`: Facebook domain + config types.

   **Onboarding:** `pnpm run setup` (script: `scripts/setup.ts`) detects the user's browser, extracts their Facebook session (and best-effort Reddit + Amazon cookies), and writes `FACEBOOK_COOKIE` + `FACEBOOK_ENGINE=browser` (plus `REDDIT_COOKIE`, `AMAZON_COOKIE`/`AMAZON_ENGINE=browser` when found) to `.env`. NB: `pnpm setup` (without `run`) is a reserved pnpm builtin - always use `pnpm run setup`.

5. **Amazon Module** (`src/amazon/`): Self-contained Amazon reviews scraping subsystem, mirroring the Facebook module's structure and conventions exactly:
   - `amazon-client.ts`: Singleton client (`Either`/`Option` pattern) - three-tier engine selection (`api` if a key is set, else `browser` when a session + Playwright are present, else `http`), request pacing, response caching, ASIN/marketplace resolution, review **pagination** (walks `pageNumber` pages, capped at `AMAZON_MAX_REVIEW_PAGES`), and **star-filter fan-out**: Amazon caps each filtered view at ~100 reviews, so when depth is requested and no single star is pinned, `getProductReviews` loops a deliberate **5★/3★/1★ spread** (love / balanced / biggest-complaints - the most signal-rich for personas; 4★/2★ add mostly overlap) plus the default mixed view via `collectReviewWindow` and dedupes by review id (ceiling a few hundred/product - the same technique paid APIs use). A dry-streak guard bails early when Amazon serves the gated "limited selection" render that ignores the filter params. Methods: `getProductReviews`, `getProductInfo`, `searchProducts`.
   - `engines.ts`: Pluggable fetch engines behind `AmazonFetchEngine`. `HttpFetchEngine` (native `fetch` against `/product-reviews/{ASIN}`) and `BrowserFetchEngine` (lazy-loads the optional `playwright` peer, replays an `AMAZON_COOKIE` session). `assertNotBlocked()` detects Amazon's "robot check"/CAPTCHA; `isPlaywrightAvailable()` gates `auto` selection.
   - `api-engine.ts`: Optional paid reviews-API adapter (`fetchViaApi`) normalizing **Unwrangle** and **Rainforest** JSON into the domain types - the most reliable tier, bypassing anti-bot/login walls.
   - `parsers.ts`: The single source of truth that turns Amazon review HTML into structured products/reviews via Cheerio, anchored on durable `data-hook` selectors (`review`, `review-body`, `review-star-rating`, `review-date`, `avp-badge`, `helpful-vote-statement`, `format-strip`) with tolerant fallbacks. Also `extractAsin` (all URL shapes + bare), `detectMarketplace`, `buildReviewsUrl`. **Fully unit-tested with fixtures.**
   - `cookies.ts`: Parse/validate an Amazon cookie header (lenient: any recognizable session cookie like `session-id`/`at-main`).
   - `format.ts`: Markdown formatters for tool output.
   - `types.ts`: Amazon domain + config types.

   > Reality check (validated live): logged-out `/product-reviews/` pages now contain **zero** review nodes - Amazon gates reviews behind a login wall, exactly like Facebook private groups. So depth needs `AMAZON_COOKIE` (browser engine) or `AMAZON_API_KEY`; the HTTP engine degrades gracefully with an actionable message. Amazon cookie auto-pickup reuses `cookie-extractor.ts`'s `extractAmazonCookieHeader` (macOS/Linux direct decryption of `%amazon.%` cookies).

6. **Meta Ad Library Module** (`src/meta-ads/`): Self-contained competitor-ad-spying subsystem. Mirrors the Facebook/Amazon module conventions (singleton `Either`/`Option` client, lazy Playwright peer, `ResponseCache`, pacing, `eslint-disable` imperative-boundary headers) with **one deliberate deviation: it is JSON-first, not HTML-first** - the Ad Library is a GraphQL SPA, so engines return intercepted JSON pages (not HTML) and `parsers.ts` normalizes JSON.
   - `meta-ads-client.ts`: Singleton client. Three-tier engine selection (`api` if a key is set, else `browser` when Playwright is present - **even without a cookie, since the Ad Library is public** - else `http`). Methods `findBrands` (de-dupes ads into advertiser cards via `aggregateBrands`) and `getAdvertiserAds` (filter + sort, default `longest_running`).
   - `engines.ts`: `MetaAdsFetchEngine` returns raw GraphQL pages via `fetchAdPages`. `BrowserFetchEngine` drives Chromium and **intercepts the XHR GraphQL responses** (`page.on("response")` on `/api/graphql/`) - the robust path, since Meta's own JS builds the tokens/`doc_id`. `HttpFetchEngine` harvests tokens then POSTs `/api/graphql/` directly (brittle). `isPlaywrightAvailable()` gates `auto`.
   - `tokens.ts`: Harvest `lsd`/`fb_dtsg`/`jazoest`/spin params + the volatile `doc_id` from page HTML; build the GraphQL form body + `variables` (used only by the http engine).
   - `parsers.ts`: The single source of truth that normalizes the GraphQL JSON into domain types. Defensively locates `search_results_connection`, walks `edges[].node.collated_results[]`, and **resolves the creative from `snapshot.cards[]` when `display_format` is DCO/DPA/CAROUSEL** (the top-level `body`/`title` are `{{…}}` templates there). Derives `daysRunning` from `start_date`, extracts media URLs, and `aggregateBrands` de-dupes by `page_id`. **Fully unit-tested with a real-shape fixture.**
   - `api-engine.ts`: Optional paid Ad Library API adapter (`fetchViaApi`, ScrapeCreators) - reuses `normalizeAdNode` since providers return Meta's `snapshot` shape, with a flat fallback.
   - `downloader.ts`: Filesystem boundary for `meta_ads_download_creatives` - fetches creative image/video files to disk with magic-byte file-type sniffing, pacing, URL dedupe and a `max_files` cap. Delegates video transcription to `transcribe.ts`.
   - `transcribe.ts`: Optional LOCAL video transcription (no API key) via whisper.cpp + ffmpeg - `mp4 → 16kHz mono PCM wav (ffmpeg) → whisper-cli .txt`. Feature-detects the toolchain (prefers the native `/opt/homebrew` whisper-cli over the slow Rosetta PATH build), prefers the `small.en` model (the speed/quality sweet spot) among `~/.whisper-models` (override via `META_ADS_WHISPER_MODEL`), is idempotent (skips if the `.txt` exists), and degrades with install guidance when absent.
   - `cookies.ts`: Lenient cookie parsing (the Ad Library is public, so a session is optional - any facebook.com cookie header is accepted). `format.ts`: Markdown formatters leading with the winning-ad signals. `types.ts`: domain + config types.

   > Reality check (validated live, authenticated): the bare-domain search (`q=vitalityextracts.com`, `search_type=keyword_unordered`) returns ~370 tightly-relevant ads and surfaces the brand's **whole connected page network** (e.g. _Vitality Extracts Essential Oils_ + _Families For Wellness_ + _Hair Envy_). A generic word (`seed.com`) matches everywhere (>50k results), so a unique domain is the power query. The session **reuses `FACEBOOK_COOKIE`** by default (auto-pickup via `cookie-extractor.ts`'s `extractMetaAdsCookieHeader`, `%facebook.com`).

7. **Persona Module** (`src/persona/schwartz.ts`): Deterministic voice-of-customer text mining + the Schwartz "Breakthrough Advertising" structuring (awareness distribution, sophistication level, mass desire). **Extraction is deterministic here; synthesis is delegated to the calling LLM** via `buildPersonaBrief`. Platform-agnostic and fully unit-tested.

> **Imperative-boundary convention:** the Facebook, Amazon **and Meta Ad Library** `parsers.ts`/`engines.ts`/`api-engine.ts`/`tokens.ts`/`downloader.ts`/`transcribe.ts`/`*-client.ts`, plus `schwartz.ts`, carry an `eslint-disable` header for the functype style rules (same convention as `reddit-client.ts`/`response-cache.ts`) because DOM/JSON-walking, external IO, and lexicon scanning are inherently imperative.

> **Optional Playwright peer:** `playwright` is NOT a hard dependency (keeps the base install light and avoids a Chromium download for Reddit-only users). It is lazy-loaded via an indirect dynamic import and marked `deps.neverBundle` in `tsdown.config.ts`. The Facebook, Amazon **and Meta Ad Library** tools degrade to the HTTP engine and give actionable install guidance when it's absent.

### Authentication Flow

The server supports three authentication modes configured via `REDDIT_AUTH_MODE`:

1. **auto (default)**: Automatically chooses the best authentication method
   - If REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET are provided: Uses OAuth (60-100 req/min)
   - Otherwise: Falls back to anonymous mode (~10 req/min)
   - Gracefully degrades without failing

2. **authenticated**: Requires OAuth credentials
   - Requires REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET
   - Server fails to start if credentials are missing
   - Provides higher rate limits (60-100 req/min)
   - Use for production environments with guaranteed credentials

3. **anonymous**: Uses public JSON API without authentication
   - No credentials required - zero-setup experience
   - Lower rate limit (~10 req/min)
   - Perfect for testing and development
   - Read-only operations work without any Reddit app setup

**Write operations** (create_post, reply_to_post, edit_post, edit_comment, delete_post, delete_comment):

- Require REDDIT_USERNAME and REDDIT_PASSWORD in **any** mode
- Will fail gracefully with a clear error message if credentials are missing
- Token management is handled automatically by the Reddit client

### Safe Mode (Spam Protection)

The server includes optional safeguards to protect against Reddit's spam detection, configured via `REDDIT_SAFE_MODE`:

1. **off (default)**: No safeguards, original behavior
2. **standard**: Recommended for normal use
   - 2-second delay between write operations
   - Duplicate content detection (tracks last 10 items)
3. **strict**: For cautious automated posting
   - 5-second delay between write operations
   - Aggressive duplicate detection (tracks last 20 items)

**Features:**

- **Rate Limiting**: Enforces minimum delays between write operations to avoid spam flags
- **Duplicate Detection**: Blocks identical content from being posted, with clear error messages
- **Smart User-Agent**: Auto-generates Reddit-compliant User-Agent format (`typescript:reddit-mcp-server:1.1.0 (by /u/USERNAME)`) when username is provided

### Response Caching (Rate-Limit Relief)

Read-only GET requests are cached in-memory to reduce pressure on Reddit's tight rate limits (~10 req/min anonymous, 60-100 authenticated). Configured via `REDDIT_CACHE` (default `on`, set `off` to disable) and `REDDIT_CACHE_MAX_MB` (default `50`).

- **Adaptive TTLs** (`src/client/response-cache.ts`): volatile listings (hot/new/rising) and comment threads cache for 60s; top/controversial, search, and user/subreddit `about` cache for 300s; everything else 120s.
- **Bounded LRU**: total cached bytes are capped at `REDDIT_CACHE_MAX_MB`; least-recently-used entries are evicted first. A single response larger than the cap is never cached.
- **Scope**: only successful `GET` responses are cached, keyed by full URL. Write operations and auth requests are never cached. The cache layer lives in `RedditClient.makeRequest`, which re-wraps cached bodies in a fresh `Response` (a fetch body can only be consumed once).
- Only active when enabled; when disabled the client behaves exactly as before (raw `Response` passthrough).

## Environment Setup

Environment variables:

```bash
# Reddit API Credentials (optional unless using authenticated mode)
REDDIT_CLIENT_ID=your_client_id
REDDIT_CLIENT_SECRET=your_client_secret
REDDIT_USER_AGENT=YourApp/1.0.0  # Optional, defaults to "RedditMCPServer/1.1.0"

# Reddit User Credentials (optional, for write operations)
REDDIT_USERNAME=your_username
REDDIT_PASSWORD=your_password

# Authentication Mode (optional, defaults to 'auto')
REDDIT_AUTH_MODE=auto            # Options: auto, authenticated, anonymous

# Safe Mode (optional, defaults to 'off')
REDDIT_SAFE_MODE=standard        # Options: off, standard, strict

# Response Caching (optional, defaults to 'on')
REDDIT_CACHE=on                  # Options: on, off
REDDIT_CACHE_MAX_MB=50           # Cache size cap in MB (LRU eviction beyond this)

# Facebook (groups + pages scraping)
# EASIEST: run `pnpm run setup` to auto-fill FACEBOOK_COOKIE from your browser.
FACEBOOK_COOKIE=                 # Full Cookie header from a logged-in browser (needs c_user + xs); required for private groups
# FACEBOOK_COOKIE_FROM=chrome    # Auto-read cookies at startup: chrome|brave|edge|arc|chromium|vivaldi|opera
# FACEBOOK_COOKIE_FROM_PROFILE=Default
# FACEBOOK_C_USER=               # Alternative to FACEBOOK_COOKIE: discrete cookie parts
# FACEBOOK_XS=
# FACEBOOK_DATR=
FACEBOOK_ENGINE=auto             # auto (default), http, browser (Playwright)
# FACEBOOK_HEADLESS=true         # Run browser engine headless (true/false)
# FACEBOOK_MIN_DELAY_MS=4000     # Min delay between FB requests (anti-bot pacing)
# FACEBOOK_LOCALE=en_US          # Preferred locale
# FACEBOOK_USER_AGENT=           # Override the User-Agent
# FACEBOOK_CACHE=on              # In-memory response cache (on/off)
# FACEBOOK_CACHE_MAX_MB=50       # Cache size cap in MB

# Amazon (product reviews scraping)
# EASIEST: run `pnpm run setup` to auto-fill AMAZON_COOKIE from your browser (macOS/Linux).
AMAZON_COOKIE=                   # Full Cookie header from a logged-in amazon.com browser; lets the scraper page deeper into review history
# AMAZON_COOKIE_FROM=chrome      # Auto-read amazon cookies at startup: chrome|brave|edge|arc|chromium|vivaldi|opera
# AMAZON_COOKIE_FROM_PROFILE=Default
AMAZON_ENGINE=auto               # auto (default), http, browser (Playwright), api (paid reviews API)
# AMAZON_API_KEY=                # Paid reviews API key (most reliable path; bypasses anti-bot + login walls)
# AMAZON_API_PROVIDER=unwrangle  # unwrangle (default) or rainforest
# AMAZON_MARKETPLACE=com         # Default marketplace TLD when only an ASIN is given (com, co.uk, de, …)
# AMAZON_MIN_DELAY_MS=3000       # Min delay between Amazon requests (anti-bot pacing)
# AMAZON_MAX_REVIEW_PAGES=10     # Hard cap on review pages fetched per product (~10 reviews/page)
# AMAZON_HEADLESS=true           # Run browser engine headless (true/false)
# AMAZON_LOCALE=en_US            # Preferred locale
# AMAZON_USER_AGENT=             # Override the User-Agent
# AMAZON_CACHE=on                # In-memory response cache (on/off)
# AMAZON_CACHE_MAX_MB=50         # Cache size cap in MB

# Meta Ad Library (competitor ad spying)
# The Ad Library is PUBLIC, so no login is needed; by default this reuses FACEBOOK_COOKIE above.
# META_ADS_COOKIE=               # Optional separate facebook.com Cookie header (else reuses FACEBOOK_COOKIE)
# META_ADS_COOKIE_FROM=chrome    # Auto-read facebook.com cookies: chrome|brave|edge|arc|chromium|vivaldi|opera
META_ADS_ENGINE=auto             # auto (default), http, browser (Playwright - most robust), api (paid provider)
# META_ADS_COUNTRY=US            # Default Ad Library country (ISO code, or ALL)
# META_ADS_API_KEY=              # Optional paid provider key (ScrapeCreators) - reliable at scale
# META_ADS_API_PROVIDER=scrapecreators
# META_ADS_MIN_DELAY_MS=5000     # Min delay between requests (anti-bot pacing)
# META_ADS_MAX_PAGES=10          # Cap on result pages fetched per query (~30 ads/page)
# META_ADS_HEADLESS=true         # Run the browser engine headless (true/false)
# META_ADS_LOCALE=en_US          # Preferred locale
# META_ADS_USER_AGENT=           # Override the User-Agent
# META_ADS_CACHE=on              # In-memory response cache (on/off)
# META_ADS_CACHE_MAX_MB=50       # Cache size cap in MB

# Transport Configuration
# TRANSPORT_TYPE=stdio            # Uncomment for stdio mode (default: httpStream for node, stdio for npx/bin)
PORT=3000                          # HTTP server port (default: 3000)

# OAuth Authentication (for HTTP server)
OAUTH_ENABLED=true                # Set to "true" to enable OAuth protection
OAUTH_TOKEN=your_secret_token     # Optional, will generate random token if not provided
```

### Quick Start Examples

**Try without any setup:**

```bash
export REDDIT_AUTH_MODE=anonymous
npx reddit-mcp-server
```

**With OAuth for higher rate limits:**

```bash
export REDDIT_AUTH_MODE=auto
export REDDIT_CLIENT_ID=your_client_id
export REDDIT_CLIENT_SECRET=your_client_secret
npx reddit-mcp-server
```

**With Safe Mode for write operations:**

```bash
export REDDIT_USERNAME=your_username
export REDDIT_PASSWORD=your_password
export REDDIT_SAFE_MODE=standard
npx reddit-mcp-server
```

### Transport Modes

The server defaults to stdio mode for MCP client compatibility:

- **Running directly**: `node dist/index.js` → stdio mode (default)
- **Running via npx**: `npx reddit-mcp-server` → stdio mode
- **Running via Docker**: Set `TRANSPORT_TYPE=httpStream` for HTTP server on port 3000
- **Force HTTP mode**: Set `TRANSPORT_TYPE=httpStream` or `TRANSPORT_TYPE=http`

### OAuth Security

The HTTP server supports optional OAuth protection:

- **Disabled by default**: The server runs without authentication
- **Enable with**: `OAUTH_ENABLED=true`
- **Token options**:
  - Provide your own: `OAUTH_TOKEN=your-secure-token`
  - Auto-generate: Server creates a random 32-character token on startup
- **Usage**: Include `Authorization: Bearer <token>` header in requests to `/mcp`

Example request with OAuth:

```bash
curl -H "Authorization: Bearer your-token" http://localhost:3000/mcp
```

## Key Implementation Details

1. **Error Handling**: All tools use try-catch blocks and return MCP-compliant error responses
2. **Rate Limiting**: Built into the Reddit client to respect API limits
3. **Token Refresh**: Automatic when tokens expire via authentication checks
4. **Singleton Client**: Ensures single authenticated instance across all tools
5. **Thing IDs**: Reddit uses prefixed IDs (t3* for posts, t1* for comments). The client methods handle both prefixed and non-prefixed IDs automatically.
6. **Edit Operations**: Only self-text posts can be edited. Titles and link posts cannot be edited per Reddit API limitations.
7. **Delete Operations**: Deletions are permanent and cannot be undone. The content is removed but the post/comment ID remains.

### Intentionally Excluded (Policy Compliance)

The following Reddit API capabilities are intentionally NOT implemented per Reddit's Responsible Builder Policy:

- **Direct Messages/Private Messages**: Bots must get explicit consent for private communications
- **Voting (upvote/downvote)**: Manipulating Reddit features like voting or karma is prohibited
- **Bulk data export/scraping**: Reddit data must not be scraped for AI training or commercialized without approval

## Testing Approach

The project uses Vitest for testing:

- **Run tests**: `pnpm test`
- **Watch mode**: `pnpm test:watch`
- **Coverage**: `pnpm test:coverage`
- **Manual testing**: Use the MCP inspector (`pnpm inspect`)
- Test both authenticated and unauthenticated flows
- Verify error handling for invalid inputs and API failures

## Common Development Tasks

1. **Adding a new Reddit tool**:
   - Add method to RedditClient class (`src/client/reddit-client.ts`)
   - Define TypeScript types in `src/types.ts` if needed
   - Create MCP tool in main server (`src/index.ts`)
   - Add tests to `src/client/__tests__/reddit-client.test.ts`
   - Update documentation (README.md and CLAUDE.md)

2. **Modifying Reddit client**:
   - Update `src/client/reddit-client.ts`
   - Ensure backward compatibility with existing tools
   - Test both auth flows if authentication logic changes
   - Add comprehensive tests for new functionality

3. **Debugging**:
   - Use `pnpm inspect` to test tools interactively
   - Check authentication flow for auth issues
   - Verify environment variables are set correctly
   - Review console.error logs for Reddit API responses
   - Test with real Reddit API using test scripts (e.g., create test post, edit, delete)

## Releasing / Version Bumping

**CRITICAL**: Three files must stay in lockstep on every release:

- `package.json` - `.version`
- `server.json` - `.version` AND `.packages[0].version`
- `manifest.json` - `.version`

`npm version <patch|minor|major>` only bumps `package.json`. CI's `prepublishOnly` runs `pnpm check:versions` and **will fail the publish** if the other two drift (this has bitten v1.4.6 - see commit `49f232e`).

### Correct release workflow

```bash
# 1. Make sure check:versions passes BEFORE bumping
pnpm check:versions

# 2. Bump package.json without committing/tagging yet
npm version patch --no-git-tag-version

# 3. Hand-edit server.json (both version fields) and manifest.json to match
#    Or use sed/jq - the file structure is stable

# 4. Verify, validate, then commit + tag together
pnpm check:versions
pnpm validate
git add package.json server.json manifest.json pnpm-lock.yaml
git commit -m "x.y.z"
git tag "v$(node -p "require('./package.json').version")"
git push --follow-tags
```

### Or: use the `vbctp` skill, but stage the JSON files first

The `vbctp` skill runs `pnpm validate` → `npm version patch` → `git push --follow-tags`. `pnpm validate` does NOT include `pnpm check:versions` - only `prepublishOnly` does, which means the mismatch is only caught in CI. **Before invoking vbctp, bump server.json + manifest.json by hand and stage them**; `npm version` will then refuse to run (dirty tree), so commit those changes first, then run vbctp.

### Long-term fix (not yet implemented)

A `"version"` npm lifecycle script can auto-sync the two JSON files and `git add` them, making `npm version patch` atomic. Pattern:

```json
"scripts": {
  "version": "tsx scripts/sync-versions.ts && git add server.json manifest.json"
}
```

Until that exists, treat the three-file sync as a manual checklist item.

# Changelog

All notable changes to this project will be documented in this file.

## [1.5.0] - 2026-06-06

### Added - Facebook group scraping + customer personas

- **Facebook tools**: `facebook_get_group_posts`, `facebook_get_post_comments`, `facebook_get_group_info`, `facebook_search_groups`, `facebook_get_page_posts`, `test_facebook_connection`. Scrapes public **and** private Facebook groups (private groups via a member's `FACEBOOK_COOKIE` session).
- **Two scraping engines** behind a common interface: a lightweight `fetch`-based HTTP engine (default) and an optional Playwright **browser engine** (`FACEBOOK_ENGINE=browser`) - the reliable path for private groups and full comment threads. Playwright is an optional, lazy-loaded peer (not a hard dependency).
- **One-command onboarding** (`pnpm run setup`) + automatic multi-browser cookie pickup (`src/facebook/cookie-extractor.ts`): grabs your Facebook login straight from a logged-in Chrome/Brave/Edge/Arc/Chromium/Vivaldi/Opera profile - no manual cookie copy‑paste. Direct decryption on macOS/Linux (cookie SQLite + OS keychain key + AES) with a Playwright fallback for Windows. Also exposed at runtime via `FACEBOOK_COOKIE_FROM`. `playwright` is now a direct dependency (browser engine is core).
- **Customer persona tools** implementing Eugene Schwartz's _Breakthrough Advertising_ framework: `analyze_voice_of_customer` (mines pains/desires/objections/questions/quotes) and `build_customer_persona` (organizes evidence by mass desire, the 5 awareness stages, and 5 market-sophistication levels). Platform-agnostic - works on Reddit and/or Facebook text.
- **Reddit anonymous 403 fix**: many networks now block Reddit's anonymous JSON API (403). The server auto-borrows your browser's reddit.com cookies (same mechanism as Facebook, no Reddit account/app needed) and replays them, which gets past the block. `extractRedditCookieHeader` + `RedditClient` `cookieHeader`; `pnpm run setup` also caches `REDDIT_COOKIE`. OAuth (`REDDIT_CLIENT_ID`/`SECRET`) remains a last-resort fallback with an actionable error.
- **`export_comments_csv`**: deep comment scraping exported to a CSV. One row per **post and comment**, explicitly linked by a shared `post_id` (+ a `row_type` of `post`/`comment`), so the post↔comment relationship is clear (sort by `post_id`). Columns: `platform, source_url, post_id, post_url, row_type, author, timestamp, category, text` (ISO timestamps for Reddit; the rendered label for Facebook). Posts are always kept; comments are value-filtered.
- **`build_customer_persona` now scrapes posts AND their comments** (was posts only) and accepts `subreddits` as well as `facebook_group`. Both tools share a `gatherVoiceRows` helper. Facebook = feed → open each post → pull its comment thread (`FacebookClient.getGroupComments`); Reddit = top posts → comments. Columns: `platform, source_url, post_url, post_excerpt, author, category, comment`. Low-value reactions (e.g. "following", "thanks") are filtered by value rather than capped, and each comment is categorized (pain/desire/objection/question/other). Adds `src/utils/csv.ts` and `isValuableComment`/`classifyComment` in the persona module. Output files (`voice-of-customer-*.csv`) are git-ignored.
- New `src/facebook/*` module (client, engines, parsers, cookies, formatters, types) and `src/persona/schwartz.ts`, with unit tests for cookie parsing, HTML parsing, and the persona engine.
- Config: `FACEBOOK_COOKIE` (or `FACEBOOK_C_USER`/`FACEBOOK_XS`/`FACEBOOK_DATR`), `FACEBOOK_ENGINE`, `FACEBOOK_HEADLESS`, `FACEBOOK_MIN_DELAY_MS`, `FACEBOOK_LOCALE`, `FACEBOOK_USER_AGENT`, `FACEBOOK_CACHE`, `FACEBOOK_CACHE_MAX_MB`.

### Changed

- Broadened scope from a Reddit-only MCP to an e-commerce customer-research MCP (server instructions, README, and CLAUDE.md updated). The npm package name (`reddit-mcp-server`) is unchanged.
- Added `cheerio` dependency for HTML parsing.

## [1.0.7] - 2025-06-27

### Fixed

- Fixed server crash issue caused by stdout pollution in bin.js
- Cleaned up published package to only include necessary files (reduced from 112KB to 24KB)

### Added

- Search Reddit functionality (`search_reddit` tool)
- Get post comments with threaded display (`get_post_comments` tool)
- Get user posts (`get_user_posts` tool)
- Get user comments (`get_user_comments` tool)
- Comprehensive test suite for all new functionality

### Changed

- Migrated from axios to native fetch API
- Improved error handling and removed console output that violated MCP protocol

## [1.0.6] - 2025-06-27

### Added

- New Reddit API endpoints (had packaging issues, use 1.0.7 instead)

## [1.0.5] - 2025-06-27

### Changed

- Migrated from axios to fetch for HTTP requests
- Fixed linting errors and improved code formatting

## [1.0.4] and earlier

- Previous versions with axios-based implementation

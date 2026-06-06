#!/usr/bin/env tsx
/**
 * One-command setup for non-technical users.
 *
 *   pnpm run setup                # auto-detect browser, grab your Facebook login, write .env
 *   pnpm run setup brave          # use a specific browser (chrome|brave|edge|arc|chromium|vivaldi|opera)
 *   pnpm run setup chrome "Profile 1"
 *
 * It never prints your cookie; it writes it to .env (which is git-ignored).
 */
import { execSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import {
  type BrowserKey,
  detectInstalledBrowsers,
  extractFacebookSession,
  extractRedditCookieHeader,
} from "../src/facebook/cookie-extractor"

const ENV_PATH = join(process.cwd(), ".env")

function log(msg = ""): void {
  // eslint-disable-next-line no-console
  console.log(msg)
}

function ensureChromium(): void {
  log("• Making sure the browser engine (Chromium) is installed…")
  try {
    execSync("npx playwright install chromium", { stdio: "ignore" })
    log("  ✓ Chromium ready")
  } catch {
    log("  ⚠ Could not auto-install Chromium. If scraping fails, run: npx playwright install chromium")
  }
}

function mergeEnv(updates: Record<string, string>): void {
  const lines = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8").split(/\r?\n/) : []
  const keys = new Set(Object.keys(updates))
  const kept = lines.filter((line) => {
    const m = line.match(/^([A-Z0-9_]+)=/)
    return m === null || !keys.has(m[1])
  })
  const added = Object.entries(updates).map(([k, v]) => `${k}=${v}`)
  const body = [...kept.filter((l) => l.trim() !== ""), ...added].join("\n") + "\n"
  writeFileSync(ENV_PATH, body, "utf8")
}

async function main(): Promise<void> {
  log("")
  log("🛍️  E-commerce Research MCP - Facebook setup")
  log("──────────────────────────────────────────────")
  log("This connects your Facebook login so the scraper can read groups you're in.")
  log("Make sure you're logged into Facebook in your normal browser first.")
  log("")

  const requested = process.argv[2] as BrowserKey | undefined
  const profile = process.argv[3] ?? "Default"

  const detected = detectInstalledBrowsers(profile)
  if (detected.length > 0) {
    log(`• Found browser(s): ${detected.map((d) => d.label).join(", ")}`)
  }

  const target: BrowserKey = requested ?? detected.find((d) => d.key === "chrome")?.key ?? detected[0]?.key ?? "chrome"
  log(`• Using: ${target}${profile !== "Default" ? ` (profile "${profile}")` : ""}`)
  log("")

  ensureChromium()
  log("")

  // Borrow reddit.com cookies too (bypasses Reddit's anonymous 403). Independent of Facebook.
  try {
    const redditCookie = await extractRedditCookieHeader({ browser: target, profile })
    if (redditCookie !== "") {
      mergeEnv({ REDDIT_COOKIE: redditCookie })
      log("• Reddit: ✓ connected (borrowed browser cookies - no Reddit account needed)")
    } else {
      log("• Reddit: works without setup on most networks (tip: visit reddit.com once in your browser)")
    }
  } catch {
    // Best-effort; Reddit still works anonymously on many networks.
  }
  log("")
  log(`• Reading your Facebook login from ${target}… (a hidden browser may flash briefly)`)

  try {
    const { session, cookieNames } = await extractFacebookSession({ browser: target, profile })
    mergeEnv({ FACEBOOK_COOKIE: session.cookieHeader, FACEBOOK_ENGINE: "browser" })
    log(`  ✓ Captured your Facebook session (${cookieNames.length} cookies) → saved to .env`)
    log("")
    log("✅ Done! The scraper is ready.")
    log("   Next: restart your MCP client (e.g. Claude Code), then try a tool like")
    log("   facebook_get_group_posts with a group URL you're a member of.")
    log("")
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`  ✗ ${msg}`)
    log("")
    log("What to do:")
    log("  1) Make sure you're logged into Facebook in that browser, then run setup again.")
    log("  2) Try another browser, e.g.  pnpm run setup brave")
    log("  3) Manual fallback: copy the whole Cookie header from a logged-in facebook.com")
    log("     browser tab (DevTools → Network → a facebook.com request → 'cookie') and put it in")
    log("     .env as:  FACEBOOK_COOKIE=...   and  FACEBOOK_ENGINE=browser")
    log("")
    process.exitCode = 1
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e)
  process.exit(1)
})

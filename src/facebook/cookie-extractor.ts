/* eslint-disable @typescript-eslint/no-explicit-any, functype/no-let, functype/no-imperative-loops, functype/prefer-option, functype/prefer-either, functype/prefer-fold --
 * External-IO boundary: reads the user's logged-in browser profile to recover their
 * Facebook session. Two strategies:
 *   1. Direct decryption (macOS/Linux): read the cookie SQLite DB + the OS keychain key
 *      + AES-128-CBC - deterministic, works while the browser is open.
 *   2. Playwright fallback (any OS, incl. Windows DPAPI/App-Bound): let the real browser
 *      binary decrypt its own cookies.
 * Inherently imperative effects; the caller wraps results at its boundary.
 */
import { execFileSync } from "node:child_process"
import crypto from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

import type { FacebookSession } from "./types"

export type BrowserKey = "chrome" | "brave" | "edge" | "arc" | "chromium" | "vivaldi" | "opera"

type BrowserSpec = {
  readonly label: string
  /** Playwright channel, when the browser is a recognized Chrome/Edge channel. */
  readonly channel?: string
  /** Candidate executable paths (used when there is no Playwright channel). */
  readonly executables: readonly string[]
  /** macOS Keychain "<X> Safe Storage" service name for direct decryption. */
  readonly keychainService: string
  /** Per-platform user-data-dir (the parent that contains the "Default" profile). */
  readonly userDataDir: () => string | undefined
}

const HOME = homedir()
const isMac = process.platform === "darwin"
const isWin = process.platform === "win32"
const APPDATA = process.env["LOCALAPPDATA"] ?? join(HOME, "AppData", "Local")

function macApp(...p: string[]): string {
  return join(HOME, "Library", "Application Support", ...p)
}

// Cross-platform user-data-dir resolver for a Chromium-family browser.
function dirFor(mac: string, win: string, linux: string): () => string | undefined {
  return () => {
    if (isMac) return macApp(...mac.split("/"))
    if (isWin) return join(APPDATA, ...win.split("/"))
    return join(HOME, ".config", ...linux.split("/"))
  }
}

export const BROWSER_REGISTRY: Readonly<Record<BrowserKey, BrowserSpec>> = {
  chrome: {
    label: "Google Chrome",
    channel: "chrome",
    keychainService: "Chrome Safe Storage",
    executables: [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "/usr/bin/google-chrome",
    ],
    userDataDir: dirFor("Google/Chrome", "Google/Chrome/User Data", "google-chrome"),
  },
  brave: {
    label: "Brave",
    keychainService: "Brave Safe Storage",
    executables: [
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe",
      "/usr/bin/brave-browser",
    ],
    userDataDir: dirFor(
      "BraveSoftware/Brave-Browser",
      "BraveSoftware/Brave-Browser/User Data",
      "BraveSoftware/Brave-Browser",
    ),
  },
  edge: {
    label: "Microsoft Edge",
    channel: "msedge",
    keychainService: "Microsoft Edge Safe Storage",
    executables: [
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      "/usr/bin/microsoft-edge",
    ],
    userDataDir: dirFor("Microsoft Edge", "Microsoft/Edge/User Data", "microsoft-edge"),
  },
  arc: {
    label: "Arc",
    keychainService: "Arc Safe Storage",
    executables: ["/Applications/Arc.app/Contents/MacOS/Arc"],
    userDataDir: dirFor("Arc/User Data", "Packages/TheBrowserCompany.Arc/User Data", "Arc/User Data"),
  },
  chromium: {
    label: "Chromium",
    channel: "chromium",
    keychainService: "Chromium Safe Storage",
    executables: [
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    ],
    userDataDir: dirFor("Chromium", "Chromium/User Data", "chromium"),
  },
  vivaldi: {
    label: "Vivaldi",
    keychainService: "Vivaldi Safe Storage",
    executables: ["/Applications/Vivaldi.app/Contents/MacOS/Vivaldi", "/usr/bin/vivaldi"],
    userDataDir: dirFor("Vivaldi", "Vivaldi/User Data", "vivaldi"),
  },
  opera: {
    label: "Opera",
    keychainService: "Opera Safe Storage",
    executables: ["/Applications/Opera.app/Contents/MacOS/Opera", "/usr/bin/opera"],
    userDataDir: dirFor("com.operasoftware.Opera", "Programs/Opera/User Data", "opera"),
  },
}

export type DetectedBrowser = { key: BrowserKey; label: string; userDataDir: string }

/** Locate a profile's cookie database (the newer Network/ or the flat location). */
export function cookieDbPath(base: string, profile = "Default"): string | undefined {
  const network = join(base, profile, "Network", "Cookies")
  const flat = join(base, profile, "Cookies")
  if (existsSync(network)) return network
  if (existsSync(flat)) return flat
  return undefined
}

/** True if a profile has a cookie database we can read. */
export function hasCookieDb(base: string, profile = "Default"): boolean {
  return cookieDbPath(base, profile) !== undefined
}

/**
 * Return the browsers that look usable on this machine: a user-data-dir exists AND it
 * has a cookie database for the given profile (so we don't list dormant dirs).
 */
export function detectInstalledBrowsers(profile = "Default"): readonly DetectedBrowser[] {
  const out: DetectedBrowser[] = []
  for (const key of Object.keys(BROWSER_REGISTRY) as BrowserKey[]) {
    const spec = BROWSER_REGISTRY[key]
    const dir = spec.userDataDir()
    if (dir !== undefined && existsSync(dir) && hasCookieDb(dir, profile)) {
      out.push({ key, label: spec.label, userDataDir: dir })
    }
  }
  return out
}

export type ExtractResult = {
  readonly session: FacebookSession
  /** Names of facebook.com cookies found (values are never logged). */
  readonly cookieNames: readonly string[]
}

function buildResult(byName: Map<string, string>, label: string, profile: string): ExtractResult {
  const cUser = byName.get("c_user")
  const xs = byName.get("xs")
  if (cUser === undefined || cUser === "" || xs === undefined || xs === "") {
    throw new Error(
      `No Facebook login found in ${label} (profile "${profile}"). Log in to facebook.com in that browser first.`,
    )
  }
  const cookieHeader = Array.from(byName.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join("; ")
  return { session: { cookieHeader, cUser, xs, datr: byName.get("datr") }, cookieNames: Array.from(byName.keys()) }
}

// ───────────────────────── Strategy 1: direct decryption ─────────────────────────

/** Copy the cookie DB (and its WAL sidecars) to a temp file so we can read it while the browser runs. */
function copyCookieDb(dbPath: string): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "fbck-"))
  const file = join(dir, "Cookies")
  copyFileSync(dbPath, file)
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(dbPath + suffix)) {
      try {
        copyFileSync(dbPath + suffix, file + suffix)
      } catch {
        /* sidecar optional */
      }
    }
  }
  return { dir, file }
}

/** AES-128-CBC decrypt a Chromium "v10" cookie blob using the derived key. */
function decryptValue(buf: Buffer, key: Buffer, hostKey: string): string {
  if (buf.length === 0) return ""
  const prefix = buf.subarray(0, 3).toString("latin1")
  const payload = prefix === "v10" || prefix === "v11" ? buf.subarray(3) : buf
  if (payload.length === 0 || payload.length % 16 !== 0) {
    return ""
  }
  const iv = Buffer.alloc(16, 0x20)
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv)
  decipher.setAutoPadding(false)
  let out = Buffer.concat([decipher.update(payload), decipher.final()])
  const pad = out[out.length - 1]
  if (pad > 0 && pad <= 16 && pad <= out.length) {
    out = out.subarray(0, out.length - pad)
  }
  // Newer Chrome prepends a 32-byte SHA-256(host_key) hash before the value - strip it.
  if (out.length >= 32) {
    const hostHash = crypto.createHash("sha256").update(hostKey).digest()
    if (out.subarray(0, 32).equals(hostHash)) {
      out = out.subarray(32)
    }
  }
  return out.toString("utf8")
}

/** macOS/Linux: read + decrypt the cookie DB directly. May trigger a one-time keychain prompt. */
function extractViaDecryption(spec: BrowserSpec, base: string, profile: string): ExtractResult {
  const dbPath = cookieDbPath(base, profile)
  if (dbPath === undefined) {
    throw new Error(`No cookie database found for ${spec.label} profile "${profile}".`)
  }

  // Derive the AES key from the OS keychain "Safe Storage" password.
  let password: string
  if (isMac) {
    password = execFileSync("security", ["find-generic-password", "-w", "-s", spec.keychainService], {
      encoding: "utf8",
    }).trim()
  } else {
    // Linux: many distros use the well-known fallback password when no wallet is configured.
    password = "peanuts"
  }
  const key = crypto.pbkdf2Sync(password, "saltysalt", isMac ? 1003 : 1, 16, "sha1")

  const { dir, file } = copyCookieDb(dbPath)
  try {
    // Use a multi-char delimiter (cookie names never contain it) since SQLite does not
    // interpret backslash escapes. quote(blob) yields X'AABB…'.
    const SEP = "|::|"
    const sql = `SELECT host_key || '${SEP}' || name || '${SEP}' || quote(encrypted_value) FROM cookies WHERE host_key LIKE '%facebook.com'`
    const raw = execFileSync("sqlite3", [file, sql], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
    const byName = new Map<string, string>()
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue
      const parts = line.split(SEP)
      if (parts.length < 3) continue
      const hostKey = parts[0]
      const name = parts[1]
      const quoted = parts.slice(2).join(SEP)
      const hex = quoted.startsWith("X'") ? quoted.slice(2, -1) : ""
      const value = hex.length > 0 ? decryptValue(Buffer.from(hex, "hex"), key, hostKey) : ""
      // Skip any value that still contains control chars (failed decode) to keep .env clean.
      const hasControlChars = [...value].some((ch) => ch.charCodeAt(0) < 32)
      if (name !== undefined && name !== "" && !hasControlChars) {
        byName.set(name, value)
      }
    }
    return buildResult(byName, spec.label, profile)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ───────────────────────── Strategy 2: Playwright fallback ─────────────────────────

function firstExisting(paths: readonly string[]): string | undefined {
  for (const p of paths) {
    if (existsSync(p)) return p
  }
  return undefined
}

async function loadChromium(): Promise<any> {
  const specifier = "playwright"
  const mod: any = await import(specifier)
  return mod.chromium ?? mod.default?.chromium
}

/** Stage a throwaway user-data-dir with the cookie DB copied into both known locations. */
function stageProfile(base: string, profile: string): string {
  const dbPath = cookieDbPath(base, profile)
  if (dbPath === undefined) {
    throw new Error(`No cookie database found for profile "${profile}" in ${base}.`)
  }
  const tmp = mkdtempSync(join(tmpdir(), "fbprofile-"))
  const profileDir = join(tmp, profile)
  mkdirSync(join(profileDir, "Network"), { recursive: true })
  // Copy into both the flat and Network/ locations so any Chrome version finds it.
  copyFileSync(dbPath, join(profileDir, "Cookies"))
  copyFileSync(dbPath, join(profileDir, "Network", "Cookies"))
  const localState = join(base, "Local State")
  if (existsSync(localState)) {
    try {
      copyFileSync(localState, join(tmp, "Local State"))
    } catch {
      /* unreadable Local State is non-fatal on macOS/Linux */
    }
  }
  return tmp
}

async function extractViaPlaywright(spec: BrowserSpec, base: string, profile: string): Promise<ExtractResult> {
  let chromium: any
  try {
    chromium = await loadChromium()
  } catch {
    throw new Error(
      "Reading browser cookies needs the optional 'playwright' package. Install it with " +
        "`npm install playwright && npx playwright install chromium`.",
    )
  }
  if (chromium === undefined) {
    throw new Error("Playwright is installed but no browser build was found. Run `npx playwright install chromium`.")
  }

  const executablePath = spec.channel === undefined ? firstExisting(spec.executables) : undefined
  if (spec.channel === undefined && executablePath === undefined) {
    throw new Error(`Could not find the ${spec.label} executable to read its cookies.`)
  }

  const staged = stageProfile(base, profile)
  let context: any
  try {
    context = await chromium.launchPersistentContext(staged, {
      headless: true,
      channel: spec.channel,
      executablePath,
      args: [`--profile-directory=${profile}`],
    })
    const cookies: any[] = await context.cookies([
      "https://www.facebook.com",
      "https://facebook.com",
      "https://m.facebook.com",
    ])
    const byName = new Map<string, string>()
    for (const c of cookies) {
      if (typeof c.domain === "string" && c.domain.includes("facebook.com")) {
        byName.set(c.name, c.value)
      }
    }
    return buildResult(byName, spec.label, profile)
  } finally {
    if (context !== undefined) {
      await context.close().catch(() => undefined)
    }
    rmSync(staged, { recursive: true, force: true })
  }
}

/**
 * Extract the Facebook session from a locally-installed, logged-in browser. Tries direct
 * decryption first (deterministic on macOS/Linux), then falls back to the Playwright
 * approach (works on Windows and when direct decryption isn't available).
 */
export async function extractFacebookSession(
  opts: { readonly browser?: BrowserKey; readonly profile?: string } = {},
): Promise<ExtractResult> {
  const browserKey = opts.browser ?? "chrome"
  const profile = opts.profile ?? "Default"
  const spec = BROWSER_REGISTRY[browserKey]
  if (spec === undefined) {
    throw new Error(`Unknown browser "${browserKey}". Supported: ${Object.keys(BROWSER_REGISTRY).join(", ")}.`)
  }
  const base = spec.userDataDir()
  if (base === undefined || !existsSync(base)) {
    throw new Error(`${spec.label} does not appear to be installed (no profile dir found).`)
  }

  // Strategy 1: direct decryption (mac/linux).
  if (!isWin) {
    try {
      return extractViaDecryption(spec, base, profile)
    } catch (err) {
      // Fall through to Playwright unless it's a clear "not logged in" signal.
      if (err instanceof Error && /No Facebook login found/.test(err.message)) {
        throw err
      }
    }
  }

  // Strategy 2: Playwright (any OS).
  return extractViaPlaywright(spec, base, profile)
}

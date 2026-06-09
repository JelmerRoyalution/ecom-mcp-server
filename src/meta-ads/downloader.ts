/* eslint-disable functype/no-let, functype/no-imperative-loops, functype/prefer-either --
 * Filesystem boundary: downloads ad creative files (images/videos) from Facebook's CDN to disk.
 * Inherently imperative (fetch + fs writes in a bounded loop); the MetaAdsClient wraps the result
 * into Either at the method boundary.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { type TranscribeTools, transcribeVideoFile } from "./transcribe"
import type { MetaAd, MetaCreativeKind, MetaDownloadManifest, MetaDownloadWhat, MetaSavedCreative } from "./types"

/** A per-video doc combining the ad's written copy with its transcribed video script. */
function combinedScriptDoc(ad: MetaAd, transcript: string): string {
  const c = ad.creative
  return [
    `# ${ad.pageName} — ${c.title ?? "(no headline)"}`,
    "",
    `- Ad Library: ${ad.snapshotUrl}`,
    `- ${ad.isActive ? "Active" : "Inactive"}${ad.daysRunning !== undefined ? ` · running ${ad.daysRunning} days` : ""}${ad.displayFormat !== undefined ? ` · ${ad.displayFormat}` : ""}`,
    `- CTA: ${c.ctaText ?? "—"}${c.linkUrl !== undefined ? ` → ${c.linkUrl}` : ""}`,
    "",
    "## Ad copy (primary text)",
    "",
    c.body !== undefined && c.body.length > 0 ? c.body : "_(no primary text on this ad)_",
    "",
    "## Video script (transcribed)",
    "",
    transcript,
    "",
  ].join("\n")
}

/** Filesystem-safe slug for a page/advertiser name. */
export function slugify(name: string): string {
  const s = name
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60)
  return s.length > 0 ? s : "advertiser"
}

/**
 * Determine a file extension from the bytes (magic numbers) first, falling back to the declared
 * content-type. Facebook's CDN frequently mislabels images (e.g. serves a PNG as image/jpeg), so
 * the bytes are the source of truth.
 */
export function sniffExt(buf: Buffer, contentType: string): string {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png"
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg"
  if (buf.length >= 3 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "gif"
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP")
    return "webp"
  if (buf.length >= 12 && buf.toString("ascii", 4, 8) === "ftyp") return "mp4"

  if (contentType.includes("png")) return "png"
  if (contentType.includes("webp")) return "webp"
  if (contentType.includes("gif")) return "gif"
  if (contentType.includes("mp4") || contentType.includes("video")) return "mp4"
  return "jpg"
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Collect the (url, kind) download targets for one ad, honoring the `what` filter. */
function targetsFor(ad: MetaAd, what: MetaDownloadWhat): { url: string; kind: MetaCreativeKind }[] {
  const out: { url: string; kind: MetaCreativeKind }[] = []
  if (what === "images" || what === "all") {
    for (const url of ad.creative.imageUrls) out.push({ url, kind: "image" })
  }
  if (what === "videos" || what === "all") {
    for (const url of ad.creative.videoUrls) out.push({ url, kind: "video" })
  }
  return out
}

/**
 * Download ad creatives to `opts.dir`. Bounded by `maxFiles`, paced by `minDelayMs`, de-duplicated
 * by URL. Failures are counted, not thrown, so one bad CDN link never aborts the batch.
 */
export async function downloadCreatives(
  ads: readonly MetaAd[],
  opts: {
    readonly advertiser: string
    readonly dir: string
    readonly what: MetaDownloadWhat
    readonly maxFiles: number
    readonly userAgent: string
    readonly minDelayMs: number
    /** When set, downloaded videos are transcribed to a `.txt` + a combined `.script.md`. */
    readonly transcribe?: { readonly tools: TranscribeTools; readonly threads?: number; readonly fast?: boolean }
  },
): Promise<MetaDownloadManifest> {
  mkdirSync(opts.dir, { recursive: true })

  const saved: MetaSavedCreative[] = []
  const seenUrls = new Set<string>()
  let failed = 0
  let totalBytes = 0
  let transcribed = 0
  let lastRequest = 0

  for (const ad of ads) {
    if (saved.length >= opts.maxFiles) break
    const targets = targetsFor(ad, opts.what)
    let index = 0
    for (const target of targets) {
      if (saved.length >= opts.maxFiles) break
      if (seenUrls.has(target.url)) {
        index += 1
        continue
      }
      seenUrls.add(target.url)

      const elapsed = Date.now() - lastRequest
      if (lastRequest > 0 && elapsed < opts.minDelayMs) {
        await sleep(opts.minDelayMs - elapsed)
      }
      lastRequest = Date.now()

      try {
        const response = await fetch(target.url, {
          headers: {
            "User-Agent": opts.userAgent,
            Accept: target.kind === "video" ? "video/*,*/*" : "image/avif,image/webp,image/*,*/*",
          },
        })
        if (!response.ok) {
          failed += 1
          index += 1
          continue
        }
        const buf = Buffer.from(await response.arrayBuffer())
        const ext = sniffExt(buf, response.headers.get("content-type") ?? "")
        const suffix = targets.length > 1 ? `_${index}` : ""
        const name = `${slugify(ad.pageName)}_${ad.adArchiveId}${suffix}.${ext}`
        const file = join(opts.dir, name)
        writeFileSync(file, buf)

        let transcriptFile: string | undefined
        let transcriptChars: number | undefined
        if (target.kind === "video" && opts.transcribe !== undefined) {
          try {
            const text = transcribeVideoFile(file, opts.transcribe.tools, {
              threads: opts.transcribe.threads,
              fast: opts.transcribe.fast,
            })
            if (text !== "") {
              transcriptFile = file.replace(/\.[^.]+$/, ".txt")
              transcriptChars = text.length
              transcribed += 1
              writeFileSync(file.replace(/\.[^.]+$/, ".script.md"), combinedScriptDoc(ad, text), "utf8")
            }
          } catch {
            // Transcription failed - keep the video, skip the transcript.
          }
        }

        saved.push({
          adArchiveId: ad.adArchiveId,
          pageName: ad.pageName,
          kind: target.kind,
          file,
          bytes: buf.length,
          daysRunning: ad.daysRunning,
          snapshotUrl: ad.snapshotUrl,
          transcriptFile,
          transcriptChars,
        })
        totalBytes += buf.length
      } catch {
        failed += 1
      }
      index += 1
    }
  }

  return { advertiser: opts.advertiser, dir: opts.dir, saved, failed, totalBytes, transcribed }
}

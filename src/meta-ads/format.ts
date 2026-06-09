import type { MetaAd, MetaAdBrand, MetaAdvertiserAds, MetaDownloadManifest } from "./types"

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\n{3,}/g, "\n\n").trim()
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean
}

/** Lead line for an ad - the winning-ad signals up front (status · longevity · scaling). */
function signalLine(ad: MetaAd): string {
  return [
    ad.isActive ? "🟢 Active" : "⚪ Inactive",
    ad.daysRunning !== undefined ? `running ${ad.daysRunning} day${ad.daysRunning === 1 ? "" : "s"}` : "",
    ad.collationCount !== undefined && ad.collationCount > 1 ? `${ad.collationCount} variants` : "",
    ad.displayFormat ?? "",
  ]
    .filter((s) => s.length > 0)
    .join(" · ")
}

function mediaLine(ad: MetaAd): string {
  const images = ad.creative.imageUrls.length
  const videos = ad.creative.videoUrls.length
  const parts = [
    images > 0 ? `${images} image${images === 1 ? "" : "s"}` : "",
    videos > 0 ? `${videos} video${videos === 1 ? "" : "s"}` : "",
  ].filter((s) => s.length > 0)
  return parts.length > 0 ? parts.join(" · ") : "no media parsed"
}

/** Render a single ad as Markdown. */
export function formatAd(ad: MetaAd, index: number): string {
  const c = ad.creative
  const heading = c.title !== undefined && c.title.length > 0 ? c.title : "(no headline)"
  const platforms = ad.publisherPlatforms.length > 0 ? ad.publisherPlatforms.join(", ") : "—"
  const cta =
    c.ctaText !== undefined ? `${c.ctaText}${c.linkUrl !== undefined ? ` → ${c.linkUrl}` : ""}` : (c.linkUrl ?? "—")
  const lines = [
    `### ${index + 1}. ${ad.pageName} — ${heading}`,
    signalLine(ad),
    `Platforms: ${platforms}${ad.startDate !== undefined ? ` · started ${ad.startDate}` : ""}${c.caption !== undefined ? ` · ${c.caption}` : ""}`,
    "",
    c.body !== undefined ? truncate(c.body, 700) : "_(no primary text)_",
    "",
    `CTA: ${cta}`,
    `Media: ${mediaLine(ad)}`,
    `Library ID: \`${ad.adArchiveId}\` · ${ad.snapshotUrl}`,
  ]
  return lines.join("\n")
}

/** Render an advertiser's ads as Markdown. */
export function formatAdvertiserAds(result: MetaAdvertiserAds): string {
  const title = result.pageName ?? result.advertiser
  if (result.ads.length === 0) {
    return `# Meta Ads: ${title}

No ads parsed for this advertiser. They may have no ads matching your filters running right now, or Meta gated/blocked the request. Try active_status=all, widen media_type, or set META_ADS_ENGINE=browser (Playwright) / META_ADS_API_KEY.`
  }
  const active = result.ads.filter((a) => a.isActive).length
  const body = result.ads.map((ad, i) => formatAd(ad, i)).join("\n\n---\n\n")
  return `# Meta Ads: ${title}

_${result.ads.length} ad(s) · ${active} active${result.pageId !== undefined ? ` · page ${result.pageId}` : ""}${result.hasMore ? " · more available (raise limit)" : ""}. Sorted with longest-running (likely winners) first._

${body}`
}

/** Render discovered brands/advertisers as Markdown. */
export function formatBrands(query: string, brands: readonly MetaAdBrand[]): string {
  if (brands.length === 0) {
    return `# Meta Ad Library brands: "${query}"

No advertisers found. For best results pass a brand's bare domain (e.g. \`vitalityextracts.com\`) — a unique domain surfaces the whole connected page network. Generic words are noisy. Or set META_ADS_ENGINE=browser (Playwright) for reliable results.`
  }
  const body = brands
    .map((b, i) => {
      const meta = [
        `${b.adCountSeen} ad${b.adCountSeen === 1 ? "" : "s"} seen`,
        b.pageLikeCount !== undefined ? `${b.pageLikeCount.toLocaleString()} likes` : "",
        b.pageCategories !== undefined && b.pageCategories.length > 0 ? b.pageCategories.join(", ") : "",
      ]
        .filter((s) => s.length > 0)
        .join(" · ")
      const sample = b.sampleAdCopy !== undefined ? `\n  > ${truncate(b.sampleAdCopy, 160)}` : ""
      return `### ${i + 1}. ${b.pageName}\n- ${meta}\n- Page ID: \`${b.pageId}\`\n- All ads: ${b.snapshotUrl}${sample}`
    })
    .join("\n\n")
  return `# Meta Ad Library brands: "${query}"

_${brands.length} advertiser(s) found — feed one into meta_ads_get_advertiser_ads (page id or the "All ads" URL):_

${body}`
}

/** Render a creative-download result as Markdown. */
export function formatDownloadManifest(result: MetaDownloadManifest): string {
  if (result.saved.length === 0) {
    return `# Downloaded creatives: ${result.advertiser}

No creatives saved (${result.failed} fetch failure(s)). The CDN links may have expired - re-run, or try downloading videos too.`
  }
  const images = result.saved.filter((s) => s.kind === "image").length
  const videos = result.saved.filter((s) => s.kind === "video").length
  const body = result.saved
    .map((s, i) => {
      const meta = [s.kind, s.daysRunning !== undefined ? `${s.daysRunning}d` : "", mb(s.bytes)]
        .filter((x) => x.length > 0)
        .join(" · ")
      const transcript =
        s.transcriptFile !== undefined
          ? `\n   📝 script (${s.transcriptChars ?? 0} chars): \`${s.transcriptFile}\` · combined copy+script: \`${s.transcriptFile.replace(/\.txt$/, ".script.md")}\``
          : ""
      return `${i + 1}. \`${s.file}\` — ${s.pageName} (${meta}) · ${s.snapshotUrl}${transcript}`
    })
    .join("\n")
  const transcribedNote =
    result.transcribed !== undefined && result.transcribed > 0 ? ` · ${result.transcribed} transcribed` : ""
  const guidance = result.note !== undefined ? `\n\n> ${result.note}` : ""
  return `# Downloaded creatives: ${result.advertiser}

_Saved **${result.saved.length}** file(s) (${images} image, ${videos} video) · ${mb(result.totalBytes)} total${result.failed > 0 ? ` · ${result.failed} failed` : ""}${transcribedNote} → \`${result.dir}/\`_${guidance}

${body}`
}

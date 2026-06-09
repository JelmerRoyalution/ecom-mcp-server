/* eslint-disable functype/prefer-either, functype/prefer-option --
 * External-IO boundary for transcribing ad VIDEOS to text via a LOCAL whisper.cpp + ffmpeg pipeline
 * (no API key, runs offline). Meta serves direct .mp4 URLs, so this is just: mp4 → 16kHz mono PCM
 * wav (ffmpeg) → whisper-cli .txt. Inherently imperative (child_process + fs); the caller wraps
 * failures so a missing toolchain or one bad video never aborts a download batch.
 */
import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** Resolved local transcription toolchain. */
export type TranscribeTools = {
  readonly ffmpeg: string
  readonly whisper: string
  readonly model: string
}

/** Either a ready toolchain, or actionable guidance on what's missing. */
export type TranscribeReadiness =
  | { readonly ready: true; readonly tools: TranscribeTools }
  | { readonly ready: false; readonly guidance: string }

const HOME = homedir()
const MODELS_DIR = join(HOME, ".whisper-models")

/**
 * Pick the default whisper.cpp model. Prefers `small.en` - the speed/quality sweet spot that's
 * "good enough" for ad scripts - then falls back to medium > base > tiny. Override with
 * META_ADS_WHISPER_MODEL.
 */
export function preferredModel(files: readonly string[]): string | undefined {
  const rank = (f: string): number => {
    if (/small/.test(f)) return 4
    if (/medium/.test(f)) return 3
    if (/base/.test(f)) return 2
    if (/tiny/.test(f)) return 1
    return 0
  }
  const candidates = files.filter((f) => /^ggml-.*\.bin$/.test(f)).sort((a, b) => rank(b) - rank(a))
  return candidates[0]
}

/** ffmpeg args to strip a video to the 16kHz mono PCM wav whisper expects. */
export function ffmpegArgs(input: string, wav: string): string[] {
  return ["-i", input, "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav, "-y", "-loglevel", "error"]
}

/** whisper-cli args. `fast` uses greedy decoding (3-5x faster) for CPU-only machines. */
export function whisperArgs(
  model: string,
  wav: string,
  outBase: string,
  opts: { readonly threads: number; readonly fast: boolean },
): string[] {
  const base = ["-m", model, "-f", wav, "-t", String(opts.threads), "-otxt", "-of", outBase, "--no-timestamps"]
  return opts.fast ? [...base, "-bs", "1", "-bo", "1"] : base
}

function firstExisting(paths: readonly string[]): string | undefined {
  return paths.find((p) => existsSync(p))
}

function onPath(bin: string): string | undefined {
  try {
    const p = execFileSync("/usr/bin/which", [bin], { encoding: "utf8" }).trim()
    return p !== "" ? p : undefined
  } catch {
    return undefined
  }
}

/** Locate ffmpeg, preferring the native Homebrew build. */
function findFfmpeg(): string | undefined {
  return firstExisting(["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"]) ?? onPath("ffmpeg")
}

/**
 * Locate whisper.cpp's CLI. Prefers /opt/homebrew (native arm64 + Metal) over the PATH default,
 * which on Apple Silicon is often the slow Rosetta build (lesson from the Whop pipeline).
 */
function findWhisper(): string | undefined {
  return (
    firstExisting(["/opt/homebrew/bin/whisper-cli", "/opt/homebrew/bin/whisper-cpp"]) ??
    onPath("whisper-cli") ??
    onPath("whisper-cpp")
  )
}

/** Find a whisper model: explicit override, else the best in ~/.whisper-models. */
function findModel(): string | undefined {
  const override = process.env.META_ADS_WHISPER_MODEL
  if (override !== undefined && override.trim() !== "" && existsSync(override.trim())) {
    return override.trim()
  }
  if (!existsSync(MODELS_DIR)) return undefined
  try {
    const best = preferredModel(readdirSync(MODELS_DIR))
    return best !== undefined ? join(MODELS_DIR, best) : undefined
  } catch {
    return undefined
  }
}

/** Detect whether local transcription is possible, with guidance when it isn't. */
export function detectTranscribeTools(): TranscribeReadiness {
  const ffmpeg = findFfmpeg()
  const whisper = findWhisper()
  const model = findModel()
  if (ffmpeg !== undefined && whisper !== undefined && model !== undefined) {
    return { ready: true, tools: { ffmpeg, whisper, model } }
  }
  const missing: string[] = []
  if (ffmpeg === undefined) missing.push("ffmpeg (`brew install ffmpeg`)")
  if (whisper === undefined) missing.push("whisper.cpp (`brew install whisper-cpp`)")
  if (model === undefined) {
    missing.push(
      "a model (`mkdir -p ~/.whisper-models && curl -L -o ~/.whisper-models/ggml-base.en.bin " +
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin`), or set META_ADS_WHISPER_MODEL",
    )
  }
  return { ready: false, guidance: `Video transcription skipped - missing: ${missing.join("; ")}.` }
}

/**
 * Transcribe a downloaded video file to text using the local toolchain. Writes `<base>.txt` next to
 * the video (whisper's own output), returns the transcript. Idempotent: reuses an existing `.txt`.
 * Throws on failure; callers treat that as "video kept, no transcript".
 */
export function transcribeVideoFile(
  videoPath: string,
  tools: TranscribeTools,
  opts: { readonly threads?: number; readonly fast?: boolean; readonly timeoutMs?: number } = {},
): string {
  const outBase = videoPath.replace(/\.[^.]+$/, "")
  const txt = `${outBase}.txt`
  if (existsSync(txt)) {
    return readFileSync(txt, "utf8").trim()
  }

  const wav = `${outBase}.wav`
  const timeout = opts.timeoutMs ?? 600_000
  try {
    execFileSync(tools.ffmpeg, ffmpegArgs(videoPath, wav), { stdio: "ignore", timeout })
    execFileSync(
      tools.whisper,
      whisperArgs(tools.model, wav, outBase, { threads: opts.threads ?? 8, fast: opts.fast ?? false }),
      {
        stdio: "ignore",
        timeout,
      },
    )
    return existsSync(txt) ? readFileSync(txt, "utf8").trim() : ""
  } finally {
    rmSync(wav, { force: true })
  }
}

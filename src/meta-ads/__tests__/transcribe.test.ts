import { describe, expect, it } from "vitest"

import { ffmpegArgs, preferredModel, whisperArgs } from "../transcribe"

describe("meta-ads transcribe helpers", () => {
  describe("preferredModel", () => {
    it("prefers small.en (the default) over medium, then medium > base > tiny", () => {
      // small is the default sweet spot - wins even over the higher-quality medium
      expect(preferredModel(["ggml-medium.en.bin", "ggml-small.en.bin"])).toBe("ggml-small.en.bin")
      expect(preferredModel(["ggml-base.en.bin", "ggml-medium.en.bin", "ggml-tiny.en.bin"])).toBe("ggml-medium.en.bin")
      expect(preferredModel(["ggml-base.en.bin", "ggml-tiny.en.bin"])).toBe("ggml-base.en.bin")
      expect(preferredModel(["README.md", "ggml-tiny.en.bin"])).toBe("ggml-tiny.en.bin")
      expect(preferredModel(["notes.txt", "model.pt"])).toBeUndefined()
      expect(preferredModel([])).toBeUndefined()
    })
  })

  describe("ffmpegArgs", () => {
    it("produces 16kHz mono PCM extraction args", () => {
      expect(ffmpegArgs("a.mp4", "a.wav")).toEqual([
        "-i",
        "a.mp4",
        "-vn",
        "-ar",
        "16000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        "a.wav",
        "-y",
        "-loglevel",
        "error",
      ])
    })
  })

  describe("whisperArgs", () => {
    it("builds standard args with -otxt and --no-timestamps", () => {
      const args = whisperArgs("/m/ggml-base.en.bin", "a.wav", "a", { threads: 8, fast: false })
      expect(args).toEqual([
        "-m",
        "/m/ggml-base.en.bin",
        "-f",
        "a.wav",
        "-t",
        "8",
        "-otxt",
        "-of",
        "a",
        "--no-timestamps",
      ])
    })

    it("adds greedy decoding flags in fast mode", () => {
      const args = whisperArgs("/m/x.bin", "a.wav", "a", { threads: 4, fast: true })
      expect(args.slice(-4)).toEqual(["-bs", "1", "-bo", "1"])
    })
  })
})

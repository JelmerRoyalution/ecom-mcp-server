import { describe, expect, it } from "vitest"

import {
  buildPersonaBrief,
  classifyComment,
  inferAwarenessDistribution,
  inferSophistication,
  isValuableComment,
  mineVoiceOfCustomer,
  splitSentences,
} from "../schwartz"

const CORPUS = [
  "I hate how dry my skin is, nothing works and I'm so frustrated.",
  "I really want to find a moisturizer that actually works for sensitive skin.",
  "Where can I buy the best vitamin C serum? Looking for a good deal.",
  "I already tried CeraVe but it didn't work, total waste of money.",
  "My dream is glowing skin without spending a fortune.",
]

describe("schwartz persona engine", () => {
  describe("splitSentences", () => {
    it("splits on sentence punctuation and newlines", () => {
      const sentences = splitSentences("One thing. Another thing!\nA third?")
      expect(sentences.length).toBeGreaterThanOrEqual(3)
    })
  })

  describe("mineVoiceOfCustomer", () => {
    const voc = mineVoiceOfCustomer(CORPUS)

    it("captures pains", () => {
      expect(voc.pains.length).toBeGreaterThan(0)
      expect(voc.pains.join(" ")).toMatch(/dry|waste|frustrated/i)
    })

    it("captures desires", () => {
      expect(voc.desires.length).toBeGreaterThan(0)
      expect(voc.desires.join(" ")).toMatch(/want|looking for|dream/i)
    })

    it("captures objections", () => {
      expect(voc.objections.join(" ")).toMatch(/waste of money|didn't work|already tried/i)
    })

    it("captures questions", () => {
      expect(voc.questions.some((q) => q.endsWith("?"))).toBe(true)
    })

    it("captures verbatim first-person quotes", () => {
      expect(voc.quotes.length).toBeGreaterThan(0)
    })
  })

  describe("inferAwarenessDistribution", () => {
    it("returns weights summing to ~100 with a dominant stage", () => {
      const voc = mineVoiceOfCustomer(CORPUS)
      const dist = inferAwarenessDistribution(CORPUS, voc)
      const total = Object.values(dist.weights).reduce((a, b) => a + b, 0)
      expect(total).toBeGreaterThanOrEqual(98)
      expect(total).toBeLessThanOrEqual(102)
      expect(Object.keys(dist.weights)).toContain(dist.dominant)
    })
  })

  describe("inferSophistication", () => {
    it("flags a jaded market as level 5", () => {
      const jaded = ["I tried everything and nothing works, it's all snake oil and gimmicks."]
      const voc = mineVoiceOfCustomer(jaded)
      const assessment = inferSophistication(jaded, voc)
      expect(assessment.level).toBe(5)
      expect(assessment.rationale.length).toBeGreaterThan(10)
    })

    it("rates a fresh market low", () => {
      const fresh = ["This is a brand new idea I never heard of before."]
      const voc = mineVoiceOfCustomer(fresh)
      const assessment = inferSophistication(fresh, voc)
      expect(assessment.level).toBeLessThanOrEqual(2)
    })
  })

  describe("buildPersonaBrief", () => {
    it("produces a markdown brief with all Schwartz sections", () => {
      const brief = buildPersonaBrief({ texts: CORPUS, productContext: "skincare serum" })
      expect(brief).toContain("# Customer Persona Brief")
      expect(brief).toContain("Mass Desire")
      expect(brief).toContain("Core Pains")
      expect(brief).toContain("State of Awareness")
      expect(brief).toContain("Market Sophistication")
      expect(brief).toContain("skincare serum")
      // Should surface real evidence, not just the template.
      expect(brief.toLowerCase()).toMatch(/dry|waste|moisturizer/)
    })

    it("handles an empty corpus without throwing", () => {
      const brief = buildPersonaBrief({ texts: [] })
      expect(brief).toContain("# Customer Persona Brief")
    })
  })

  describe("isValuableComment", () => {
    it("keeps substantive comments", () => {
      expect(isValuableComment("I tried three moisturizers and none of them stopped the dryness.")).toBe(true)
    })

    it("drops short low-signal reactions", () => {
      expect(isValuableComment("Following")).toBe(false)
      expect(isValuableComment("thanks so much")).toBe(false)
      expect(isValuableComment("same here")).toBe(false)
      expect(isValuableComment("👏👏👏")).toBe(false)
      expect(isValuableComment("@Jane Doe")).toBe(false)
    })

    it("respects the minimum word count", () => {
      expect(isValuableComment("dry skin is annoying", 6)).toBe(false)
    })
  })

  describe("classifyComment", () => {
    it("tags by dominant voice-of-customer cue", () => {
      expect(classifyComment("I already tried CeraVe and it was a total waste of money")).toBe("objection")
      expect(classifyComment("My skin is so dry and flaky, I hate it")).toBe("pain")
      expect(classifyComment("I really want to find a serum that actually works")).toBe("desire")
      expect(classifyComment("Where can you buy this brand?")).toBe("question")
      expect(classifyComment("The weather is nice today")).toBe("other")
    })
  })
})

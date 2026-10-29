import { describe, expect, it } from "vitest"

import {
  buildQuestionUrl,
  buildSearchUrl,
  buildTopicUrl,
  extractSlug,
  localizeQuoraUrl,
  looksLoginGated,
  parseQuestionCards,
  parseQuestionPage,
  quoraHostForCookie,
  stripHtml,
} from "../parsers"
import {
  gatedQuestionHtml,
  jsonLdQuestionHtml,
  notFoundQuestionHtml,
  questionPageHtml,
  searchPageHtml,
} from "./fixtures"

describe("quora parsers", () => {
  describe("extractSlug", () => {
    it("pulls the slug from a full question URL", () => {
      expect(extractSlug("https://www.quora.com/What-is-the-best-magnesium-supplement-for-sleep")).toBe(
        "What-is-the-best-magnesium-supplement-for-sleep",
      )
    })

    it("keeps the question slug from an /answer/ permalink", () => {
      expect(extractSlug("https://www.quora.com/What-is-X/answer/Some-Person")).toBe("What-is-X")
    })

    it("accepts a bare slug and rejects reserved routes", () => {
      expect(extractSlug("What-is-X")).toBe("What-is-X")
      expect(extractSlug("https://www.quora.com/topic/Magnesium")).toBeUndefined()
      expect(extractSlug("")).toBeUndefined()
    })
  })

  describe("url builders", () => {
    it("builds question, search and topic URLs", () => {
      expect(buildQuestionUrl("What-is-X")).toBe("https://www.quora.com/What-is-X")
      expect(buildSearchUrl("magnesium sleep")).toBe("https://www.quora.com/search?q=magnesium%20sleep&type=question")
      expect(buildTopicUrl("Magnesium")).toBe("https://www.quora.com/topic/Magnesium")
      expect(buildTopicUrl("q/health-nuts")).toBe("https://www.quora.com/q/health-nuts")
    })
  })

  describe("language-subdomain handling", () => {
    it("derives the account language host from the m-ql10n cookie (English stays on www)", () => {
      expect(quoraHostForCookie("m-b=x; m-ql10n_nl=1; m-s=y")).toBe("nl.quora.com")
      expect(quoraHostForCookie("foo=1; m-ql10n_de=1")).toBe("de.quora.com")
      expect(quoraHostForCookie("m-ql10n_en=1")).toBeUndefined()
      expect(quoraHostForCookie("m-b=x; m-s=y")).toBeUndefined()
      expect(quoraHostForCookie(undefined)).toBeUndefined()
    })

    it("localizes only the gated feeds (search/topic/space), never question slugs", () => {
      expect(localizeQuoraUrl("https://www.quora.com/search?q=x&type=question", "nl.quora.com")).toBe(
        "https://nl.quora.com/search?q=x&type=question",
      )
      expect(localizeQuoraUrl("https://www.quora.com/topic/Magnesium", "nl.quora.com")).toBe(
        "https://nl.quora.com/topic/Magnesium",
      )
      // Question slugs are host-specific (they 404 on the wrong subdomain) - never rewritten.
      expect(localizeQuoraUrl("https://www.quora.com/Some-Question", "nl.quora.com")).toBe(
        "https://www.quora.com/Some-Question",
      )
      // No-op when host is undefined.
      expect(localizeQuoraUrl("https://www.quora.com/topic/Magnesium", undefined)).toBe(
        "https://www.quora.com/topic/Magnesium",
      )
    })
  })

  describe("stripHtml", () => {
    it("flattens answer HTML to plain text", () => {
      expect(stripHtml("<p>Magnesium <b>glycinate</b> is best.</p><p>Really.</p>")).toBe(
        "Magnesium glycinate is best. Really.",
      )
      expect(stripHtml("")).toBe("")
    })
  })

  describe("parseQuestionPage (rendered DOM - the primary path)", () => {
    const { question, answers } = parseQuestionPage(
      questionPageHtml,
      "https://www.quora.com/What-is-the-best-magnesium-supplement-for-sleep",
    )

    it("extracts question metadata (title from og:title, count from the header)", () => {
      expect(question.title).toBe("What is the best magnesium supplement for sleep?")
      expect(question.slug).toBe("What-is-the-best-magnesium-supplement-for-sleep")
      expect(question.answerCount).toBe(53)
      expect(question.url).toBe("https://www.quora.com/What-is-the-best-magnesium-supplement-for-sleep")
    })

    it("parses each annotated answer item, skipping empty-body slots", () => {
      // 2 real answers; the empty dom_annotate_question_answer_item_2 is dropped.
      expect(answers).toHaveLength(2)
    })

    it("reads the author from the profile link text, with upvotes/date/permalink", () => {
      const top = answers[0]
      expect(top.author).toBe("Dr Sara Lin")
      expect(top.authorUrl).toBe("https://www.quora.com/profile/Dr-Sara-Lin")
      expect(top.upvotes).toBe(1200) // "1.2K upvotes" → 1200
      expect(top.date).toBe("Mar 23")
      expect(top.body).toContain("Magnesium glycinate is the best for sleep")
      expect(top.body).toContain("waking up at 3am")
      expect(top.body).not.toContain("<p>")
      // The truncated preview + "Continue Reading" affordance must be stripped (no duplicated text).
      expect(top.body).not.toContain("Continue Reading")
      expect(top.body.match(/Magnesium glycinate is the best for sleep/g)).toHaveLength(1)
      expect(top.permalink).toContain("/answer/Dr-Sara-Lin")
    })

    it("falls back to the humanized profile slug when the link text is empty", () => {
      const second = answers[1]
      // href is /profile/Mark-Nguyen-17 with empty text → "Mark Nguyen" (disambiguation suffix stripped)
      expect(second.author).toBe("Mark Nguyen")
      expect(second.upvotes).toBeUndefined()
      expect(second.date).toBeUndefined()
      expect(second.body).toContain("Avoid magnesium oxide")
    })
  })

  describe("parseQuestionPage (JSON-LD fallback)", () => {
    const { question, answers } = parseQuestionPage(
      jsonLdQuestionHtml,
      "https://www.quora.com/Does-magnesium-glycinate-help-with-anxiety",
    )

    it("uses schema.org QAPage markup when no annotated DOM is present", () => {
      expect(question.title).toBe("Does magnesium glycinate help with anxiety?")
      expect(question.answerCount).toBe(12)
      expect(answers).toHaveLength(2)
      expect(answers[0].author).toBe("Dr Sara Lin")
      expect(answers[0].upvotes).toBe(88)
      expect(answers[0].body).toContain("inhibitory neurotransmitter")
      expect(answers[0].comments?.[0].author).toBe("Tom B")
    })
  })

  describe("gated and not-found shells", () => {
    it("flags the login wall and parses no answers", () => {
      const { answers } = parseQuestionPage(
        gatedQuestionHtml,
        "https://www.quora.com/Why-does-my-knee-hurt-when-I-squat",
      )
      expect(answers).toHaveLength(0)
      expect(looksLoginGated(gatedQuestionHtml, 0)).toBe(true)
      expect(looksLoginGated(gatedQuestionHtml, 3)).toBe(false)
    })

    it("surfaces Quora's Error shell as a titled, answerless page", () => {
      const { question, answers } = parseQuestionPage(notFoundQuestionHtml, "https://www.quora.com/Nonexistent-Slug")
      expect(answers).toHaveLength(0)
      expect(question.title).toBe("Error")
    })
  })

  describe("parseQuestionCards (search/topic)", () => {
    const cards = parseQuestionCards(searchPageHtml)

    it("extracts question links and de-dupes, ignoring reserved routes", () => {
      expect(cards).toHaveLength(2)
      const slugs = cards.map((c) => c.slug)
      expect(slugs).toContain("What-is-the-best-magnesium-supplement-for-sleep")
      expect(slugs).toContain("Does-magnesium-glycinate-actually-help-with-anxiety")
      expect(slugs.some((s) => s === "Magnesium" || s === "Health")).toBe(false)
    })

    it("builds absolute URLs and carries the anchor text as the title", () => {
      const card = cards.find((c) => c.slug === "What-is-the-best-magnesium-supplement-for-sleep")
      expect(card?.url).toBe("https://www.quora.com/What-is-the-best-magnesium-supplement-for-sleep")
      expect(card?.title).toBe("What is the best magnesium supplement for sleep?")
    })
  })
})

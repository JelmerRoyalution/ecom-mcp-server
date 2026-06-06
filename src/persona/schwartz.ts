/* eslint-disable functype/no-let, functype/no-imperative-loops, functype/prefer-functype-map, functype/prefer-fold --
 * This module is a deterministic text-mining primitive. It scans a corpus of customer
 * discussion against cue lexicons and accumulates matches into buckets - an inherently
 * imperative pass over tokens and sentences. Expressing the scanners as immutable folds
 * would obscure intent without changing behavior. The LLM does the synthesis; this module
 * only extracts and organizes raw evidence.
 */

/**
 * Voice-of-customer evidence mined from a discussion corpus, bucketed for the
 * Schwartz "Breakthrough Advertising" workflow. Every value is a verbatim (cleaned)
 * fragment from the source so the downstream persona uses the prospect's own words.
 */
export type VoiceOfCustomer = {
  readonly pains: readonly string[]
  readonly desires: readonly string[]
  readonly objections: readonly string[]
  readonly questions: readonly string[]
  readonly emotionalTriggers: readonly string[]
  readonly productMentions: readonly string[]
  /** Distinctive recurring phrases ("the words the market uses"). */
  readonly vocabulary: readonly string[]
  /** High-signal first-person verbatim lines worth quoting directly. */
  readonly quotes: readonly string[]
}

export type AwarenessStage = "unaware" | "problem-aware" | "solution-aware" | "product-aware" | "most-aware"

export type AwarenessDistribution = {
  readonly dominant: AwarenessStage
  /** Percentages (0–100) per stage, summing to ~100. */
  readonly weights: Readonly<Record<AwarenessStage, number>>
}

export type SophisticationAssessment = {
  /** Schwartz market sophistication level, 1 (fresh) … 5 (jaded). */
  readonly level: 1 | 2 | 3 | 4 | 5
  readonly rationale: string
}

const PAIN_CUES = [
  "hate",
  "frustrat",
  "annoy",
  "struggle",
  "struggling",
  "can't",
  "cant ",
  "cannot",
  "problem",
  "issue",
  "pain",
  "tired of",
  "sick of",
  "worst",
  "difficult",
  "hard to",
  "fails",
  "failing",
  "doesn't work",
  "does not work",
  "doesnt work",
  "broke",
  "broken",
  "waste",
  "disappoint",
  "useless",
  "nightmare",
  "stuck",
  "overwhelm",
  "confus",
  "worried",
  "scared",
  "afraid",
  "embarrass",
  "ashamed",
  "exhaust",
  "desperate",
  "no idea",
]

const DESIRE_CUES = [
  "wish",
  "want to",
  "i want",
  "we want",
  "hope to",
  "dream",
  "would love",
  "i'd love",
  "love to",
  "looking for",
  "i need",
  "we need",
  "my goal",
  "aspire",
  "finally able",
  "so i can",
  "so that i",
  "wish i could",
  "i desire",
  "ideal",
  "perfect would be",
]

const OBJECTION_CUES = [
  "too expensive",
  "expensive",
  "scam",
  "rip off",
  "ripoff",
  "skeptic",
  "not sure",
  "don't believe",
  "dont believe",
  "already tried",
  "i tried",
  "we tried",
  "didn't work",
  "didnt work",
  "waste of money",
  "overpriced",
  "not convinced",
  "doubt",
  "is it worth",
  "worried it",
  "snake oil",
  "gimmick",
  "nothing works",
  "tried everything",
]

const EMOTION_WORDS = [
  "love",
  "hate",
  "afraid",
  "scared",
  "anxious",
  "excited",
  "frustrated",
  "angry",
  "embarrassed",
  "ashamed",
  "hopeful",
  "desperate",
  "overwhelmed",
  "relieved",
  "confident",
  "worried",
  "guilty",
  "proud",
  "jealous",
  "insecure",
  "stressed",
]

const MOST_AWARE_CUES = [
  "discount",
  "coupon",
  "promo",
  "best price",
  "where to buy",
  "where can i buy",
  "ready to buy",
  "checkout",
  "deal",
  "on sale",
  "free shipping",
]

const PRODUCT_LEAD_INS = ["tried", "using", "use", "bought", "buy", "switched to", "recommend", "ordered", "got the"]

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "of",
  "to",
  "in",
  "on",
  "for",
  "with",
  "at",
  "by",
  "from",
  "up",
  "about",
  "into",
  "over",
  "after",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "it",
  "its",
  "this",
  "that",
  "these",
  "those",
  "i",
  "you",
  "he",
  "she",
  "we",
  "they",
  "my",
  "your",
  "his",
  "her",
  "our",
  "their",
  "me",
  "him",
  "them",
  "us",
  "do",
  "does",
  "did",
  "have",
  "has",
  "had",
  "will",
  "would",
  "can",
  "could",
  "should",
  "not",
  "no",
  "so",
  "if",
  "then",
  "than",
  "too",
  "very",
  "just",
  "really",
  "more",
  "most",
  "some",
  "any",
  "all",
  "out",
  "get",
  "got",
  "like",
  "one",
  "also",
  "what",
  "when",
  "where",
  "who",
  "how",
  "why",
  "which",
  "there",
  "here",
  "because",
  "as",
  "im",
  "ive",
])

function uniqueCapped(items: readonly string[], limit: number): readonly string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of items) {
    const key = item.toLowerCase()
    if (!seen.has(key) && item.length > 0) {
      seen.add(key)
      out.push(item)
      if (out.length >= limit) {
        break
      }
    }
  }
  return out
}

/** Split a block of text into trimmed sentence-ish fragments. */
export function splitSentences(text: string): readonly string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+|\n+|(?<=\S{2})\s*[•·]\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 3)
}

function containsAny(haystackLower: string, needles: readonly string[]): boolean {
  for (const needle of needles) {
    if (haystackLower.includes(needle)) {
      return true
    }
  }
  return false
}

function cap(sentence: string, max = 240): string {
  const trimmed = sentence.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max - 1).trim()}…` : trimmed
}

function extractProductMentions(sentenceLower: string, original: string): readonly string[] {
  const out: string[] = []
  for (const lead of PRODUCT_LEAD_INS) {
    const idx = sentenceLower.indexOf(`${lead} `)
    if (idx === -1) {
      continue
    }
    const after = original.slice(idx + lead.length + 1)
    const phrase = after
      .split(/[.,!?;:]/)[0]
      .split(/\s+/)
      .slice(0, 4)
      .join(" ")
      .trim()
    if (phrase.length >= 2 && !STOPWORDS.has(phrase.toLowerCase())) {
      out.push(`${lead} ${phrase}`)
    }
  }
  return out
}

function topBigrams(texts: readonly string[], limit: number): readonly string[] {
  const counts = new Map<string, number>()
  for (const text of texts) {
    const tokens = text
      .toLowerCase()
      .replace(/[^a-z0-9'\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOPWORDS.has(t))
    for (let i = 0; i < tokens.length - 1; i++) {
      const bigram = `${tokens[i]} ${tokens[i + 1]}`
      counts.set(bigram, (counts.get(bigram) ?? 0) + 1)
    }
  }
  return Array.from(counts.entries())
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([bigram, n]) => `${bigram} (×${n})`)
}

/** Scan a corpus and bucket the voice-of-customer evidence. */
export function mineVoiceOfCustomer(texts: readonly string[]): VoiceOfCustomer {
  const pains: string[] = []
  const desires: string[] = []
  const objections: string[] = []
  const questions: string[] = []
  const emotionalTriggers: string[] = []
  const productMentions: string[] = []
  const quotes: string[] = []

  for (const text of texts) {
    for (const sentence of splitSentences(text)) {
      const lower = sentence.toLowerCase()

      if (sentence.endsWith("?")) {
        questions.push(cap(sentence))
      }
      if (containsAny(lower, PAIN_CUES)) {
        pains.push(cap(sentence))
      }
      if (containsAny(lower, DESIRE_CUES)) {
        desires.push(cap(sentence))
      }
      if (containsAny(lower, OBJECTION_CUES)) {
        objections.push(cap(sentence))
      }
      if (containsAny(lower, EMOTION_WORDS)) {
        emotionalTriggers.push(cap(sentence))
      }
      productMentions.push(...extractProductMentions(lower, sentence))

      // High-signal first-person lines make the best verbatim quotes.
      const firstPerson = /^(i |we |my |our |i'm |i've |im )/.test(lower) || / i /.test(lower)
      if (firstPerson && (containsAny(lower, PAIN_CUES) || containsAny(lower, DESIRE_CUES))) {
        quotes.push(cap(sentence))
      }
    }
  }

  return {
    pains: uniqueCapped(pains, 30),
    desires: uniqueCapped(desires, 30),
    objections: uniqueCapped(objections, 25),
    questions: uniqueCapped(questions, 25),
    emotionalTriggers: uniqueCapped(emotionalTriggers, 25),
    productMentions: uniqueCapped(productMentions, 25),
    vocabulary: topBigrams(texts, 25),
    quotes: uniqueCapped(quotes, 20),
  }
}

/** Heuristic distribution of the corpus across Schwartz's five awareness stages. */
export function inferAwarenessDistribution(texts: readonly string[], voc: VoiceOfCustomer): AwarenessDistribution {
  const joined = texts.join(" \n ").toLowerCase()
  const raw: Record<AwarenessStage, number> = {
    unaware: 1,
    "problem-aware": voc.pains.length + 1,
    "solution-aware": voc.desires.length + voc.questions.length + 1,
    "product-aware": voc.productMentions.length + voc.objections.length + 1,
    "most-aware": MOST_AWARE_CUES.reduce((acc, cue) => acc + (joined.includes(cue) ? 3 : 0), 0),
  }

  const total = Object.values(raw).reduce((a, b) => a + b, 0)
  const weights = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Math.round((v / total) * 100)])) as Record<
    AwarenessStage,
    number
  >

  let dominant: AwarenessStage = "problem-aware"
  let best = -1
  for (const [stage, weight] of Object.entries(weights) as [AwarenessStage, number][]) {
    if (weight > best) {
      best = weight
      dominant = stage
    }
  }

  return { dominant, weights }
}

/** Heuristic Schwartz market-sophistication level from skepticism/comparison density. */
export function inferSophistication(texts: readonly string[], voc: VoiceOfCustomer): SophisticationAssessment {
  const joined = texts.join(" \n ").toLowerCase()
  const jadedSignals = [
    "tried everything",
    "nothing works",
    "scam",
    "snake oil",
    "gimmick",
    "every single",
    "yet another",
    "all the same",
  ]
  const comparativeSignals = ["better than", "vs", "versus", "compared to", "best", "#1", "number one", "unlike"]

  const jaded = jadedSignals.reduce((acc, s) => acc + (joined.includes(s) ? 1 : 0), 0)
  const comparative = comparativeSignals.reduce((acc, s) => acc + (joined.includes(s) ? 1 : 0), 0)
  const objectionDensity = texts.length > 0 ? voc.objections.length / texts.length : 0

  if (jaded >= 2 || objectionDensity > 0.5) {
    return {
      level: 5,
      rationale:
        "Heavy skepticism and 'tried everything / nothing works' language. The market is jaded; claims and mechanisms are exhausted - lead with identification, the prospect's identity and lived experience, not new claims.",
    }
  }
  if (jaded === 1 || comparative >= 3) {
    return {
      level: 4,
      rationale:
        "Strong comparison-shopping and some disbelief. Mechanisms are well-worn - elaborate and amplify your unique mechanism, make it more credible/concrete than competitors.",
    }
  }
  if (comparative >= 1 || voc.objections.length >= 3) {
    return {
      level: 3,
      rationale:
        "The market has heard the core claims and is starting to compare. Introduce a NEW mechanism - explain *how* your product delivers the result differently.",
    }
  }
  if (voc.desires.length >= 5) {
    return {
      level: 2,
      rationale:
        "Desire is clearly expressed and a few claims circulate. Enlarge/extend the winning claim - make the promise bigger and more specific than what's currently said.",
    }
  }
  return {
    level: 1,
    rationale:
      "Little competing-claim or skepticism language detected. The market may be fresh for this promise - state the claim directly and simply; be first to name the desire.",
  }
}

const STAGE_GUIDANCE: Record<AwarenessStage, string> = {
  unaware:
    "Prospect doesn't yet know they have the problem. Lead with story/identity/emotion, not the product. Name the feeling before the problem.",
  "problem-aware":
    "Prospect feels the pain but doesn't know solutions exist. Lead with the problem in their words, then bridge to that a solution category exists.",
  "solution-aware":
    "Prospect knows solutions exist and wants the result, but not that YOUR product delivers it. Lead with the desired outcome + your mechanism.",
  "product-aware":
    "Prospect knows your product but isn't convinced. Lead with proof, differentiation, risk-reversal, specifics vs alternatives.",
  "most-aware":
    "Prospect knows and wants it - just needs the deal/terms. Lead with the offer, urgency, and a direct CTA.",
}

export type PersonaBriefInput = {
  readonly texts: readonly string[]
  readonly productContext?: string
  readonly sourceLabel?: string
}

/**
 * Build a Markdown "Breakthrough Advertising" persona brief: it organizes the mined
 * evidence into Schwartz's framework and then instructs the calling LLM to synthesize
 * the final persona using ONLY that evidence (extraction here, synthesis by the model).
 */
export function buildPersonaBrief(input: PersonaBriefInput): string {
  const texts = input.texts.filter((t) => t.trim().length > 0)
  const voc = mineVoiceOfCustomer(texts)
  const awareness = inferAwarenessDistribution(texts, voc)
  const sophistication = inferSophistication(texts, voc)

  const totalChars = texts.reduce((acc, t) => acc + t.length, 0)
  const list = (items: readonly string[]): string =>
    items.length === 0 ? "_(none detected)_" : items.map((i) => `- ${i.replace(/\n/g, " ")}`).join("\n")

  const weightLines = (Object.entries(awareness.weights) as [AwarenessStage, number][])
    .sort((a, b) => b[1] - a[1])
    .map(([stage, w]) => `- **${stage}** - ${w}%${stage === awareness.dominant ? "  ← dominant" : ""}`)
    .join("\n")

  return `# Customer Persona Brief - Schwartz "Breakthrough Advertising"

${input.productContext !== undefined ? `**Product / niche context:** ${input.productContext}\n` : ""}**Source:** ${input.sourceLabel ?? "supplied discussion corpus"}
**Corpus size:** ${texts.length} item(s), ${totalChars.toLocaleString()} characters

> This brief is auto-extracted evidence. Eugene Schwartz's first principle: *"You cannot create
> desire - you can only channel the desires that already exist in the mind of the prospect."*
> Synthesize the persona from the verbatim evidence below. Quote real language; flag anything
> you infer beyond the evidence as an assumption.

---

## 1. Mass Desire (what they already want)
${list(voc.desires)}

## 2. Core Pains & Frustrations
${list(voc.pains)}

## 3. Beliefs, Objections & Skepticism
${list(voc.objections)}

## 4. Questions the Market Is Asking
${list(voc.questions)}

## 5. Emotional Triggers
${list(voc.emotionalTriggers)}

## 6. Products / Solutions They Mention
${list(voc.productMentions)}

## 7. Voice of Customer - Verbatim Quotes (mirror this language)
${list(voc.quotes)}

## 8. The Words They Use (recurring phrases)
${list(voc.vocabulary)}

---

## 9. State of Awareness (heuristic)
${weightLines}

**Dominant entry point - ${awareness.dominant}:** ${STAGE_GUIDANCE[awareness.dominant]}

## 10. Market Sophistication (heuristic): Level ${sophistication.level} / 5
${sophistication.rationale}

---

## Your task (synthesis)
Using ONLY the evidence above, write a customer persona with these sections:
1. **Identity snapshot** - who they are, in their own words.
2. **Dominant mass desire** - the single deepest want to channel.
3. **Core pains** - ranked, quoting verbatim.
4. **Dream outcome** - the transformation they crave.
5. **Beliefs & objections** - what they must overcome to buy.
6. **Awareness stage & messaging entry point** - where to start the conversation (use §9).
7. **Sophistication level & claim strategy** - how to position the claim/mechanism (use §10).
8. **Voice & vocabulary to mirror** - exact phrases to use in copy.
9. **Big Idea & 3 headline angles** - channel the desire into Schwartz-style headlines.

Do not invent demographics or facts not supported by the evidence; label inferences as assumptions.`
}

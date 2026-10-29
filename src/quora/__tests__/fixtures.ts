/**
 * Quora fixtures shaped after the REAL live DOM (validated against quora.com). Quora does NOT serve
 * schema.org JSON-LD to logged-out clients; the browser-rendered page carries each answer in a
 * `dom_annotate_question_answer_item_N` wrapper, with the body in `.spacing_log_answer_content`, the
 * author in a `/profile/<slug>` link, the permalink in an `/answer/<slug>` link, and (when present)
 * the upvote count in an `aria-label`. The fixtures below reproduce that structure (trimmed) plus the
 * gated / not-found shells and a search anchor list. A separate JSON-LD fixture exercises the
 * fallback path for any render that still ships QAPage markup.
 */

const QUESTION_URL = "https://www.quora.com/What-is-the-best-magnesium-supplement-for-sleep"

// Primary path: the browser-rendered answer DOM.
export const questionPageHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta property="og:title" content="What is the best magnesium supplement for sleep? - Quora" />
  <title>What is the best magnesium supplement for sleep? - Quora</title>
</head>
<body>
  <div class="q-box"><div class="q-text">53 Answers</div></div>

  <div class="q-box dom_annotate_question_answer_item_0">
    <div class="q-box">
      <a class="q-box" href="https://www.quora.com/profile/Dr-Sara-Lin"><span class="q-box">Dr Sara Lin</span></a>
      <span>· Functional medicine MD · </span>
      <a href="${QUESTION_URL}/answer/Dr-Sara-Lin">Mar 23</a>
    </div>
    <div class="q-click-wrapper" aria-label="1.2K upvotes from people"></div>
    <div class="spacing_log_answer_content">
      <div class="preview">Magnesium glycinate is the best for sleep. It absorbs we</div>
      <div class="q-text-link">Continue Reading</div>
      <div class="q-text qu-wordBreak--break-word"><span class="q-box">
        <p class="q-text">Magnesium <b>glycinate</b> is the best for sleep.</p>
        <p class="q-text">It absorbs well and doesn't cause the laxative effect citrate does. I take 400mg an hour before bed and finally stopped waking up at 3am.</p>
      </span></div>
    </div>
  </div>

  <div class="q-box dom_annotate_question_answer_item_1">
    <div class="q-box">
      <a class="q-box" href="https://www.quora.com/profile/Mark-Nguyen-17"></a>
    </div>
    <div class="spacing_log_answer_content">
      <div class="q-text"><p class="q-text">Honestly the brand matters less than the <i>form</i>. Avoid magnesium oxide — it's poorly absorbed. Glycinate or threonate for sleep.</p></div>
    </div>
  </div>

  <!-- an answer item with no body should be skipped (e.g. a promoted/related slot) -->
  <div class="q-box dom_annotate_question_answer_item_2">
    <div class="spacing_log_answer_content"></div>
  </div>
</body>
</html>`

// Fallback path: a render that still ships schema.org QAPage JSON-LD.
const questionJsonLd = {
  "@context": "https://schema.org",
  "@type": "QAPage",
  mainEntity: {
    "@type": "Question",
    name: "Does magnesium glycinate help with anxiety?",
    answerCount: 12,
    acceptedAnswer: {
      "@type": "Answer",
      text: "<p>Yes — glycinate is calming because glycine itself is an inhibitory neurotransmitter.</p>",
      upvoteCount: 88,
      dateCreated: "2023-04-02T08:30:00.000Z",
      url: "https://www.quora.com/Does-magnesium-glycinate-help-with-anxiety/answer/Dr-Sara-Lin",
      author: { "@type": "Person", name: "Dr Sara Lin", url: "https://www.quora.com/profile/Dr-Sara-Lin" },
      comment: [{ "@type": "Comment", text: "<p>Worked for me too.</p>", upvoteCount: 4, author: { name: "Tom B" } }],
    },
    suggestedAnswer: [
      {
        "@type": "Answer",
        text: "<p>It helped my sleep more than my anxiety, but the two are linked.</p>",
        upvoteCount: 21,
        author: { "@type": "Person", name: "Mark Nguyen" },
      },
    ],
  },
}

export const jsonLdQuestionHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta property="og:title" content="Does magnesium glycinate help with anxiety? - Quora" />
  <script type="application/ld+json">${JSON.stringify(questionJsonLd)}</script>
</head>
<body><div id="root">app shell with no annotated answer items</div></body>
</html>`

/** A login-wall shell: no answers + the gated markers Quora shows logged-out. */
export const gatedQuestionHtml = `<!DOCTYPE html>
<html lang="en">
<head><meta property="og:title" content="Why does my knee hurt when I squat? - Quora" /></head>
<body>
  <div class="loginModal">Continue with Google</div>
  <div>Login to Quora to read more answers.</div>
</body>
</html>`

/** Quora's "Error" shell for a slug that doesn't exist / was merged or removed. */
export const notFoundQuestionHtml = `<!DOCTYPE html>
<html lang="en">
<head><meta property="og:title" content="Error - Quora" /><title>Error - Quora</title></head>
<body><div id="root">Something went wrong.</div></body>
</html>`

/** A search results page: question cards exposed only as anchors (no JSON-LD). */
export const searchPageHtml = `<!DOCTYPE html>
<html lang="en">
<body>
  <div class="q-box">
    <a href="/What-is-the-best-magnesium-supplement-for-sleep">What is the best magnesium supplement for sleep?</a>
  </div>
  <div class="q-box">
    <a href="https://www.quora.com/Does-magnesium-glycinate-actually-help-with-anxiety">Does magnesium glycinate actually help with anxiety?</a>
  </div>
  <div class="q-box">
    <!-- reserved routes and topic links must be ignored -->
    <a href="/topic/Magnesium">Magnesium</a>
    <a href="/profile/Some-Person">Some Person</a>
    <a href="/search?q=magnesium">search again</a>
    <a href="/Health">Health</a>
  </div>
  <div class="q-box">
    <a href="/What-is-the-best-magnesium-supplement-for-sleep">duplicate link should de-dupe</a>
  </div>
</body>
</html>`

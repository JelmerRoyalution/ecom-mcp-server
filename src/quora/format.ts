import type { QuoraAnswer, QuoraQuestion, QuoraQuestionWithAnswers } from "./types"

function truncate(text: string, max: number): string {
  const clean = text.replace(/\n{3,}/g, "\n\n").trim()
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean
}

function questionMeta(q: QuoraQuestion): string {
  return [
    q.answerCount !== undefined ? `${q.answerCount.toLocaleString()} answers` : "",
    q.followerCount !== undefined ? `${q.followerCount.toLocaleString()} followers` : "",
  ]
    .filter((s) => s.length > 0)
    .join(" · ")
}

/** Render a list of Quora question cards as Markdown (each ready to feed into quora_get_question). */
export function formatQuestionCards(heading: string, questions: readonly QuoraQuestion[]): string {
  if (questions.length === 0) {
    return `# ${heading}\n\nNo questions found. Quora search/topic feeds are gated when logged out - try QUORA_ENGINE=browser with a logged-in QUORA_COOKIE (run \`pnpm run setup\`), or pass a question URL directly.`
  }
  const body = questions
    .map((q, index) => {
      const meta = questionMeta(q)
      return `### ${index + 1}. ${q.title}${meta.length > 0 ? `\n- ${meta}` : ""}\n- URL: ${q.url}`
    })
    .join("\n\n")
  return `# ${heading}\n\n_${questions.length} question(s) - feed a URL into quora_get_question:_\n\n${body}`
}

function formatAnswer(answer: QuoraAnswer, index: number): string {
  const meta = [answer.upvotes !== undefined ? `▲ ${answer.upvotes.toLocaleString()} upvotes` : "", answer.date ?? ""]
    .filter((s) => s.length > 0)
    .join(" · ")

  const commentLine =
    answer.comments !== undefined && answer.comments.length > 0 ? `\n💬 ${answer.comments.length} comment(s)` : ""

  return `### ${index + 1}. ${answer.author}
${meta}

${truncate(answer.body, 1200)}${commentLine}`
}

/** Render a Quora question and its answers as Markdown. */
export function formatQuestionWithAnswers(result: QuoraQuestionWithAnswers): string {
  const { question, answers } = result
  const meta = questionMeta(question)
  const header = `# Quora Question: ${question.title}
${meta.length > 0 ? `\n- ${meta}` : ""}
- URL: ${question.url}`

  if (answers.length === 0) {
    return `${header}

---

No answers parsed. Quora often gates answers behind a login wall - try QUORA_ENGINE=browser with a logged-in QUORA_COOKIE (run \`pnpm run setup\`).`
  }

  const upvoted = answers.filter((a) => a.upvotes !== undefined).length
  const body = answers.map((answer, index) => formatAnswer(answer, index)).join("\n\n---\n\n")

  return `${header}

---

_${answers.length} answer(s) scraped${upvoted > 0 ? ` · ${upvoted} with upvote counts` : ""}_

${body}`
}

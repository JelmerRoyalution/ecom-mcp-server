import type { FacebookComment, FacebookGroup, FacebookPost, FacebookPostWithComments } from "./types"

function truncate(text: string, max: number): string {
  const clean = text.replace(/\n{3,}/g, "\n\n").trim()
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean
}

function engagementLine(post: FacebookPost): string {
  const parts: string[] = []
  if (post.likeCount !== undefined) parts.push(`Reactions: ${post.likeCount.toLocaleString()}`)
  if (post.commentCount !== undefined) parts.push(`Comments: ${post.commentCount.toLocaleString()}`)
  if (post.shareCount !== undefined) parts.push(`Shares: ${post.shareCount.toLocaleString()}`)
  return parts.join(" | ")
}

/** Render a group/page feed as Markdown. */
export function formatFeed(heading: string, posts: readonly FacebookPost[]): string {
  if (posts.length === 0) {
    return `# ${heading}\n\nNo posts found.`
  }

  const body = posts
    .map((post, index) => {
      const engagement = engagementLine(post)
      const meta = [
        engagement.length > 0 ? `- ${engagement}` : "",
        post.timestamp !== undefined ? `- Posted: ${post.timestamp}` : "",
        post.permalink !== undefined ? `- Link: ${post.permalink}` : "",
      ]
        .filter((s) => s.length > 0)
        .join("\n")

      return `### ${index + 1}. ${post.author}

${truncate(post.text, 800)}
${meta}`
    })
    .join("\n\n---\n\n")

  return `# ${heading}

_${posts.length} post(s)._

${body}`
}

/** Render a post and its comment thread as Markdown. */
export function formatPostComments(result: FacebookPostWithComments): string {
  const { post, comments } = result
  const header = `# Facebook Discussion — post by ${post.author}

${truncate(post.text, 600)}

${[
  post.groupName !== undefined || post.groupId !== undefined ? `**Group:** ${post.groupName ?? post.groupId}` : "",
  post.permalink !== undefined ? `**Link:** ${post.permalink}` : "",
]
  .filter((s) => s.length > 0)
  .join(" · ")}

---
`

  if (comments.length === 0) {
    return `${header}\nNo comments parsed. The thread may need the browser engine to expand replies, or the post has no comments.`
  }

  const rendered = comments
    .map((comment: FacebookComment) => {
      const indent = comment.depth > 0 ? `${"  ".repeat(Math.min(comment.depth, 4))}↳ ` : ""
      const likes = comment.likeCount !== undefined ? ` (${comment.likeCount} reactions)` : ""
      return `${indent}**${comment.author}**${likes}\n${indent}${truncate(comment.text, 600)}`
    })
    .join("\n\n")

  return `${header}\n_${comments.length} comment(s):_\n\n${rendered}`
}

/** Render group metadata as Markdown. */
export function formatGroupInfo(group: FacebookGroup): string {
  return `# Facebook Group: ${group.name}

- Group ID/slug: ${group.id}
- Privacy: ${group.privacy}
- Members: ${group.memberCount !== undefined ? group.memberCount.toLocaleString() : "unknown"}
- URL: ${group.url}
${group.description !== undefined ? `\n## Description\n${group.description}` : ""}`
}

/** Render group search results as Markdown. */
export function formatGroupSearch(query: string, groups: readonly FacebookGroup[]): string {
  if (groups.length === 0) {
    return `# Facebook Group Search: "${query}"\n\nNo groups found (search often requires the browser engine + a logged-in session).`
  }
  const body = groups
    .map((group, index) => `### ${index + 1}. ${group.name}\n- ID/slug: ${group.id}\n- URL: ${group.url}`)
    .join("\n\n")
  return `# Facebook Group Search: "${query}"\n\n_${groups.length} result(s):_\n\n${body}`
}

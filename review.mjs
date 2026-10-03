// VibeCoderHans: reviews a pull request with an Anthropic-compatible model and
// posts the result as a PR review. Run by action.yml.
import Anthropic from '@anthropic-ai/sdk'

const {
  GITHUB_TOKEN,
  GITHUB_REPOSITORY,
  PR_NUMBER,
  REVIEW_MODEL,
  REVIEW_INSTRUCTIONS,
  REVIEW_EXCLUDE,
  REVIEW_MAX_DIFF_CHARS,
} = process.env
const GITHUB_API_URL = process.env.GITHUB_API_URL ?? 'https://api.github.com'
const MAX_DIFF_CHARS = Number(REVIEW_MAX_DIFF_CHARS) || 400_000
const LOCKFILES =
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Podfile\.lock|Gemfile\.lock|Cargo\.lock|composer\.lock|go\.sum)$/
const EXCLUDE = REVIEW_EXCLUDE ? new RegExp(REVIEW_EXCLUDE) : null
const HEADER = '### VibeCoderHans review'

const SYSTEM_PROMPT = `You are VibeCoderHans, a code reviewer.

Review the pull request diff. Report real problems only: bugs, crashes, race conditions, security issues, resource leaks, breaking public API changes and missing error handling. Skip formatting and style nits that a linter would catch.

Reply with only a JSON object, with no prose and no code fences, in this shape:
{"summary": string, "comments": [{"path": string, "line": number, "severity": "bug" | "risk" | "nit", "body": string}]}

"path" is the file path from the diff. "line" is a line number on the new side of the diff that falls inside a hunk. If the change looks good, say so in the summary and return an empty comments array.${
  REVIEW_INSTRUCTIONS?.trim()
    ? `\n\nNotes from this repository's maintainers:\n${REVIEW_INSTRUCTIONS.trim()}`
    : ''
}`

if (!PR_NUMBER) {
  throw new Error(
    'No pull request number. Run this action on pull_request events.'
  )
}

const gh = (path, init = {}) =>
  fetch(`${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}${path}`, {
    ...init,
    headers: {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...init.headers,
    },
  })

function parseReview(text) {
  try {
    const review = JSON.parse(
      text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
    )
    if (typeof review.summary !== 'string' || !Array.isArray(review.comments))
      return null
    review.comments = review.comments.filter(
      c =>
        typeof c?.path === 'string' &&
        Number.isInteger(c.line) &&
        c.line > 0 &&
        typeof c.body === 'string'
    )
    return review
  } catch {
    return null
  }
}

// 1. Fetch the PR and its diff, minus lockfiles and excluded paths
const prRes = await gh(`/pulls/${PR_NUMBER}`)
if (!prRes.ok) {
  throw new Error(`GitHub API ${prRes.status}: ${await prRes.text()}`)
}
const pr = await prRes.json()
const diffRes = await gh(`/pulls/${PR_NUMBER}`, {
  headers: { Accept: 'application/vnd.github.diff' },
})
if (!diffRes.ok) {
  // GitHub answers 406 for diffs over its size limit.
  console.log(`Could not fetch the diff (${diffRes.status}); skipping review.`)
  process.exit(0)
}
const diff = (await diffRes.text())
  .split(/^(?=diff --git )/m)
  .filter(section => {
    const path = section.match(/^diff --git a\/\S+ b\/(\S+)/)?.[1] ?? ''
    return !LOCKFILES.test(path) && !EXCLUDE?.test(path)
  })
  .join('')

if (!diff.trim()) {
  console.log('Only lockfiles or excluded files changed; skipping review.')
  process.exit(0)
}
if (diff.length > MAX_DIFF_CHARS) {
  console.log(
    `Diff is ${diff.length} characters, over the ${MAX_DIFF_CHARS} limit; skipping review.`
  )
  process.exit(0)
}

// 2. Ask the model for a review. The client reads ANTHROPIC_BASE_URL and
// ANTHROPIC_AUTH_TOKEN from the environment.
const client = new Anthropic()
const response = await client.messages.create({
  model: REVIEW_MODEL,
  max_tokens: 16000,
  system: SYSTEM_PROMPT,
  messages: [
    {
      role: 'user',
      content: `PR title: ${pr.title}\n\nPR description:\n${pr.body || '(none)'}\n\n<diff>\n${diff}\n</diff>`,
    },
  ],
})
if (response.stop_reason === 'max_tokens') {
  throw new Error('The review was cut off at max_tokens.')
}
const text = response.content
  .filter(block => block.type === 'text')
  .map(block => block.text)
  .join('')
if (!text.trim()) throw new Error('The model returned no review text.')

// 3. Post it as a PR review with inline comments
const post = payload =>
  gh(`/pulls/${PR_NUMBER}/reviews`, {
    method: 'POST',
    body: JSON.stringify({
      commit_id: pr.head.sha,
      event: 'COMMENT',
      ...payload,
    }),
  })

const review = parseReview(text)
let res
if (!review) {
  // The model ignored the JSON format; post what it wrote rather than nothing.
  res = await post({ body: `${HEADER}\n\n${text}` })
} else {
  const label = c => `**${c.severity ?? 'note'}**`
  const body = `${HEADER}\n\n${review.summary}`
  res = await post({
    body,
    comments: review.comments.map(c => ({
      path: c.path,
      line: c.line,
      side: 'RIGHT',
      body: `${label(c)}: ${c.body}`,
    })),
  })
  // GitHub rejects the whole review (422) if any comment points outside the
  // diff. Fall back to listing the findings in the review body.
  if (res.status === 422) {
    const list = review.comments
      .map(c => `- \`${c.path}:${c.line}\` ${label(c)}: ${c.body}`)
      .join('\n')
    res = await post({ body: `${body}\n\n${list}` })
  }
}
if (!res.ok) {
  throw new Error(`GitHub API ${res.status}: ${await res.text()}`)
}
console.log(`Posted review on #${PR_NUMBER}.`)

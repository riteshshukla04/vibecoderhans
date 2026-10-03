// VibeCoderHans: reviews a pull request with an Anthropic-compatible model and
// posts the result as a PR review. Run by action.yml.
import Anthropic from '@anthropic-ai/sdk'

const {
  GITHUB_TOKEN,
  GITHUB_REPOSITORY,
  PR_NUMBER,
  BOT_LOGIN,
  REVIEW_MODEL,
  REVIEW_INSTRUCTIONS,
  REVIEW_EXCLUDE,
  REVIEW_MAX_DIFF_CHARS,
  REVIEW_ALLOW_REQUEST_CHANGES,
  REVIEW_ALLOW_CLOSE,
} = process.env
const GITHUB_API_URL = process.env.GITHUB_API_URL ?? 'https://api.github.com'
const MAX_DIFF_CHARS = Number(REVIEW_MAX_DIFF_CHARS) || 400_000
const ALLOW_REQUEST_CHANGES = REVIEW_ALLOW_REQUEST_CHANGES !== 'false'
const ALLOW_CLOSE = REVIEW_ALLOW_CLOSE === 'true'
const LOCKFILES =
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Podfile\.lock|Gemfile\.lock|Cargo\.lock|composer\.lock|go\.sum)$/
const EXCLUDE = REVIEW_EXCLUDE ? new RegExp(REVIEW_EXCLUDE) : null
const VERDICTS = ['comment', 'request_changes', 'close']
const HEADERS = {
  comment: '### VibeCoderHans review',
  request_changes: '### VibeCoderHans review: changes requested',
  close: '### VibeCoderHans review: closing this PR',
}

const SYSTEM_PROMPT = `You are VibeCoderHans, a savage code reviewer. You are brutally honest, blunt and sarcastic. You never sugarcoat, you never pad a review with praise, and you call bad code exactly what it is. Good code gets a grudging nod at most.

Review the pull request. Hunt for real problems: bugs, crashes, race conditions, security holes, resource leaks, breaking public API changes and missing error handling. Don't waste anyone's time on formatting nits that a linter would catch.

Pick a verdict:
- "comment": the change is fine, or only has minor issues.
- "request_changes": the change has problems that must be fixed before it can merge.
- "close": the change makes no sense at all, such as spam, nonsense, deliberately broken code or changes unrelated to the project, and no amount of fixing would save it.

When the verdict is "close", go fully savage: tear the change apart and make it painfully clear why it is being closed. Never use slurs or attack anyone's identity.

Each line inside a diff hunk starts with its line number in the new file; removed lines have no number. Use that number for a comment's "line", and only comment on lines that have one.

Submit the review by calling the submit_review tool once.${
  REVIEW_INSTRUCTIONS?.trim()
    ? `\n\nNotes from this repository's maintainers:\n${REVIEW_INSTRUCTIONS.trim()}`
    : ''
}`

const REVIEW_TOOL = {
  name: 'submit_review',
  description: 'Submit the review of the pull request. Call it exactly once.',
  input_schema: {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: VERDICTS },
      summary: {
        type: 'string',
        description: 'The overall review, in Markdown.',
      },
      comments: {
        type: 'array',
        description:
          'Problems tied to specific lines. Empty if there are none.',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path from the diff.' },
            line: {
              type: 'integer',
              description: 'Line number in the new file, as shown in the diff.',
            },
            severity: { type: 'string', enum: ['bug', 'risk', 'nit'] },
            body: {
              type: 'string',
              description: 'What is wrong and how to fix it.',
            },
          },
          required: ['path', 'line', 'severity', 'body'],
        },
      },
    },
    required: ['verdict', 'summary', 'comments'],
  },
}

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

// Prefix each line inside a hunk with its line number in the new file, so the
// model can point comments at the right line.
function numberLines(section) {
  let line = 0
  return section
    .split('\n')
    .map(text => {
      const hunk = text.match(/^@@ -\d+(?:,\d+)? \+(\d+)/)
      if (hunk) {
        line = Number(hunk[1])
        return text
      }
      if (!line) return text
      if (text.startsWith('-')) return `      ${text}`
      if (text.startsWith('+') || text.startsWith(' '))
        return `${String(line++).padStart(5)} ${text}`
      return text
    })
    .join('\n')
}

function normalizeReview(review) {
  if (typeof review?.summary !== 'string' || !Array.isArray(review.comments))
    return null
  return {
    verdict: VERDICTS.includes(review.verdict) ? review.verdict : 'comment',
    summary: review.summary.trim(),
    comments: review.comments.filter(
      c =>
        typeof c?.path === 'string' &&
        Number.isInteger(c.line) &&
        c.line > 0 &&
        typeof c.body === 'string'
    ),
  }
}

function parseReview(text) {
  try {
    return normalizeReview(
      JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
    )
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
const rawDiff = (await diffRes.text())
  .split(/^(?=diff --git )/m)
  .filter(section => {
    const path = section.match(/^diff --git a\/\S+ b\/(\S+)/)?.[1] ?? ''
    return !LOCKFILES.test(path) && !EXCLUDE?.test(path)
  })
  .join('')

if (!rawDiff.trim()) {
  console.log('Only lockfiles or excluded files changed; skipping review.')
  process.exit(0)
}
if (rawDiff.length > MAX_DIFF_CHARS) {
  console.log(
    `Diff is ${rawDiff.length} characters, over the ${MAX_DIFF_CHARS} limit; skipping review.`
  )
  process.exit(0)
}
const diff = rawDiff
  .split(/^(?=diff --git )/m)
  .map(numberLines)
  .join('')

// 2. Ask the model for a review. The client reads ANTHROPIC_BASE_URL and
// ANTHROPIC_AUTH_TOKEN from the environment.
const client = new Anthropic()
const response = await client.messages.create({
  model: REVIEW_MODEL,
  max_tokens: 16000,
  system: SYSTEM_PROMPT,
  tools: [REVIEW_TOOL],
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
const toolUse = response.content.find(
  block => block.type === 'tool_use' && block.name === REVIEW_TOOL.name
)
const text = response.content
  .filter(block => block.type === 'text')
  .map(block => block.text)
  .join('')
  .trim()
// Fall back to JSON in the text, then to the text itself, for models that
// answer without calling the tool.
const review = toolUse ? normalizeReview(toolUse.input) : parseReview(text)
if (!review && !text) throw new Error('The model returned no review.')

// 3. Post it as a PR review with inline comments, then act on the verdict
let verdict = review?.verdict ?? 'comment'
if (verdict === 'close' && !ALLOW_CLOSE) verdict = 'request_changes'
if (verdict === 'request_changes' && !ALLOW_REQUEST_CHANGES) verdict = 'comment'
const event = verdict === 'comment' ? 'COMMENT' : 'REQUEST_CHANGES'

const post = payload =>
  gh(`/pulls/${PR_NUMBER}/reviews`, {
    method: 'POST',
    body: JSON.stringify({ commit_id: pr.head.sha, event, ...payload }),
  })

let res
if (!review) {
  res = await post({ body: `${HEADERS.comment}\n\n${text}` })
} else {
  const label = c => `**${c.severity ?? 'note'}**`
  const body = `${HEADERS[verdict]}\n\n${review.summary}`
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
  if (res.status === 422 && review.comments.length) {
    const list = review.comments
      .map(c => `- \`${c.path}:${c.line}\` ${label(c)}: ${c.body}`)
      .join('\n')
    res = await post({ body: `${body}\n\n${list}` })
  }
}
if (!res.ok) {
  throw new Error(`GitHub API ${res.status}: ${await res.text()}`)
}
console.log(`Posted a ${verdict} review on #${PR_NUMBER}.`)

if (verdict === 'close') {
  const closeRes = await gh(`/pulls/${PR_NUMBER}`, {
    method: 'PATCH',
    body: JSON.stringify({ state: 'closed' }),
  })
  if (!closeRes.ok) {
    throw new Error(`GitHub API ${closeRes.status}: ${await closeRes.text()}`)
  }
  console.log(`Closed #${PR_NUMBER}.`)
} else if (review?.verdict === 'comment' && BOT_LOGIN) {
  // A clean review supersedes earlier change requests from this bot, which
  // would otherwise keep blocking the PR.
  const reviews = await (
    await gh(`/pulls/${PR_NUMBER}/reviews?per_page=100`)
  ).json()
  for (const old of reviews) {
    if (old.user?.login !== BOT_LOGIN || old.state !== 'CHANGES_REQUESTED')
      continue
    const dismissRes = await gh(
      `/pulls/${PR_NUMBER}/reviews/${old.id}/dismissals`,
      {
        method: 'PUT',
        body: JSON.stringify({
          message: 'Superseded by a newer VibeCoderHans review.',
        }),
      }
    )
    console.log(`Dismissed review ${old.id}: ${dismissRes.status}`)
  }
}

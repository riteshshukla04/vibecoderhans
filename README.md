# VibeCoderHans

An AI pull request reviewer. On every pull request it sends the diff to a model through an Anthropic-compatible Messages API and posts a review with inline comments as `vibecoderhans[bot]`. It uses [Callstack Apex](https://apex.callstack.com/) by default.

## Add it to a repository

1. Install the GitHub App on the repository: https://github.com/apps/vibecoderhans/installations/new
2. Add two repository secrets under **Settings → Secrets and variables → Actions**:
   - `VIBECODERHANS_PRIVATE_KEY`: the full contents of the app's private key (`.pem`) file.
   - `CALLSTACK_AUTH_TOKEN`: your Callstack API key from https://platform.callstack.ai.
3. Add `.github/workflows/pr-review.yml`:

```yaml
name: VibeCoderHans PR review

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read

concurrency:
  group: pr-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  review:
    # Fork PRs don't receive repository secrets, so they are skipped.
    if: >-
      github.event.pull_request.draft == false &&
      github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - uses: riteshshukla04/vibecoderhans@v1
        with:
          private-key: ${{ secrets.VIBECODERHANS_PRIVATE_KEY }}
          api-key: ${{ secrets.CALLSTACK_AUTH_TOKEN }}
```

## Inputs

| Input            | Default                    | Description                                                                                                                      |
| ---------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `private-key`    | required                   | Private key of the VibeCoderHans GitHub App.                                                                                     |
| `api-key`        | required                   | API key for the model provider.                                                                                                  |
| `client-id`      | VibeCoderHans app          | Client ID of the GitHub App that posts the review. Set it to post as a different app.                                            |
| `base-url`       | `https://api.callstack.ai` | Base URL of an Anthropic-compatible Messages API.                                                                                |
| `model`          | `callstack/Apex`           | Model ID to review with.                                                                                                         |
| `instructions`   | empty                      | Extra review instructions for this repository, such as what the project is and what to focus on.                                 |
| `exclude`        | empty                      | Regular expression matched against file paths to leave out of the review, such as generated code. Lockfiles are always left out. |
| `max-diff-chars` | `400000`                   | Skip the review when the diff is longer than this many characters.                                                               |

The API key is sent as a bearer token (`Authorization: Bearer <key>`), which is what Apex expects.

## How it works

1. Fetches the pull request and its diff with a token for the GitHub App, scoped to pull requests in the current repository.
2. Removes lockfiles and paths matching `exclude`, then sends the diff to the model and asks for a JSON review.
3. Posts a review with a summary and inline comments. If GitHub rejects a comment because its line is outside the diff, the findings are listed in the review body instead. If the model doesn't return JSON, its reply is posted as written.

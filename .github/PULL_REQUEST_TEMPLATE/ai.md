<!--
This template is for Claude (or another AI agent) to follow when composing a
pull request body for this repository. It is not meant to be filled in by
hand.
-->

## Rules for the generated PR body

- Use exactly two sections, in this order: `## Summary` and `## Check List`.
  Do not add, rename, or reorder sections.
- `## Summary` is 2-4 bullet points. Focus on *why* the change was made, not
  a line-by-line restatement of the diff.
- `## Check List` is a checklist (`- [ ]` / `- [x]`) of what was actually
  verified, or what still needs verification. Use `[x]` only for checks that
  were actually run in this session.
- Title: under 70 characters, English, a plain imperative summary of the
  change. Do not prefix it with a Conventional-Commits type (`feat:`,
  `fix:`, etc.).
- Body language: English, even when the conversation with the user is in
  another language.
- End the body with the attribution footer required by the current session's
  instructions, if any. Do not hardcode a specific link or session id in this
  file — pull those values from the active session at the time the PR is
  created.
- Never include secrets, credentials, or literal file contents that were
  meant to stay local (e.g. `.env` values).

## Body skeleton

```markdown
## Summary

- <why the change was made>

## Check List

- [ ] <verification step>
```

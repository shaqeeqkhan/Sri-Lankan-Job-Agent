---
description: SriLankanJobs shortcuts - /slj jobs, /slj more, /slj why <n>, /slj cv <n>
argument-hint: jobs | more [filter] | why <n> | cv <n> | change <what>
---

Read `AGENTS.md` and `modes/_shared.md` if you have not this session. These shortcuts do exactly what the plain-English requests in AGENTS.md do; nothing here is Claude-only.

Arguments: `$ARGUMENTS`

- `jobs` (or no arguments): "find jobs for my CV". If `./slj resume status --json` shows no valid `resume.md` and `profile.yml`, run `modes/import.md` on the newest CV in `user/inbox/` first. Then `modes/scan.md`, `modes/score.md` and `modes/report.md`, without asking questions, and show the top 20.
- `more`: "more jobs" (`modes/report.md`, "More jobs"). Anything after `more` is a variant: `/slj more Kandy` → "more jobs in Kandy", `/slj more remote` → "more but only remote", `/slj more like 3` → "more like #3".
  When `next_step` says to widen with slow sources, that is `./slj jobs scan --slow` (only the on-request sources: employer ATS boards, the smaller boards, governmentjobs.lk), after a normal scan.
- `why <n>`: "why #n?" → `./slj top why <n>`, shown as it is.
- `cv <n>`: "CV for #n" → `modes/tailor.md`.
- `change <what>`: correct the inferred profile (`modes/import.md` step 7).

Anything else: treat the arguments as a plain-English request and route it with the table in AGENTS.md.

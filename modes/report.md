# Mode: report

Show the person their top 20 jobs, page through "more jobs", and explain any one score. Read `_shared.md` first. Scoring itself is `modes/score.md`.

## Showing the top 20

1. Make sure scores are in hand (`modes/score.md`: `slj match prefilter`, then `slj score save` in batches). If prefilter returns no candidates, nothing needs scoring.
2. `./slj top --json` (20 rows, `top_n`). It numbers the rows #1–#20 for today and writes `user/reports/<date>-top20.md`.
3. `./slj jobs recheck --top --json` re-checks the jobs being shown. If it closes any of them, run `./slj top --json` again: closed jobs drop out (`dropped` lists their numbers, which stay retired for the day) and the page is topped up with new numbers.
4. Write the **"How your CV reads to this market"** paragraph from `recurring_gaps` (each gap, how many of the top 20 it hits, and which numbers). Name the 1–3 gaps that recur most and what fixing each would unlock ("no cloud (AWS/Azure) in 9 of the top 20; adding real cloud work could lift about 6 jobs by a star"). Say what the CV is strong on. **Never suggest claiming something the person hasn't done.** Save it with `./slj top --summary "<paragraph>" --json`. This re-shows page 1 with the same numbers and puts the paragraph in the report file.
5. Show the report file's content in chat as it is: the header line (`## Your top 20 — <date> (scanned N open jobs from K sites)`), the running total, the paragraph, the table (`# | Fit | Role | Company | Location | Closes | Apply via | Link | Why`; **Link** opens the ad on the job site so the person can read it in full and apply), and the closing line about "CV for #2", "why #5?" and "more jobs". A ⚠️ in the Fit column means a scam signal: say what it was (`slj top why <n>`) and warn them not to pay anything or send documents.

**Always 20.** If `short_by > 0`, follow `next_step` (below) before you show a short list. Only show fewer than 20 when `next_step.step` is `exhausted`, and say how many there were.

## "More jobs" (PRD §5.4a)

"More jobs", "show 20 more", "next 20", "/slj more": run `./slj top --offset 20 --json`, then `--offset 40`, and so on. Numbers carry on from the last page (#21–#40, #41–#60), never restart, and stay valid all day, so "CV for #34" keeps working. Each new page is added to the day's report file as `## #21–#40`, and the header's running total updates ("showing 40 of 312 scored, 1,284 open").

Every `top` result has a `next_step`. Follow it automatically, and tell the person in one line which step happened:

| `next_step.step` | What to do |
| --- | --- |
| `already_scored` | Enough scored jobs for the next page. `slj top --offset <next>`; no scoring needed. |
| `score_deeper` | Run the `command` it gives (`slj match prefilter --offset … --limit 60`), score those (`modes/score.md`), then `slj top` again at the same offset. |
| `widen` | Run the `command`, score what it returns, then `slj top` again. The order is fixed: **adjacent titles** → **posted in the last 30, then 60 days** → **nearby districts and remote jobs** → **slow sources** (`slj jobs scan --slow`, which runs only the slow sources and leaves the normal scan's results as they are, then the prefilter with `--widened slow_sources`). Tell the person which widening happened ("I've widened to nearby districts and remote jobs"). |
| `exhausted` | Say how many open jobs exist in total and that every matching one has been shown. Offer to change the targets in `profile.yml`. |

## Variants

These re-rank the scored jobs not shown yet today. Nothing is re-scored. Each one adds new numbers after the last one (offset is ignored).

- "more jobs in Kandy": `slj top --district Kandy`
- "more nearby": `slj top --district nearby`
- "more but only remote": `slj top --remote`
- "more like #3": `slj top --like '#3'`

If a variant comes back short, score deeper with the same filter (`slj match prefilter --district Kandy`, `--remote`, `--like '#3'`) and run the variant again.

## "Why #5?"

`./slj top why 5` (no `--json` gives a ready Markdown table) prints the points for each dimension, each requirement with the phrase quoted from the ad and met / partial / missing, and any cap ("Capped at 2 stars: missing mandatory CIMA"). Show it as is. If it says the ad changed after scoring, the job is re-scored on the next prefilter.

## "CV for #7"

Resolve the number first: `./slj top resolve 7 --json` gives the `job_id`. The `cv` commands take that id (`modes/tailor.md`). If there is no report for today yet, run `slj top` first; numbers belong to one day.

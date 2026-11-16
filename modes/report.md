# Mode: report

Show the person their top 20 jobs, page through "more jobs", and explain any one score. Read `_shared.md` first. Scoring itself is `modes/score.md`.

## Showing the top 20

1. Make sure scoring is done (`modes/score.md`: `slj match prefilter` returns no candidates).
2. `./slj top --brief --json`. It numbers the rows #1–#20 for today, writes `user/reports/<date>-top20.md`, and returns `recurring_gaps`, `scam_rows`, `short_by` and `next_step`.
3. `./slj jobs recheck --top --json` re-checks the jobs being shown. Only if it closed any (`closed > 0`), run step 2 again: closed jobs drop out (`dropped` lists their numbers, which stay retired for the day) and the page is topped up with new numbers.
4. Write the **"How your CV reads to this market"** paragraph from `recurring_gaps` (each gap, how many of the top 20 it hits, and which numbers). Name the 1–3 gaps that recur most and what fixing each would unlock ("no cloud (AWS/Azure) in 9 of the top 20; adding real cloud work could lift about 6 jobs by a star"). Say what the CV is strong on. **Never suggest claiming something the person hasn't done.** Save it: `./slj top --brief --summary "<paragraph>" --json`. Same numbers; the paragraph goes into the report.
5. Show `page_markdown` from that result in chat **exactly as it is**: header, running total, paragraph, table (`# | Fit | Role | Company | Location | Closes | Apply via | Link | Why`) and closing line. Do not read the report file as well, and do not rebuild the table yourself. For each number in `scam_rows` (⚠️ in the Fit column), say what the signal was (`./slj top why <n>`) and warn the person not to pay anything or send documents.

**Always 20.** If `short_by > 0`, follow `next_step` (below) before you show a short list. Only show fewer than 20 when `next_step.step` is `exhausted`, and say how many there were.

Without `--brief`, `top` returns `rows` (one object per job) instead of `page_markdown`. You rarely need them.

## "More jobs" (PRD §5.4a)

"More jobs", "show 20 more", "next 20", "/slj more": run `./slj top --offset 20 --brief --json`, then `--offset 40`, and so on, and show each `page_markdown` as it is. Numbers carry on from the last page (#21–#40, #41–#60), never restart, and stay valid all day, so "CV for #34" keeps working. Each new page is added to the day's report file as `## #21–#40`, and the header's running total updates ("showing 40 of 312 scored, 1,284 open").

Every `top` result has a `next_step`. Follow it automatically, and tell the person in one line which step happened:

| `next_step.step` | What to do |
| --- | --- |
| `already_scored` | Enough scored jobs for the next page. Run the `command` it gives; no scoring needed. |
| `score_deeper` | Run the `command` it gives (`slj match prefilter --offset … --limit 60`) as the loop command in `modes/score.md` until it returns no candidates, then `slj top` again at the same offset. |
| `widen` | Run the `command`, score what it returns, then `slj top` again. The order is fixed: **adjacent titles** → **posted in the last 30, then 60 days** → **nearby districts and remote jobs** → **slow sources** (`slj jobs scan --slow`, which runs only the slow sources and leaves the normal scan's results as they are, then the prefilter with `--widened slow_sources`). Tell the person which widening happened ("I've widened to nearby districts and remote jobs"). |
| `exhausted` | Say how many open jobs exist in total and that every matching one has been shown. Offer to change the targets in `profile.yml`. |

## Variants

These re-rank the scored jobs not shown yet today. Nothing is re-scored. Each one adds new numbers after the last one (offset is ignored). Add `--brief --json` to each.

- "more jobs in Kandy": `slj top --district Kandy`
- "more nearby": `slj top --district nearby`
- "more but only remote": `slj top --remote`
- "more like #3": `slj top --like '#3'`

If a variant comes back short, score deeper with the same filter (`slj match prefilter --district Kandy`, `--remote`, `--like '#3'`) and run the variant again.

## "Why #5?"

`./slj top why 5` (no `--json` gives a ready Markdown table) prints the points for each dimension, each requirement with the phrase quoted from the ad and met / partial / missing, and any cap ("Capped at 2 stars: missing mandatory CIMA"). Show it as is. If it says the ad changed after scoring, the job is re-scored on the next prefilter.

## "CV for #7"

Resolve the number first: `./slj top resolve 7 --json` gives the `job_id`. The `cv` commands take that id (`modes/tailor.md`). If there is no report for today yet, run `slj top` first; numbers belong to one day.

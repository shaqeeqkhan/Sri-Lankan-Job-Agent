<!-- Adapted from KivancSerefoglu/resume-optimizer, skills/resume-optimizer/references/non-fabrication.md (MIT; see ../NOTICE).
     Changed: the final checklist is backed by the deterministic `slj factcheck`; harvested-link and
     private-repository items removed; Sri Lankan items (grades, referees, NIC) added. -->

# Non-Fabrication Rules — CV Validation

Read [evidence-rules.md](evidence-rules.md) first. This file covers only what is specific to writing
and validating a CV.

## Missing-metric protocol

When a number would improve a bullet but has not been provided:

1. Do not invent or estimate it.
2. Write the strongest accurate version without the number.
3. Ask for it (one question, see [branching-questions.md](branching-questions.md)), or list it under
   the "questions that would make this CV stronger" at the end.

## Final validation

Two layers, both required:

1. **Your own read.** Before running the tool, review every claim in `cv.md` against `resume.md` and
   `facts.yml`. Remove or fix:
   - unsupported metrics, amounts or percentages;
   - tools or qualifications the person never claimed, especially ones copied from the ad;
   - inflated leadership ("helped with" → "led") or seniority ("Analyst" → "Senior Analyst");
   - changed titles, months or years, or years moved from one job to another;
   - O/L or A/L grades that differ from the record;
   - referees not in the record;
   - claims of ownership where the person only supported the work;
   - the NIC number when the ad does not ask for it.
2. **The gate.** `./slj factcheck --job <id> --json`. It fails on any employer, title, date, number,
   qualification, institution, grade or tool that it cannot find in `resume.md` or `facts.yml`, and
   names the line and the nearest supported text. **A failure means fix and re-run. Never skip it, and
   never edit `resume.md` or `facts.yml` to make it pass** unless the person has just told you the fact
   and confirmed it (then use `slj facts add`). `slj cv render` refuses until the check has passed for
   the exact current `cv.md`, `resume.md` and `facts.yml`.

The tool cannot judge framing ("led" vs "helped"), so layer 1 is not optional.

Report the result in the final message: "Fact check: passed (N claims checked)", plus any claim you
removed and why. State "None" when nothing unsupported was added.

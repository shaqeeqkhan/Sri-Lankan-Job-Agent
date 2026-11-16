<!-- Adapted from KivancSerefoglu/resume-optimizer, skills/resume-optimizer/references/writing-guide.md (MIT; see ../NOTICE).
     Kept: first-glance priorities, bullet pattern, keyword emphasis limits, experience selection, character set,
     summary and skills guidance. Changed: A4; modern limit 2 pages (not 1); a traditional Sri Lankan layout with
     no page limit; cv.md Markdown instead of resume-body.html; work-authorisation rule replaced by Sri Lankan
     personal-details rules; checks are `slj factcheck` and `slj cv ats-check`, not Python scripts. -->

# Writing Guide

## First-glance priorities

Organise the CV so a recruiter can quickly find: the current or most relevant role; relevant skills;
relevant years and type of experience; the strongest supported achievements; notable employers and
qualifications; education when relevant to career level. Do not use the graduation year as a substitute
for years of professional experience.

## Bullets

Each bullet says (1) what the candidate did, (2) how, (3) why it mattered, (4) scale or outcome when supported.

Pattern: "Accomplished [supported outcome] by [specific contribution], using [relevant tool or method]."

Active verbs: Built, Prepared, Reconciled, Automated, Designed, Implemented, Led, Improved, Reduced,
Delivered, Trained, Managed, Processed, Analysed.

Use numbers only when the person supplied them. Not every bullet needs a number; never add one to fill a pattern.

Avoid: "Responsible for", "Helped with", "Worked on", "Participated in", unsupported ownership, and
bullets that only list tools.

## Keyword emphasis

Bold is how a screener's eye finds the match in six seconds, so it works only while rare:

- **Only terms the ad uses**, and only where a bullet shows the candidate really doing it.
- **At most two bold phrases per bullet, 1–4 words each; at most 10 per page.** Never a whole
  sentence, never a number on its own.
- **Only inside bullets.** Never in the name, the contact line, headings or entry lines. The Skills
  section may use `**Label:**` labels only.
- Write it as `**Power BI**` in `cv.md`.

## Two styles

Choose by job type; the person can override. `profile.yml` `cv_style` is the default, `cv.style` in
`config/settings.yml` can force one.

### Modern ATS CV (private sector, IT, multinationals, BPO)

A4, **at most 2 pages** (`cv.modern_max_pages`). One column, real text, no tables, no photos, no icons.

1. `# Name` (the contact line comes from the front matter)
2. `## Summary` — optional; for experienced, senior or career-changing candidates
3. `## Experience`
4. `## Projects` — only when relevant
5. `## Education` (degree first; A/L only for fresh graduates or when the ad asks)
6. `## Certifications` / `## Professional Qualifications` — when they exist
7. `## Skills` — `- **Technical:** …`, `- **Languages:** …`

### Traditional Sri Lankan CV (government, banks, state corporations, many SMEs)

A4, **no page limit**. Formal. Sections in this order:

1. `# Name`
2. `## Personal Details` — `- **Label:** value` lines: address, date of birth, nationality, gender,
   civil status if the person wants it. **NIC only when the ad requires it.** Never religion unless the ad asks.
3. `## Career Objective` — one or two sentences; the only place the target job title and company may appear
4. `## Educational Qualifications` — degree, then `### G.C.E. Advanced Level <year> (<stream>)` and
   `### G.C.E. Ordinary Level <year>`, each with a `| Subject | Grade |` table exactly as the record has it
5. `## Professional Qualifications` — CIMA, ACCA, AAT, CA, BCS, NVQ, diplomas, with years
6. `## Work Experience`
7. `## Computer Skills`, `## Languages`
8. `## Extra-curricular Activities` — when they exist
9. `## Referees` — **two non-related referees** from the record, numbered, with title, organisation and phone
10. `## Declaration` — optional, only if the person wants one

### Entry lines (both styles)

`### Title, Employer, City | Mon YYYY – Mon YYYY` — the part after the last ` | ` is printed on the right.
Use the months and years exactly as the record gives them; if the record has only years, write only years.

## Experience selection

Include every work experience with at least its entry line and one bullet. Omit one only when it is
clearly irrelevant — a high bar — and name every omission in the changes list.

## Character set

Write names, employers and institutions in plain English letters (`Thárushi` → `Tharushi`): some ATS
parsers mangle accents. That is a rendering choice, not a fact change. Emails and links stay exact.

## Formatting principles

Avoid: photos (unless an ad explicitly asks; then say the person must add it themselves), skill bars or
percentages, "References available upon request" (traditional CVs list the referees), clichés ("team
player", "fast learner", "results-driven"), unexplained internal acronyms, bold outside the rule above.

**Page limit (modern only).** `slj cv render` reports the page count and tightens spacing and font size
(never below 9.5 pt) when the CV runs over. If it still returns `over_limit`, cut in this order: (a) bullets
from the least relevant roles, keeping one per role; (b) projects, activities and optional education lines;
(c) only then a clearly irrelevant role. Say exactly what you cut. Never cut a fact to a misleading fragment.

## Skills section

Prioritise skills the ad asks for **that the person has**, skills shown in experience, and tools they can
discuss in an interview. Never add a tool because the ad names it. Leave out low-signal tools (Slack,
Trello) unless the ad asks.

## Summary section

Usually omit for fresh graduates when the page already says where they are heading. When used: specific,
two lines, no unsupported years of experience.

## Promotions and titles

Show verified promotions as separate roles under one employer. Never manufacture a promotion. Keep the
official title.

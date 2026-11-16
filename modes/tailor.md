# Mode: tailor

Make a tailored CV for one job: "CV for #7", "make a resume for the Dialog job", `/slj cv 7`.

Read `modes/_shared.md` first. The skill behind this mode is `.agents/skills/resume-tailor/SKILL.md`;
read it and its `references/` once per session. This file is the step-by-step version. Nothing here is
sent anywhere: the person applies themselves with the PDF you make.

## The rule that cannot bend

Every employer, title, date, number, qualification, grade, referee and tool in the CV comes from
`user/resume.md` or `user/facts.yml`. Nothing from the job ad, nothing from memory, nothing "probably
true". `slj factcheck` enforces it and `slj cv render` refuses to run until it passes.

## Steps

1. **Find the job.** For "#7": `./slj top resolve 7 --json` gives the job id. For a company name, use
   `./slj jobs list --q "<name>" --json` and confirm with the person if more than one matches. Then
   `./slj jobs get <id> --json`. If there is no `user/resume.md`, stop and run `modes/import.md` first.

2. **Gap analysis.** Read `user/resume.md`, `user/facts.yml` (`./slj facts list --json`) and, if the job
   was scored, `./slj top why 7 --json`. For each real requirement in the ad (must-haves first), mark it
   **strong / partial / missing / unknown** and quote the ad's phrase. Show the person a short table.
   Use the saved score's requirement table when there is one so the stars and this table agree.

3. **Questions — one at a time.** Follow `.agents/skills/resume-tailor/references/branching-questions.md`.
   Ask only what would change the page: numbers, scale, ownership, tools actually used, missing O/L or
   A/L details, referees for a traditional CV, the NIC only when the ad requires it. Branch on each
   answer. Stop after about 8 questions, or at once when the person says "enough".
   After each useful answer: read it back as one sentence in their words, ask "Is that right?", and only
   after a yes run
   `./slj facts add --text "<sentence>" --kind <metric|tool|scope|education|referee|personal> --confirmed --json`.
   A "no" or "I'm not sure" is not saved, and the gap stays a gap.

4. **Choose the style** and say why in one line:
   - **modern** ATS CV (A4, at most 2 pages): private sector, IT, multinationals, BPO;
   - **traditional** Sri Lankan CV (personal details, O/L and A/L tables, two non-related referees, no
     page limit): government, banks, state corporations, many SMEs.
   Default order: what the person says, then `cv.style` in `config/settings.yml` (unless `auto`), then
   `cv_style` in `user/profile.yml`, then your judgement from the job type.

5. **Write `user/output/<job-id>/cv.md`** (format below) from `resume.md` + `facts.yml` only, following
   `references/writing-guide.md` and `references/tailoring.md`. Reorder, reword, merge and cut freely;
   never change a fact inside an item.

6. **Review pass** as the hiring manager for this job (`references/reviewer-brief.md`). In Claude Code
   you may hand it to a fresh subagent; otherwise do it yourself and label it **reviewed in-context**.
   Apply only edits that add no new claim.

7. **Fact check:** `./slj factcheck --job <id> --json`. On failure, each unsupported claim comes with its
   line and the nearest supported text. Fix `cv.md` — or, if the person can confirm the fact, ask and
   `facts add` it — and run it again. **A failure means fix and re-run, never skip.** Never edit
   `resume.md` to make a check pass.

8. **Render:** `./slj cv render --job <id> --style modern|traditional --json`.
   - `status: ok` — done; it reports pages and the watermark.
   - `status: over_limit` (modern only) — spacing and font were already tightened down to 9.5 pt. Cut
     content as `guidance` says, tell the person exactly what you cut, then back to step 7.
   - `status: needs_manual_print` — no Chrome, Edge or Chromium. Give the person the `guidance` text: open
     the HTML, print to PDF, **turn off "Headers and footers"**.
   - `FACTCHECK_FAILED` — cv.md, resume.md or facts.yml changed since the last passed check: step 7.

9. **ATS check:** `./slj cv ats-check --job <id> --keywords "<the ad's must-have terms, comma separated>" --json`
   (without `--keywords` it uses the saved score). It reads the PDF's text layer for the name, email,
   phone, the keywords the CV legitimately has, the watermark, and any `file://` or home-folder path.
   Fix real failures in `cv.md` and go back to step 7. Keywords under `gaps` are honest gaps: tell the
   person, never add them.

10. **Deliver**, in this order:
    - the PDF path (and the HTML and `cv.md` paths);
    - **Changes made**: reordered, reworded toward the ad, cut (name every omitted role), bolded phrases
      and the ad phrase each mirrors, reviewer edits accepted/rejected;
    - the hiring-manager review (or "reviewed in-context");
    - fact check and ATS check results in one or two lines, gaps named plainly;
    - **up to 5 questions** that would make the CV stronger, most valuable first;
    - `Facts saved: …`;
    - a reminder of the ad's subject-line instruction and closing date, if any.

    Optional: a cover note of **150 words or fewer** in `user/output/<job-id>/cover.md`, from the same two
    sources, following the ad's subject-line instruction. It is never sent.

## cv.md format

YAML front matter, then Markdown. `slj cv render` builds HTML from it through `templates/cv-<style>.html`
and prints the PDF; nothing is ever read back from the HTML or PDF, so `cv.md` is the only file to edit.

```markdown
---
name: Nimal Perera                     # printed as the heading; also the file name
email: nimal.perera@example.com
phone: +94 77 123 4567
location: Colombo
links: [linkedin.com/in/nimalperera]   # optional, at most 6
role: Junior Data Analyst              # file name only (Nimal_Perera_Junior_Data_Analyst.pdf); never printed
style: modern                          # modern | traditional; --style overrides
---
# Nimal Perera

## Summary

Data analyst with 3 years of experience building Power BI dashboards and SQL reports.

## Experience

### Data Analyst, Ceylon Analytics (Pvt) Ltd, Colombo | Jan 2022 – Present

- Designed weekly **Power BI** sales dashboards for 12 branch managers

## Skills

- **Technical:** SQL, Power BI, Excel
```

- `### Left text | Right text`: the part after the last ` | ` (dates) is printed on the right.
- Traditional CVs: personal details as `- **Label:** value` lines; O/L and A/L results as
  `| Subject | Grade |` tables under `### G.C.E. Advanced Level <year> (<stream>)`; referees as a
  numbered list. Section order is in `references/writing-guide.md`.
- The job title and company may appear only in a `## Career Objective` section.
- No images, no raw HTML (it is stripped), no photo. Do not type the watermark: the renderer adds it.

## The watermark

Every PDF page carries a small grey footer, "Resume designed by srilankanjobs.lk" (6 pt by default, 4–6
allowed via `cv.watermark.size_pt`), inside the bottom margin. If the person does not want it, tell them
it can be switched off with `cv.watermark.enabled: false` in `config/settings.yml`. Do not change that
setting yourself unless they ask.

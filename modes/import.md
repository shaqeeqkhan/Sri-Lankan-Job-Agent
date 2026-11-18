# Mode: import

Turn the person's CV into `user/resume.md` (the source of truth) and `user/profile.yml` (what they are looking for, inferred), then go straight on to scanning. **Zero questions** in this mode: infer, say what you assumed in one line, and let the person correct it. Read `_shared.md` first.

## When

- The person drops a CV into the chat or into `user/inbox/`, gives a path, or says "here's my CV".
- `slj resume status` says `resume.exists: false`, or a scan or score command fails with `NO_RESUME` or `NO_PROFILE`.
- They send a new version of their CV (then this replaces the old one: use `--force`).

## 1. Import

```
./slj resume import <file> --json          # a path anywhere, or a file name in user/inbox/
./slj resume import --json                 # no file: the newest CV in user/inbox/
```

Accepted: `.pdf`, `.docx`, `.md`, `.txt`, `.png`, `.jpg`/`.jpeg`. An old `.doc` is refused: ask them to save it as `.docx` or PDF. If the person pasted the CV as text in the chat, write it to `user/inbox/cv.md` exactly as given and import that.

The result (`data`) has:

| Field | Meaning |
| --- | --- |
| `status` | `ok`, or `NEEDS_VISION` (a scan or a photo: see step 2). `NEEDS_VISION` is a normal result, not an error. |
| `method` | `text` (PDF text layer), `docx`, `plain` (.md/.txt) or `vision` |
| `raw_path` | `user/resume.raw.md`, the deterministic conversion. Never edit it. |
| `resume_written` | `true` when this run also wrote `user/resume.md` (first import, or `--force`). When `false` because a `resume.md` already exists and this file is the person's new CV, run again with `--force`. |
| `images` | Page images for you to read (scans and photos). For a photo it is the photo itself. |
| `two_column` | The PDF had two columns; it was read left column first, then right. Check the order in step 3. |
| `warnings`, `next_step` | Read both. Say any warning that matters to the person in plain words. |

If `picked_from_inbox` is `true`, tell the person which file you used ("I used *My CV.pdf* from your inbox").

## 2. Scans and photos (`status: NEEDS_VISION`)

The file has no text layer, so you read it yourself.

1. Open every file in `images` with your own vision (every supported agent can read images and PDFs). If `image_renderer` is `original`, `images` holds the original file: read that.
2. Write the whole CV as Markdown into `user/resume.md`, **exactly as written**: same words, same spelling, same numbers, same order. Use `#` for the name, `##` for sections, `-` for bullets, Markdown tables for O/L and A/L results. Do not fix, improve, summarise or fill in anything.
3. Where a word or number is unreadable, write `[unclear]` instead of guessing, and ask the person about those spots once you have shown the assumptions line (step 6). Never guess a date, grade, phone number or NIC.
4. If only some pages were scans (`scanned_pages`), `resume.raw.md` has the other pages: add the scanned pages' text where they belong while you clean up (step 3).
5. Run `./slj resume save --json` (step 4). There is no raw text to compare a transcription with, so the check is skipped; that makes care in point 2 essential.

## 3. Clean `resume.raw.md` into `resume.md`

On first import `resume.md` starts as a copy of `resume.raw.md`. Tidy it in place. You may:

- rejoin lines a PDF broke mid-sentence, and words split by a hyphen or a ligature ("Certi fi ed" → "Certified");
- turn bullet-like lines into `-` bullets and section titles into `##` headings (one `#`: the person's name);
- put two-column CVs in a sensible order (name and contact, summary, experience, education, skills, then the rest);
- fix a table that came out as loose lines (O/L and A/L results, personal details);
- delete conversion junk: page numbers, repeated page headers, stray `|` separators.

You may **not** add anything: no new words, skills, numbers, dates, titles or sentences, no "improved" summary, no fixed typos in names of employers, schools or qualifications. Rewording is for tailoring later (`modes/tailor.md`), not for this step. Keep personal details (NIC, date of birth, referees) as they are; they stay in `user/`.

## 4. Save and show the diff

```
./slj resume save --json
```

It compares `resume.md` with `resume.raw.md` and returns:

- `saved`: `false` when `additions` is not empty. Each addition is a line plus the words or numbers that are not in the original. Remove them. If one is a genuine correction (the PDF garbled a word and you restored it), show it to the person and, once they confirm, run `./slj resume save --accept-additions --json`.
- `dropped`: original lines that lost words. Junk you removed on purpose is fine; anything else you dropped by mistake, put back.
- `summary` and `hunks`: what changed. Show the person a short diff, two to five lines, for example:

  > I tidied the conversion of your CV: rejoined 6 broken lines, turned 14 lines into bullets, and moved Skills below Experience (your CV has two columns). Nothing was added.

Do not paste the whole CV back unless they ask.

## 5. Write `user/profile.yml`

Read `user/resume.md` and write `user/profile.yml`. Every field is an object with `value` and `inferred`. Everything you infer here is `inferred: true`. The shape (validated by `ProfileSchema` in `src/user/profile.ts`):

```yaml
name: { value: "Kavindi Senanayake", inferred: true }
target_titles: { value: ["Data Analyst", "BI Analyst"], inferred: true }          # 1 to 3
adjacent_titles: { value: ["Reporting Analyst", "Business Analyst", "MIS Executive"], inferred: true }   # 0 to 20
seniority: { value: junior, inferred: true }          # intern | junior | mid | senior | lead | manager | executive
years_experience: { value: 2.5, inferred: true }      # number, or null when the CV gives no dates
skills: { value: ["SQL", "Power BI", "DAX", "Python", "pandas", "Excel", "Tableau"], inferred: true }   # up to 200
location: { value: "Colombo", inferred: true }        # a town or district, or null
districts_ok: { value: ["Colombo", "Gampaha", "Kalutara"], inferred: true }   # up to 25 district names
work_mode: { value: hybrid, inferred: true }          # any | onsite | hybrid | remote
salary_floor: { value: null, inferred: true }         # monthly LKR; optional, leave null unless the CV states it
cv_style: { value: modern, inferred: true }           # modern | traditional
```

How to infer each field:

- **target_titles**: the job they are doing now or most recently, in the words Sri Lankan ads use, plus one close variant ("Software Engineer", "Backend Engineer"). If the CV states an objective ("seeking a position as an Assistant Accountant"), that title comes first. For a fresh graduate, use the degree's usual entry roles ("Trainee Accountant", "Associate Software Engineer"). At most 3.
- **adjacent_titles**: roles one step sideways that the same CV could win ("Accounts Executive", "Audit Trainee" for an AAT finalist). 3 to 8 is right. Do not list stretch roles (no "Finance Manager" for a clerk).
- **seniority**: from total years and the latest title. Rough guide: intern (still studying), junior (0–2 years, or "Associate"/"Trainee"/"Assistant"), mid (2–5), senior (5–8, or "Senior …"), lead (team lead), manager (manages people or a function), executive (head of, director, GM). "Executive" in Sri Lankan job titles (Sales Executive, HR Executive) is usually **mid** level, not executive.
- **years_experience**: add up paid work from the dates in the CV (overlaps once; internships count half; today is the end of "Present"). Round to the nearest half year. `null` if there are no dates.
- **skills**: tools, methods and qualifications that appear in the CV, in its own words (Sage 50, SAP, Power BI, AAT, NVQ Level 4, EPF/ETF returns). Hard skills first. Do not add skills the CV does not name.
- **location**: the town in their address or contact line ("Nugegoda" or "Colombo"). Use the district name when you are not sure the town is well known.
- **districts_ok**: their district plus neighbouring districts within a normal commute (Colombo ↔ Gampaha, Kalutara; Kandy ↔ Matale; Galle ↔ Matara). Use the 25 district names. If the CV says "willing to relocate", leave it to the home district and adjacent ones anyway; the person can widen it.
- **work_mode**: what the CV says ("hybrid preferred"); otherwise `any` for IT, data and design roles, and `onsite` for roles that are done on site (factory, hotel, bank branch, retail, driver, nursing).
- **cv_style**: `traditional` when the CV has personal details (NIC, date of birth, civil status), O/L and A/L results or referees, or targets government, banking or SME jobs; otherwise `modern`.
- **name**: as written at the top of the CV.

## 6. Check, say the assumptions, and move on

```
./slj profile check --json
```

If `valid` is `false`, fix every item in `problems` and run it again. When it is valid, show the assumptions from `summary` as a short table, then the closing line, for example:

> I've assumed the following:
>
> | What | Assumed |
> | --- | --- |
> | Roles | Junior Data Analyst, BI Analyst |
> | Location | Colombo (or Gampaha, Kalutara) |
> | Work mode | Hybrid OK |
> | Experience | About 2.5 years |
> | CV style | Modern |
>
> Say "change" to fix any of that. Scanning now.

Mention a `warnings` item only if it changes what they will see (for example, no location). Then go straight on to scanning (`modes/scan.md`) **without waiting for an answer**. Do not ask "is that right?".

## 7. When the person says "change"

They may answer at any point, even mid-scan ("I want remote only", "not Kandy, Colombo", "I'm aiming for team lead now").

- Edit only the fields they mentioned, set each one's `inferred: false`, and leave the rest as they are. A field the person stated is never overwritten by inference again, even after a new CV import.
- Run `./slj profile check --json` and show the updated assumptions table (same columns as step 6).
- If titles, seniority, location, districts or work mode changed, the earlier ranking no longer fits: re-run matching (`modes/score.md`) and the top 20 (`modes/report.md`). Changing only `cv_style` or `salary_floor` needs no re-score.

## Rules for this mode

- `resume.md` is the only CV text later steps use. Anything not in it (or later confirmed into `facts.yml`) cannot appear in a tailored CV.
- Never write to `user/slj.db`, and never edit `resume.raw.md`.
- Never send the CV, or any part of it, to a website or a search.

# SriLankanJobs Agent

Give your CV to the AI coding tool you already use, and it shows you the 20 current Sri Lankan job ads that fit you best, each rated 1 to 5 stars with a one-line reason. Say "CV for #7" and it writes a CV tailored to that job, using only facts from your own CV and your answers, and saves it as a PDF.

It is a folder of instructions plus a small command-line tool (`slj`). Your AI tool does the reading and writing; `slj` reads the job sites, keeps the job list, checks facts and prints the PDF. Everything runs on your computer. MIT licence.

## What you need

- **Node.js 22.18 or newer** ([nodejs.org](https://nodejs.org); `.nvmrc` pins 22.18.0).
- **One AI coding tool** that can read this folder and run commands in it: Claude Code (also as the extension in Cursor or VS Code), Codex CLI or the Codex IDE extension, Gemini CLI, Cursor in Agent mode, VS Code with Copilot agent mode, Windsurf, or OpenCode. Your own subscription to it pays for the "thinking"; this project has no API keys or accounts.
- **Google Chrome or Microsoft Edge**, for printing the CV to PDF and for job sites that only load in a browser. Without one, you get an HTML file to print yourself.
- `git`, to download the folder.

## Install

Copy the repository URL from the green **Code** button on its GitHub page, then:

```sh
git clone <repository URL> srilankanjobs
cd srilankanjobs
npm install
./slj doctor            # Windows: slj.cmd doctor
```

`doctor` checks Node, the database, the settings and the agent files, and creates the `user/` folder where your data lives. (A one-line `npx srilankanjobs init` installer is planned but not published yet.)

## Use it

Open your AI tool **in this folder** and say:

1. **"Find jobs for my CV"**, after putting your CV (PDF, Word, or a photo of a printed CV) in `user/inbox/`, or drag it into the chat. It reads the CV, tells you in one line what it assumed you are looking for ("junior Data Analyst or BI roles in Colombo, hybrid OK; say 'change' to fix that"), scans the job sites and shows your top 20. It asks no questions first. The first scan of the main sites takes just under 3 minutes and stores roughly 480 jobs (482 when measured on 15 Nov 2026); each later scan fetches the next batch of new ones, so the pool grows over the first few scans. Scoring adds a few minutes on top.
2. **"More jobs"** for the next 20 (#21–#40, and so on). Also "more jobs in Kandy", "more but only remote", "more like #3", and "why #5?" for the full breakdown of one score.
3. **"CV for #7"**. It compares your CV with that ad, asks you a few questions one at a time (numbers, tools you actually used, O/L and A/L results for a traditional CV), and saves a PDF in `user/output/<job>/`. You apply yourself, through the channel the ad gives.

Say **"change …"** at any time ("remote only", "I'm aiming for team lead") to correct what it assumed. In Claude Code, `/slj jobs`, `/slj more`, `/slj why 5` and `/slj cv 7` are shortcuts for the same things.

A report looks like this (from a test CV; companies and numbers are made up):

```markdown
## Your top 20 — 15 Nov 2026 (scanned 1,284 open jobs from 6 sites)

**How your CV reads to this market:** strong on SQL and Power BI; the gap that costs you most is
no cloud (AWS/Azure) in 9 of the top 20.

| # | Fit | Role | Company | Location | Closes | Apply via | Link | Why |
|---|-----|------|---------|----------|--------|-----------|------|-----|
| 1 | ★★★★★ | Data Analyst | Example Telco PLC | Colombo 02 | 22 Nov | xpress.jobs | [View ad](https://…) | 5/5 must-haves, SQL + Power BI named |
| 2 | ★★★★☆ | BI Developer | Example IT (Pvt) Ltd | Colombo | 30 Nov | Workday | [View ad](https://…) | Meets all but SSIS (partial) |
| … |
| 20 | ★★☆☆☆ | Analytics Executive | … | Kandy | 25 Nov | ikman.lk | [View ad](https://…) | Outside your districts; 2 gaps |

Say "CV for #2" to get a tailored CV, "why #5?" for the full breakdown, or "more jobs" for the next 20.
```

Stars are absolute, not curved. If your CV is a weak match for what is advertised right now, you will see mostly ★★, with the gaps that cost the most named. It never suggests claiming something you have not done.

### Which AI model to use, and what a run costs

It is written to work on mid-size models, so you do not need the largest one your tool offers. In Claude Code, **Sonnet** is the recommended setting (`/model sonnet`); the equivalent tier in other tools (not the smallest "mini" or "flash-lite" model) should do too, though only Claude Code has been tried. Whatever you pick must be able to read images, or the picture-only ads are skipped.

Most of the usage is in rating jobs: your AI tool reads 60 ads against your CV. Roughly, for a first run:

| Step | Share of the usage |
| --- | --- |
| Reading your CV and working out what you want | small |
| Scanning the job sites | almost none (the `slj` tool does it) |
| Rating 60 jobs | most of it; picture-only ads cost the most, because the tool has to read each picture |
| Showing the top 20, "more jobs", "why #5?" | small |
| A tailored CV | medium, per CV |

To spend less:

- Run it again the same day or the next: only new or changed ads are rated, so later runs are much cheaper than the first.
- Set `prefilter_n: 40` in `config/settings.yml` to rate 40 jobs instead of 60 (about a third less; a good job ranked 41–60 can be missed until you say "more jobs").
- Start a new chat for each tailored CV instead of continuing a long one.
- In Claude Code, rating can run in a separate worker (`.claude/agents/slj-scorer.md`, on Sonnet) so the ads stay out of your main chat. This matters most if your main chat uses a larger model. Edit the `model:` line in that file to change it.

### Running it without a chat window

Claude Code can run the same flow headless, for example:

```sh
claude -p "Import user/inbox/cv.pdf and show me my top 20 jobs" --allowedTools "Bash(./slj:*)" "Read" "Write" "Edit"
```

Other CLIs have similar modes (`codex exec`, `gemini -p`). Only Claude Code's has been tried (see Status).

## Which sites it reads

From `config/sources.yml`, checked live on 15 Nov 2026:

| | Sites |
| --- | --- |
| Every scan | XpressJobs, topjobs.lk, ikmanJOBS, HotJobs.lk, JobEka.lk, Rooster |
| On request ("more jobs", once the main sites run out; `slj jobs scan --slow`) | ITPro.lk, dreamjobs.lk, governmentjobs.lk, and employer career sites on Workday, Greenhouse, Lever and SmartRecruiters that advertise Sri Lanka roles (`config/boards.json`) |
| Switched off | Careers360.lk (redirects to HotJobs), jobber.lk (server down), JobsNet.lk (no job site there), Ashby boards (none with Sri Lanka roles yet) |
| Never read automatically | LinkedIn, Facebook, WhatsApp. Paste the link or text, or send a screenshot, and it adds that one job |

Overseas postings are left out. Many topjobs.lk and governmentjobs.lk ads are a single picture; your AI tool reads the picture and writes down what it says before rating the job, so a tool that cannot see images will skip those. You can always add a job yourself: paste a link, the ad's text, a PDF, or a photo of a newspaper ad.

## Privacy

- No backend, no accounts, no telemetry. Nothing is uploaded to this project's authors.
- Your CV, profile, answers, reports and PDFs stay in `user/` on your computer. That folder is git-ignored.
- Network traffic goes only to the job sites (to read listings) and to your own AI provider (which reads your CV and the ads as part of your conversation, under that provider's terms).
- Nothing is ever sent to an employer, emailed or submitted. There is no apply step.

## How it reads the job sites

Said plainly, so you can decide whether you are comfortable with it:

- It reads **public job listings** from your own computer and your own internet connection, the way a browser would.
- It is **paced**: one page at a time per site, at least 1.5 seconds apart (0.5 seconds for employers' career-site APIs), with listings cached for 6 hours and job pages for 24.
- It does **not consult robots.txt**.
- If a site shows a "verify you are human" check, a Chrome window opens and **you** decide whether to complete it. Your AI tool tells you, along with the downsides: more scans make checks or a block more likely; a block affects your whole connection, including others who share it; an account signed in to that site can be flagged. After two checks on one site in a run, it stops reading that site.
- There is **no CAPTCHA solving, no proxies, no stealth or fingerprint tricks, no signing in, and no parallel requests to one site**, anywhere in the code. Anyone can read it to check.
- Sites' terms of use vary and some may not allow automated reading. **Use it at your own risk.**

## The watermark

Every PDF page carries a small grey footer: *"Resume designed by srilankanjobs.lk"*, 6 pt, inside the bottom margin, so it never pushes your CV onto another page.

- **Turn it off:** in `config/settings.yml`, set `cv.watermark.enabled: false`.
- **Make it smaller:** set `cv.watermark.size_pt` to 4 or 5 (allowed: 4–6). Below 6 pt some printers and CV-reading software drop it.

## Several people on one computer

Helpers (a sibling, a career unit, a mentor) can keep one data folder per person with `SLJ_HOME`:

```sh
SLJ_HOME=~/slj-people/nimal ./slj doctor          # macOS / Linux, then start your AI tool from the same shell
set SLJ_HOME=C:\slj-people\nimal                   # Windows (cmd), then start your AI tool
```

Start the AI tool from the shell where `SLJ_HOME` is set, so every `slj` command it runs uses that person's folder.

## Troubleshooting

- `./slj doctor` checks the install and says what to fix.
- `./slj sources doctor` shows how each job site did in recent scans. `truncated` means a site had more new jobs than one scan fetches; the rest come in on the next scans, which is normal on a first run. `low` means a site returned far fewer jobs than usual (0, or under 30% of its recent median): treat it as broken, not as a quiet day. If one keeps failing or stays low, `./slj sources doctor --report` prints a bug report with no personal data in it; paste it into a new issue on GitHub using the **Broken job site** template.
- **Windows:** `.claude/skills` is a symbolic link. If Git did not create it (symlinks off), Claude Code will not see the skills; everything still works through `AGENTS.md`. To fix it, enable Developer Mode, run `git config --global core.symlinks true`, and clone again.

## Status

Honest state on 15 Nov 2026:

- **Verified:** the code type-checks and its test suite passes (parsers are tested against trimmed real pages; the CV renderer against fixture CVs); each enabled site was scanned live on 15 Nov 2026; every `slj` command in the flow (import, scan, prefilter, score, top 20, more jobs, fact check, PDF) has been run in order against live data on macOS, with the scores and the CV written by hand. A fresh agent following `AGENTS.md` from start to finish has not been run yet.
- **Not verified yet:** Codex, Gemini CLI, Cursor, Copilot, Windsurf and OpenCode (the instructions are written for them; nobody has run the whole flow there); **Windows** (untested); the **human-check handoff** against a real site with a person solving the check (it has been exercised through `jobs scan` only against a local fake check page that cleared itself); and **star accuracy**: the goal is to be within one star of a recruiter's rating for 85% of jobs, but it has not been measured against a recruiter yet (`slj match eval` is there for that).
- Sites change their pages. Expect a site to break now and then; `sources doctor --report` and an issue is the fix.

## For developers

- Instructions for AI agents: [AGENTS.md](AGENTS.md). Step prompts: [`modes/`](modes/). Spec: [docs/PRD-v2-resume-to-jobs.md](docs/PRD-v2-resume-to-jobs.md).
- Adding or fixing a job site: [CONTRIBUTING.md](CONTRIBUTING.md).
- `./slj commands --json` lists every command with its JSON schema; `./slj mcp` serves the same commands as MCP tools (configs: `.mcp.json`, `.codex/config.toml`, `.gemini/settings.json`, `opencode.json`).
- `npm test` and `npm run typecheck`. Node runs the TypeScript directly; there is no build step.

Licence: [MIT](LICENSE). The CV-tailoring skill in `.agents/skills/resume-tailor/` is adapted from two MIT-licensed projects; see its [NOTICE](.agents/skills/resume-tailor/NOTICE).

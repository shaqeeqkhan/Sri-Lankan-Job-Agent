# resume-tailor skill

Tailors the person's CV to one job: gap analysis, branching questions, `cv.md`, hiring-manager review,
`slj factcheck`, `slj cv render`, `slj cv ats-check`. Start at `SKILL.md`; the agent workflow is
`modes/tailor.md`.

This is **vendored and adapted**, not original: the base is
[KivancSerefoglu/resume-optimizer](https://github.com/KivancSerefoglu/resume-optimizer) (MIT) and the
interview patterns come from [varunr89/resume-tailoring-skill](https://github.com/varunr89/resume-tailoring-skill)
(MIT). Both were fetched on 15 Nov 2026; the commits, the files taken, both licences and the full list of
changes are in [NOTICE](NOTICE). Each adapted file starts with a comment saying what it came from and what changed.

It works in any agent. Nothing on the required path needs Claude Code; a reviewer subagent is optional.

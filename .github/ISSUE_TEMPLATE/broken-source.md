---
name: Broken job site
about: A job site returns no jobs, too few jobs, or errors
title: "[source] <site id>: <what goes wrong>"
labels: source
---

**Which site?** (the source id from `config/sources.yml`, e.g. `ikman`)

**What did you see?** (e.g. "0 jobs from topjobs for two scans", "xpressjobs says partial")

**`slj sources doctor --report` output**

Run this from the project folder and paste the Markdown it prints. It contains no personal data.

```sh
./slj sources doctor --report            # Windows: slj.cmd sources doctor --report
./slj sources doctor --report --source <site id>
```

<!-- paste here -->

**Anything else?** Your OS, and whether the site loads normally in your own browser.

Please do **not** paste anything from your `user/` folder (your CV, profile, reports or scan logs).

# CV templates

| File | Use |
| --- | --- |
| `cv-modern.html` | Modern ATS CV, A4, at most `cv.modern_max_pages` pages (default 2). Private sector and IT. One column, no tables, no images |
| `cv-traditional.html` | Traditional Sri Lankan CV: personal details, O/L and A/L result tables, two non-related referees. No page limit |

`slj cv render` fills them from `user/output/<job-id>/cv.md` (format in `modes/tailor.md`). Do not fill them by hand.

The PDF footer on every page reads *"Resume designed by srilankanjobs.lk"* at `cv.watermark.size_pt` (4–6, default 6) in grey,
inside the bottom margin. `cv.watermark.enabled: false` in `config/settings.yml` turns it off; the code is open source and the switch
is there on purpose. Chrome is always given an empty header template so it never prints the date, the page title or a local
`file://` path.

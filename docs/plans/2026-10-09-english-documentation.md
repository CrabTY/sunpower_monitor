# English documentation and code cleanup

**Goal:** Use English for maintained documentation and code while preserving the website's bilingual content and accessible interactions.

**Scope:** Translate the CT calibration and local-preview guides; update documentation labels. Introduction checks should read translated labels from existing website content rather than duplicate Chinese literals in test code. Website copy, language controls and localized display labels remain bilingual. The CT illustrations already use English labels.

**Validation:** Scan tracked UTF-8 source for Han ideographs using explicit Unicode ranges, check documentation links, and run the existing web/render/preview/site checks. Preserve diagrams, calibration formulas, source credits and comparison data. Generated knowledge-graph labels must match the translated source.

**Exclusions:** Bilingual website copy, private household files, third-party checkouts and Git history are not translation targets. No collector or cloud data migration is required.

**Result:** Both guides are translated, index labels updated, and test titles read from the existing bilingual website. Preview interaction/route tests and documentation-link/source-language checks passed. The bilingual website now explains optional Bark setup and its limits, credits Bark and PyPVS, and distinguishes hardware verification from compatibility candidates. The CT guide link identifies the English document; illustrations are unchanged. Changes are grouped into documentation, website, and SQL graph setup commits for reviewed integration and GitHub Pages publication.

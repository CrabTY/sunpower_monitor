## Repository

- Canonical repository: `CrabTY/sunpower-monitor` at https://github.com/CrabTY/sunpower-monitor.
- Introduction and simulated demo: https://crabty.github.io/sunpower-monitor/ and its `demo/` path; source in `site/` and `web/`, generated output in ignored `dist/site/`.
- Documentation starts at `docs/README.md`; see `docs/project-layout.md` for directories, `CONTRIBUTING.md` for local checks, and `docs/operations.md` for deployment and releases.
- Naming changes must reach repository/Pages links, installer source downloads, release metadata and workflow guards, documentation and related checks. Runtime service and image names already use `sunpower-monitor`.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- Enable the shared push hook with `git config --local core.hooksPath .githooks`. Only pushes targeting `main` check the graph; commits and feature-branch pushes do not rebuild it.
- After integrating changes into main, the push hook runs an AST-only update against the exact commit being pushed. If the graph changes, it writes the three results in that worktree and stops the push. Commit those results, then retry. It does not automatically commit, stage, or amend anything, and refuses to overwrite existing graph edits.

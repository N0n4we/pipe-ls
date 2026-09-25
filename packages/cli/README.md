# @pipe-ls/cli

Read-only static checks for convention-based Bash + jq scripts and GitHub Actions.
Requires Node.js 22.13 or later.

Once published to npm:

```sh
pnpm add -g @pipe-ls/cli
pipe-ls check [--json] [paths...]
pipe-ls --version
```

The project root is the nearest ancestor containing `.github/`. With no paths,
the CLI checks discoverable Bash and workflow units in the current project.
Exit status is 0 only for a complete check with no diagnostics, 1 for an
incomplete check or diagnostics, and 2 for usage/discovery errors. JSON output
includes `complete`, diagnostics and conservative effect summaries.

The CLI never executes project scripts, workflows, git/gh or deployment
commands. It supports a documented subset of Bash/jq/GitHub Actions; unknown
syntax, unproven effects and missing dependencies block a passing result. It
does not provide an LSP or editor integration. See the repository README for
current scope and limitations.

MIT licensed. See `LICENSE` and `THIRD_PARTY_NOTICES.md`.

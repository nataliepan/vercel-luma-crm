Usage: /update-docs-and-commit [optional commit message or description]

What it does:
1. Analyzes git changes (status + diff)
2. Updates docs/CHANGELOG.md — adds entries for new features/fixes
3. Updates docs/architecture.md — only if structural changes occurred (schema, data flow, rendering strategy, stack)
4. Updates docs/project_status.md — moves completed items, updates what's next, notes any blockers
5. Stages and commits all changes

## Steps

1. Run `git diff` and `git status` to understand the full scope of changes

2. Update `docs/CHANGELOG.md` — add an entry under `[Unreleased]` with the appropriate category:
   - `### Added` — new features or files
   - `### Changed` — changes to existing functionality
   - `### Fixed` — bug fixes

3. If schema, data flow, rendering strategy, or stack changed — update `docs/architecture.md`

4. Update `docs/project_status.md`:
   - Move newly completed items to the Completed section
   - Update In Progress
   - Update Up Next to reflect the current build order
   - Note any new blockers or decisions needed

5. Stage all changes: `git add -A`

6. Commit using the provided message or generate one from the diff:
   ```
   <type>: <short description>

   Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
   ```
   Types: `feat`, `fix`, `refactor`, `docs`, `chore`

7. Confirm with `git log --oneline -3`

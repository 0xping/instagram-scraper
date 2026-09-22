# Repository Guidelines

## Project structure and module organization

This is a Node.js and TypeScript CLI. `src/cli.ts` handles commands; `src/config.ts`, `src/db.ts`, `src/paths.ts`, and `src/logger.ts` hold configuration, SQLite access, directory setup, and logging. Add schema changes as numbered files in `migrations/`, such as `002_add_field.sql`. `competitors.txt` is the username input (`npm run competitors:import`, `npm run competitors:list`); `src/competitors.ts` normalizes it. The source PDF is reference material, not application code. `data/raw/` holds the collector database and future media; `data/derived/` is reserved for later AI output. `dist/`, `data/`, and `.env` are ignored by Git.

## Build, test, and development commands

Use Node.js 22.13 or newer. Run `npm install` to install dependencies, then copy `.env.example` to `.env` if you need local settings. `npm run dev -- init` compiles the CLI, creates data directories, applies migrations, and registers usernames. `npm run dev -- status` reports saved counts. `npm run build` writes JavaScript to `dist/`; `npm start -- status` runs that build. Before submitting changes, run `npm run typecheck` and `npm run lint`.

## Coding style and naming conventions

Use two-space indentation, TypeScript strict types, and explicit `.js` suffixes in relative imports. Follow the existing camelCase names in TypeScript and snake_case names in SQL. Keep CLI commands small and put database changes in migrations. ESLint uses `eslint.config.js`; TypeScript settings live in `tsconfig.json`. Add a new migration rather than changing one already applied to a dataset.

## Testing guidelines

There is no test framework, test script, or coverage threshold yet. For current changes, run typecheck, lint, build, and a CLI smoke check with `init` and `status`. When adding collection behavior, put focused `*.test.ts` files in `tests/` and add a documented `npm test` script. Verify that rerunning a stage does not duplicate completed work.

## Commit and pull request guidelines

This checkout has no accessible Git history, so no existing commit convention can be verified. Use short, imperative commit subjects, such as `feat: add post discovery checkpoint`. In pull requests, describe the behavior, commands run, and any migration or data format change. Include CLI output for command changes; screenshots are unnecessary for this CLI.

## Collection boundaries

Keep browser extraction separate from AI analysis. Preserve source observations and collection timestamps under `data/raw/`; write derived results only under `data/derived/`. Collect only content available to the browser session. Stop at CAPTCHA, private-account restrictions, authentication challenges, or other access controls.

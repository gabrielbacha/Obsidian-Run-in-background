# Contributing

Thanks for helping improve Run in Background.

## Development setup

Requirements:

- Node.js 22 or newer
- pnpm 11.20.0
- A separate Obsidian development vault

Install dependencies and run the checks:

```sh
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

The production build writes `main.js` to the repository root. Copy or symlink
the repository into `<vault>/.obsidian/plugins/run-in-background/`, reload
Obsidian, and enable the plugin for manual testing.

## Pull requests

- Keep changes focused and describe the user-visible behavior.
- Add or update tests for lifecycle, migration, and icon-composition changes.
- Preserve clean shutdown during logout, restart, and operating-system shutdown.
- Run every command above and `git diff --check` before opening a pull request.

## Releases

1. Update the version in `manifest.json` and `package.json`.
2. Add the same version and minimum Obsidian version to `versions.json`.
3. Commit the release changes.
4. Create and push a tag exactly matching the version, without a `v` prefix.

```sh
git tag -a 1.0.0 -m "1.0.0"
git push origin main 1.0.0
```

The release workflow verifies the tag, runs all checks, builds and attests the
release assets, and publishes `main.js` and `manifest.json` to GitHub Releases.

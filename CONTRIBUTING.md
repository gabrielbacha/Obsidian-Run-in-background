# Contributing

Thanks for helping improve Run in Background.

## Development setup

Requirements:

- Node.js 22 or newer
- pnpm 11.20.0
- A separate Obsidian development vault

Install dependencies and run the checks:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm validate
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

Pull requests and branch pushes run these checks without publishing. Tests execute
the production-minified coordinator with deferred saves, failed tray setup,
late callbacks, two-process registration and the real D-Bus method adapter.

Optional native acceptance uses only generated profiles and synthetic vaults:

```sh
OBSIDIAN_EXECUTABLE=/path/to/Obsidian \
OBSIDIAN_ASAR=/path/to/obsidian-version.asar \
RUN_BACKGROUND_PLAYWRIGHT_PACKAGE=/path/to/package-with-playwright/package.json \
node scripts/obsidian-native.mjs
```

The script checks executable, native user-data path, vault path and release hashes
before UI actions. It proves the chooser identity, icon pixels and input focus on
that host version. Linux panel/portal and Windows host checks remain separate. It
does not read an installed profile, register OS startup, or publish a release.

The release workflow verifies the tag, runs all checks, builds and attests the
release assets, and publishes `main.js` and `manifest.json` to GitHub Releases.

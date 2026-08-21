# Update Checker

Obsidian dashboard for plugins distributed **outside** the community
marketplace: per-plugin installed version vs latest GitHub release, and a
one-button update that pulls release assets via the GitHub CLI.

Built for teams shipping private or pre-marketplace plugins to a small
fleet of vaults — the niche BRAT covers, minus token management: auth is
whatever your `gh` login already has access to, so private repos work with
zero extra setup.

## How it works

- A **registry** (plugin settings, `data.json` key `registry`) lists managed
  plugins: `{id, name, repo, assets, nativeDeps?, reloadNote?}`.
- The dashboard reads each plugin's installed `manifest.json` version and the
  repo's latest release tag (`gh api repos/<repo>/releases/latest`).
- **Update** runs `gh release download` for the configured asset names into
  the plugin folder, then offers an explicit **Reload plugin** button —
  nothing reloads without the user choosing the moment.
- Updates only ever write the configured assets; anything else in the plugin
  folder (e.g. `node_modules` native runtimes) is left untouched.

## Requirements

- Obsidian desktop (Windows-tested; `gh` path fallback is Windows-specific)
- [GitHub CLI](https://cli.github.com/) installed and authenticated
  (`gh auth login`) with read access to the registry repos

## Security

See [SECURITY.md](SECURITY.md) — the checker fetches exactly one remote field
(the release tag), spawns `gh` via execFile with no remote strings in argv,
and renders remote text as text nodes only.

## Install / update via Update Checker (recommended)

1. GitHub CLI installed and signed in (`gh auth login`) with read access to this repo.
2. In Obsidian open **Update Checker**; this plugin appears with installed version vs latest release.
3. **Update** downloads the release assets into `.obsidian/plugins/update-checker/`; press **Reload plugin** when ready.

## Install / update by hand

Download the assets from the latest release into `.obsidian/plugins/update-checker/` and reload the plugin. Verify against `release-manifest.json` if you want to check the download.

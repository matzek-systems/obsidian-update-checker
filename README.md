# Update Checker

This repository carries **releases only** for the `update-checker` Obsidian plugin. Each release ships `main.js`, `manifest.json` (and `styles.css` where the plugin has one), plus `release-manifest.json` with the sha256 of every asset.

## Install / update via Update Checker (recommended)

1. GitHub CLI installed and signed in (`gh auth login`) with read access to this repo.
2. In Obsidian open **Update Checker**; this plugin appears with installed version vs latest release.
3. **Update** downloads the release assets into `.obsidian/plugins/update-checker/`; press **Reload plugin** when ready.

## Install / update by hand

Download the assets from the latest release into `.obsidian/plugins/update-checker/` and reload the plugin. Verify against `release-manifest.json` if you want to check the download.

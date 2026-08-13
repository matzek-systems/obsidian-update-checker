# Plugin Depot — security model

Audited 2026-08-12 (v0.1.1). Re-run this checklist before any public release
and after any change that touches remote data or process spawning.

## Trust boundaries

The depot sits between three parties: the **local user config** (trusted),
**GitHub-hosted release data** (untrusted content, authenticated transport),
and the **gh CLI** (trusted local binary carrying the user's own auth).

## Surfaces audited

### 1. Remote text → prompt injection (LLM consumers)

Repo comments, issues, discussions, release notes, and READMEs are
attacker-writable or maintainer-writable remote text. Any LLM (e.g. a Claude
session driving Obsidian or reading its logs) that ingests such text can be
prompt-injected by it.

**Posture: the depot fetches exactly one remote field — the release
`tag_name`.** No release notes, no descriptions, no comments, no READMEs.
The tag is only semver-compared and rendered as a DOM text node.

Standing rule: a future feature that surfaces richer remote text (e.g.
showing release notes before update) MUST (a) render it as plain text nodes
only, and (b) be treated as untrusted data by any LLM consumer — labeled as
such wherever it lands in logs or UI. Update this file when that surface is
added.

### 2. Remote text → command injection

No remote-controlled string is ever placed in a command line. Every `gh`
argv element comes from the local registry config (repo slug, asset names,
plugin id) or literal flags. Updates download the *latest* release without
passing a tag argument at all. `execFile` is used exclusively — no shell,
no interpolation, `windowsHide: true`.

### 3. Remote text → DOM injection

All rendering uses Obsidian `createEl`/`createDiv` with `text:` (text
nodes). `innerHTML`/`outerHTML` are banned in this codebase. gh error
output is length-clipped and rendered as text.

### 4. Malicious release assets / path traversal

Downloads are restricted by `-p <name>` allowlist patterns taken from local
config — unexpected assets in a release are simply not downloaded. GitHub
asset names cannot contain path separators, and `gh release download -D`
confines writes to the target plugin directory.

### 5. Supply-chain root risk (inherent, shared with BRAT/marketplace)

What the depot installs is executable plugin code: a compromised repo or
release equals code execution inside Obsidian. This is the trust model of
every plugin updater. Mitigations: the registry is local user config (there
is no remote registry to poison); repos should restrict release-publishing
rights. Planned hardening: verify downloaded assets against per-release
sha256 manifests before activation, and version pinning/rollback.

### 6. gh binary resolution

Resolved from the standard install path (`C:\Program Files\GitHub CLI`) or
PATH. A PATH-hijacked `gh` implies the machine is already compromised —
out of scope.

### 7. Self-update

The depot downloads its own updates but refuses to hot-reload itself; the
user reloads it manually. No code path exec()s downloaded content — Obsidian
loads it on plugin reload like any plugin.

## Edge cases verified

- Repo with no releases → "no releases", no crash.
- gh unauthenticated → labeled error, no retry loop.
- Non-semver tag → parses to zeros, worst case a wrong compare, never code.
- Asset missing from a release → gh error surfaced as clipped text.
- Output bounded by `maxBuffer` (10MB).

## Pre-open-source gate

- [ ] Re-run this audit against the diff since v0.1.1.
- [ ] Run an independent security review pass (fresh eyes, not the author).
- [ ] Decide DEFAULT_REGISTRY for the public build (empty vs. commented example).
- [ ] Confirm README documents the supply-chain trust model honestly.

# Aegis Extension Store — publish for free

The store has two shelves:

1. **Built-in** — the curated extensions shipped in `extensions/` (offline, reviewed).
2. **Community** — anything listed in [`index.json`](index.json), served from this
   public GitHub repo. Installing a community extension downloads its `.zip`,
   checks its **SHA-256**, unpacks it, and loads it as a real Chrome MV3
   extension in the browsing session.

There is **no fee, no developer account, and no central server**. GitHub hosts the
catalog and (optionally) your package for free.

## Publish your extension (3 steps, $0)

1. **Build a package in the app.**
   Open **🧩 → Publish yours — free**, choose your extension folder, fill in the
   author/category, and click **Build .zip + submission**. Aegis writes
   `<name>-<version>.zip`, computes its SHA-256, and generates the catalog entry.

2. **Host the `.zip` somewhere public (free).**
   The easiest option is a GitHub Release in your own repo:
   * create a release, attach the `.zip`, copy the asset URL
     (`https://github.com/<you>/<repo>/releases/download/v1.0.0/<name>.zip`).
   Any static host that serves HTTPS works too.

3. **Submit the catalog entry.**
   Paste the public `.zip` URL into the Publish form (or edit the generated
   JSON), then click **Submit on GitHub**. That opens a prefilled issue in this
   repo. Attach the `.zip` if you like, and a maintainer will add your entry to
   `index.json` (or open a PR yourself).

Once merged, every Aegis user sees your extension under **Community** after
clicking **↻ Refresh community**.

## Entry format

```json
{
  "id": "my-extension",
  "name": "My Extension",
  "version": "1.0.0",
  "description": "What it does, in one sentence.",
  "author": "your-github-handle",
  "category": "Productivity",
  "emoji": "🧩",
  "homepage": "https://github.com/you/my-extension",
  "downloadUrl": "https://github.com/you/my-extension/releases/download/v1.0.0/my-extension.zip",
  "sha256": "64-hex-character-sha256-of-the-zip",
  "updated": "2026-10-29"
}
```

Rules enforced by the app when loading the catalog:

* `downloadUrl` must be **HTTPS**.
* `sha256` (if present) must match the downloaded file, or the install is refused.
* Packages must contain a `manifest.json` with `manifest_version` 2 or 3 at the
  root (or inside a single top-level folder).
* `.zip` ≤ 30 MB, unpacked ≤ 60 MB, ≤ 5,000 files.
* Paths that escape the extraction directory (`../`, absolute paths) are rejected.

## Why this is safe(r)

* Every install shows a warning — extensions can read and change data on the
  sites you visit. Only install authors you trust.
* Hash pinning means a changed `.zip` behind the same URL will not install.
* The catalog is a plain JSON file in a public repo, so every listing is auditable
  in git history. No opaque backend.

## Suggesting a built-in extension

Open an issue with the `extension` label and a short description. Built-ins ship
inside the app and work offline.

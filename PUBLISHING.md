# Publishing Guide (Agent Runbook)

This document is the checklist for releasing `orca-telegram-bridge` from `github.com/drecchia/orca-telegram-bridge` and for getting it listed in the **Orca Community Plugins** directory (`https://orca.dev/plugins`). For how users install the plugin, see [README.md → Install](./README.md#install).

> **Listing blocker: this repository is a fork.** `drecchia/orca-telegram-bridge` is a GitHub fork of `HenryMa96/orca-telegram-bridge`. The directory leaves forks out (`https://orca.dev/plugins/add`, "What gets a plugin left out"). Until that changes, users install from GitHub (`orca plugin install drecchia/orca-telegram-bridge`), and the catalog id `drecchia.telegram-bridge` does not resolve. To get listed, the repository must stop being a fork: ask GitHub Support to detach it, or delete/rename this fork and push the code to a new, non-fork repository under `drecchia`. A new repository changes the install URL; existing GitHub installs must reinstall from it and approve again. The plugin key stays `drecchia.telegram-bridge` while the owner stays `drecchia`.

> **Note on Official vs. Community Catalogs**
> - `stablyai/orca-plugins` only accepts first-party plugins maintained by Stably (`CONTRIBUTING.md` explicitly rejects external PRs).
> - Third-party plugins are published via public GitHub repositories and automatically indexed into `stablyai/orca-community-plugins` and `https://orca.dev/plugins` — no PR or manual form is required.

---

## 1. Pre-Publish Audit (Privacy & Git History)

Before pushing to a public GitHub repository, verify:

1. **Git author / committer identity**:
   - Check `git log --format="%h %an <%ae> | %cn <%ce> | %s"`.
   - Ensure no corporate email or unwanted personal identity appears in commit history. If needed, update local git identity (`git config user.name` / `git config user.email`) and amend/squash before pushing publicly.
2. **No secrets or personal data in files**:
   - Confirm no Telegram BotFather tokens, proxy credentials, personal Telegram numeric IDs, or private local filesystem paths exist in any tracked file.
   - Verify `.gitignore` still excludes `node_modules/`, `.orca/`, `.env`, and `*.log`.

---

## 2. Manifest (`orca-plugin.json`)

The manifest already has everything the directory needs. Do not change these fields for a release:
- `"manifestVersion": 2`
- `"id": "telegram-bridge"`
- `"publisher": "drecchia"`: the repository owner. The directory leaves out a plugin whose `publisher` differs from the owner. Orca installs under `<owner>.<id>` = `drecchia.telegram-bridge` either way.
- `"repository"`, `"homepage"`: `https://github.com/drecchia/orca-telegram-bridge`
- `"author"`: `{ "name": "drecchia", "url": "https://github.com/drecchia" }`
- `"execution": "trusted-worker"`
- `"engines": { "orca": ">=1.4.248" }`
- `"license": "MIT"` (matching `./LICENSE`)
- `"icon": "assets/icon.png"` (256×256 static PNG)
- Minimal capabilities: `storage:own`, `secrets:own`, `settings:own`

For each release:

1. **Version**: do not bump `"version"` by hand; release-please does it (see [4. Release on GitHub](#4-release-on-github)). The Git tag is `v<version>` (e.g. `"version": "1.2.3"` → tag `v1.2.3`). Once a version is listed, its commit and `contentHash` are permanent; a moved tag does not replace it.
2. **Optional store artwork**:
   - `cover`: 16:10 image (recommended `1600x1000`, minimum `800x500`, max `1024 KB`, PNG/JPEG/WEBP, static) with `alt`.
   - `screenshots`: up to 6 images (minimum `1280x800`, max `1536 KB` each, static) with `alt`.

---

## 3. Local Validation & Checks

Run all four Orca CLI checks from the repository root and confirm every command succeeds (exit code `0`). On Linux, use `orca-ide` instead of `orca` here and in every command below (plain `orca` is usually the GNOME screen reader).

```sh
orca plugin validate . --json
orca plugin test . --json
orca plugin check . --json
orca plugin release-entry . --json
```

Then type-check `src/` (it needs Node and npm; it fetches TypeScript and `@types/node` into a temp folder, and writes the Orca typings into `.orca/types`). On Linux, prefix it with `ORCA=orca-ide`:

```sh
.github/scripts/typecheck.sh
```

CI (`.github/workflows/ci.yml`) runs the unit tests, this typecheck and a gitleaks scan of the whole history on every PR and every push to `main`. Fake secrets the tests need are allowed in `.gitleaks.toml`, matched by their exact value. A PR that changes `src/` also needs a change in `README.md`, `PUBLISHING.md`, `specs/` or `docs/`, or the `sem-doc` label (`.github/workflows/doc-check.yml`).

---

## 4. Release on GitHub

The repository is `https://github.com/drecchia/orca-telegram-bridge` (public, remote `origin`).

Releases come from [release-please](https://github.com/googleapis/release-please) (`.github/workflows/release.yml`), from the [Conventional Commits](https://www.conventionalcommits.org/) on `main`: `fix:` bumps the patch, `feat:` the minor, and a breaking change (`feat!:`) also only the minor while the version is `0.x`.

1. After CI passes on `main`, release-please opens or updates the release PR `chore(main): release X.Y.Z`. It changes `"version"` in `orca-plugin.json`, `.release-please-manifest.json` and `CHANGELOG.md`. CI does not run on that PR: GitHub starts no workflows for a PR made with `GITHUB_TOKEN`. Its code is `main`, which CI already tested.
2. Merge the release PR. Once CI passes on that merge, release-please creates the tag `vX.Y.Z` and its GitHub Release. `orca plugin install drecchia/orca-telegram-bridge` (no version) now installs this tag, because Orca picks the newest `vX.Y.Z` tag.
3. The release check (`.github/workflows/release-check.yml`) then checks that the tag matches `"version"` and runs the tests on the tag. A failure there means the tag is already public: fix it on `main` and release the next version.
4. The repository needs the `orca-plugin` topic (needed for the directory to look at the repository at all), once:
   ```sh
   gh repo edit drecchia/orca-telegram-bridge --add-topic orca-plugin
   ```
5. Test the install from the tag. If this folder is loaded as a development plugin, run `orca plugin dev unload .` first. A dev folder overrides an install with the same key.
   ```sh
   orca plugin install drecchia/orca-telegram-bridge@vX.Y.Z
   ```
   A new version that asks for new access stops with `approval_required` (exit code `3`). Check the listed access, publisher and repository, then run the printed `--approve <fingerprint>` command.
6. Check the listing status (usually updates within an hour): `https://orca.dev/plugins/drecchia/orca-telegram-bridge`. While the repository is a fork, it stays unlisted (see the blocker at the top). Once listed, `orca plugin install drecchia.telegram-bridge` works too.

# Fork notes

This repository is a personal fork of Super Productivity. It ships as a separate app
("SP Telos") and stays as close to upstream as possible.

## Upstream base

- `fork/upstream-base` is the only source of the pinned upstream release:
  - `tag=` — the upstream tag;
  - `commit=` — the full SHA of the commit that tag points to.
- The file changes only together with merging that upstream tag into the fork.
- Upstream branches and tags are never pushed to this repository.

## Releases

- Release tag: `vM.m.p-fork.N`, where `M.m.p` is the upstream version from `fork/upstream-base`
  and `N` starts at 1 for every upstream version. Leading zeros are not allowed.
- The version is never committed. At release build time it is substituted in the build
  working copy only.
- Android `versionCode` = `M*10^7 + m*10^5 + p*10^3 + N` (`m <= 99`, `p <= 99`, `1 <= N <= 999`).
  The formula only ever changes upwards.

## App identity

Set at build time, never committed to upstream files:

| Platform | Value |
|---|---|
| macOS `appId` and `mac.appId` | `io.github.daniilmann.sptelos` |
| Display name (`productName`) | `SP Telos` |
| Packaged `name` (data folder) | `superProductivityTelos` |
| Android `applicationId`, shortcut `targetPackage` | `io.github.daniilmann.sptelos` |

## Changes to upstream files

Every change to an upstream file is listed here with its kind and its check.
Kinds: permanent (committed), build-time substitution (not committed), removal.

| # | Change | Upstream files | Kind | Check |
|---|---|---|---|---|
| 1 | Upstream workflows | `.github/workflows/` | removal | gate guard: only the workflows listed below exist |

## Workflows kept in `.github/workflows/`

None yet. Fork workflows are added here when they land.

## Fork-only files

- `FORK.md`
- `fork/*`

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
| 1 | Upstream workflows | `.github/workflows/` | removal | gate guard: only the workflows listed below exist. Upstream tool tests that read removed workflows are skipped in the upstream lint chain: `fork/run-upstream-lint.mjs` |
| 2 | `LAUNCH_MODE=2` | `android/app/app_config.properties` | permanent | `fork/android-files.test.mjs` |
| 3 | `version` | `package.json`, `packages/plugin-api/package.json` | build-time substitution | `fork/apply-identity.mjs`; release artifacts |
| 4 | `applicationId`, `versionCode`, `versionName`; `targetPackage` of the three shortcuts | `android/app/build.gradle`; `android/app/src/main/res/xml/shortcuts.xml` | build-time substitution | `fork/apply-identity.mjs --check` in the gate; APK manifest check |
| 5 | `appId`, `mac.appId`, `productName`, `extraMetadata.name`, ad-hoc signature | none (overlay `fork/electron-builder.fork.yaml`) | build-time substitution | DMG artifact check |
| 6 | No app data in Google cloud backup: every storage domain excluded as a whole | `android/app/src/main/res/xml/backup_rules.xml` (Android 7–11), `android/app/src/main/res/xml/data_extraction_rules.xml` (`cloud-backup`, Android 12+) | permanent | `fork/android-files.test.mjs`; APK check `fork/check-apk-backup.mjs` |

## Workflows kept in `.github/workflows/`

- `fork-gate.yml` — fast gate on every push; DMG, APK, Plugin API types package and web build on release tags
  and on manual runs; on a release tag only, the Release is created as a draft, its assets are compared with the
  built set, and it is published. An existing Release for the tag fails the run; nothing is overwritten.
- Release assets: `superProductivityTelos-arm64.dmg`, `superProductivityTelos-fdroid.apk`,
  `super-productivity-plugin-api-<version>.tgz`, `superProductivityTelos-web.zip`. Release notes are empty.

## Fork-only files

- `FORK.md`
- `fork/*`
- `.github/workflows/fork-gate.yml`

Upstream composite actions in `.github/actions/` are reused as they are.

Android Lint runs against `fork/android-lint-baseline.xml`, taken on the pinned upstream tag and applied by
the Gradle init script `fork/android-lint.init.gradle` (no change to `build.gradle`). New error-level issues fail the gate.

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
| 7 | Disable upstream release checks for every setting and entry point | `src/app/core/update-check/is-update-check-possible.util.ts`; `src/app/core/update-check/update-check.service.ts`; `src/app/core/update-check/update-check.service.spec.ts` (removed superseded test) | permanent; removal | `src/app/core/update-check/update-check.service.fork.spec.ts`; `src/app/pages/config-page/config-page.component.fork.spec.ts`; packaged app check |
| 8 | Hide Remove for the protected product plugin ID | `src/app/plugins/ui/plugin-management/plugin-management.component.ts`; `src/app/plugins/ui/plugin-management/plugin-management.component.html` | permanent | `src/app/plugins/ui/plugin-management/plugin-management.component.fork.spec.ts` |
| 9 | Remove task-writing URL actions (`create-task`, `complete-task`, `task-toggle-start`); preserve UI actions and OAuth | `src/app/features/tasks/util/parse-app-uri-task-action.ts`; `src/app/features/tasks/app-uri-actions/app-uri-task-actions.service.ts`; `src/app/core/app-url-open-router.ts`; `electron/protocol-handler.ts`; `android/app/src/main/AndroidManifest.xml`; `src/app/features/tasks/util/parse-app-uri-task-action.spec.ts` and `src/app/features/tasks/app-uri-actions/app-uri-task-actions.service.spec.ts` (removed superseded tests); `src/app/core/app-url-open-router.spec.ts` and `electron/protocol-handler.test.cjs` (superseded test blocks removed); `tools/verify-android-url-hosts.test.js` (superseded test block replaced) | permanent; removal | `src/app/features/tasks/util/parse-app-uri-task-action.fork.spec.ts`; `src/app/features/tasks/app-uri-actions/app-uri-task-actions.service.fork.spec.ts`; `src/app/core/app-url-open-router.fork.spec.ts`; `electron/protocol-handler.fork.test.cjs`; `tools/verify-android-url-hosts.test.js`; packaged app checks |

## Upstream change budget

In the fast gate, each changed upstream file may add at most this many lines against the pinned upstream base; deleted lines do not count, and new fork files are not counted. Binary changes to upstream files and replacements with symbolic links cannot be measured by this budget and fail the gate. Edit the number below to change the budget; the gate reads it from here.

The heading must start at the beginning of a line, followed by a paragraph and exactly one fenced `json` block. The block must contain an object with the sole key `maxAddedLinesPerFile`, whose value is an integer ≥ 0. HTML comments in this policy section or a repeated key fail the gate. A change to the number in a branch produces a gate warning.

```json
{"maxAddedLinesPerFile": 20}
```

## Reworked upstream files

These upstream files are reworked under the fork's design rules; each listed file is exempt from the line budget and is linted as a whole by the fork lint (`eslint.fork.config.js`) from then on. The task that reworks a file adds its entry. An entry is removed only with the repository owner’s confirmation or when the file is removed from upstream during a move to a new upstream tag.

The heading must start at the beginning of a line, followed by a paragraph and exactly one fenced `json` block. The block must contain an array of unique paths to existing `*.ts`, `*.tsx`, `*.js`, or `*.mjs` files. HTML comments in this policy section, duplicate paths, other file types, and missing files fail the gate. A change to the list in a branch produces a gate warning.

```json
[]
```

The fast gate lints new and renamed `*.ts`, `*.tsx`, `*.js`, and `*.mjs` files since the pinned base, together with the reworked list, using `eslint.fork.config.js` (typed rules, complexity 30, 400 code lines per file, inline disables ignored). Every listed file must appear in the ESLint report; a file hidden by upstream ignores fails the gate.

The fast gate also requires `packages/shared-schema`, `packages/sync-core`, and `packages/super-sync-server` to exist and match the pinned upstream base.

## Workflows kept in `.github/workflows/`

- `fork-gate.yml` — fast gate on every push; DMG, APK, Plugin API types package and web build on release tags
  and on manual runs; on a release tag only, the Release is created as a draft, its assets are compared with the
  built set, and it is published. An existing Release for the tag fails the run; nothing is overwritten.
- `LICENSE` ships in every artifact without changing upstream files: in the DMG app as
  `Contents/Resources/LICENSE` (`extraResources` in the overlay), in the APK as `assets/public/LICENSE`
  (copied into the web build before Capacitor sync), and in the web build zip. The build checks each copy.
- Release assets: `superProductivityTelos-arm64.dmg`, `superProductivityTelos-fdroid.apk`,
  `super-productivity-plugin-api-<version>.tgz`, `superProductivityTelos-web.zip`. Release notes are empty.

## Fork-only files

- `FORK.md`
- `fork/*` — gate policy, fork lint and coverage check, upstream line budget, pinned upstream packages check, lint probe, identity substitution, APK backup check, upstream lint chain, Android files tests, lint baseline and init script, electron-builder overlay, upstream base, `fork/tsconfig.json`, and their tests where present
- `eslint.fork.config.js`
- `.github/workflows/fork-gate.yml`
- `src/app/core/app-uri-actions/is-blocked-task-app-uri.ts`
- `src/app/core/update-check/upstream-update-check-policy.ts`
- `src/app/plugins/protected-plugin-ids.const.ts`
- `src/app/core/app-url-open-router.fork.spec.ts`
- `src/app/core/update-check/update-check.service.fork.spec.ts`
- `src/app/features/tasks/app-uri-actions/app-uri-task-actions.service.fork.spec.ts`
- `src/app/features/tasks/util/parse-app-uri-task-action.fork.spec.ts`
- `src/app/pages/config-page/config-page.component.fork.spec.ts`
- `src/app/plugins/ui/plugin-management/plugin-management.component.fork.spec.ts`
- `electron/protocol-handler.fork.test.cjs`

Upstream composite actions in `.github/actions/` are reused as they are.

Android Lint runs against `fork/android-lint-baseline.xml`, taken on the pinned upstream tag and applied by
the Gradle init script `fork/android-lint.init.gradle` (no change to `build.gradle`). New error-level issues fail the gate.

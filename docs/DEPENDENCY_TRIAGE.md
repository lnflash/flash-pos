# Dependency Triage

Generated during M2 security hardening on 2026-06-21. Updated after the
dependency upgrade sprint on 2026-06-21.

Audit command:

```bash
yarn audit --groups dependencies --level moderate --json
```

## Summary

Before easy-win upgrades, the production dependency audit returned 96 advisory rows:

- 2 critical
- 56 high
- 38 moderate

The first runtime easy win was upgraded:

- `axios`: `1.10.0` -> `1.18.0`
- `form-data`: `4.0.3` -> `4.0.6` through `axios`
- `follow-redirects`: `1.15.9` -> `1.16.0` through `axios`

After the full upgrade sprint and lockfile resolutions, the production
dependency audit at high severity returns no critical or high vulnerabilities:

- 0 critical
- 0 high
- 8 moderate
- 4 low

## Critical/High + Runtime

These packages can ship in the app runtime or sit under runtime UI dependencies.

| Package | Severity | Path | Status |
| --- | --- | --- | --- |
| `axios@1.10.0` | High, moderate | direct dependency | Upgraded to `1.18.0`. |
| `form-data@4.0.3` | Critical, high | `axios > form-data` | Upgraded to `4.0.6` through `axios`. |
| `follow-redirects@1.15.9` | Moderate | `axios > follow-redirects` | Upgraded to `1.16.0` through `axios`. |
| `lodash@4.17.21` | High, moderate | `@rneui/base > react-native-ratings > lodash` | Resolved to `4.18.1`. This avoids a major `@rneui/base`/`@rneui/themed` upgrade while removing the vulnerable lodash version from the lockfile. |

## Critical/High + Tooling Paths

These are installed under `dependencies` because React Native ships build,
Metro, codegen, and devtools packages through the `react-native` dependency.
The vulnerable paths are Node-side tooling/dev-server paths, not normal app
business logic.

| Package | Severity | Path | Status |
| --- | --- | --- | --- |
| `shell-quote@1.8.3` | Critical | `react-native > react-devtools-core > shell-quote` | Resolved to `1.8.4`. |
| `minimatch@3.1.2` | High | `react-native > glob > minimatch`, `@react-native/codegen` paths, Jest coverage tooling paths | Resolved to `3.1.5`. Yarn warns this also overrides `minimatch@^8` and `minimatch@^9`; Jest, TypeScript, and lint verification pass. Keep this resolution until the React Native/tooling graph carries patched minimatch versions without an override. |
| `node-forge@1.3.1` | High, moderate | `react-native > @react-native/community-cli-plugin > @react-native/dev-middleware > selfsigned > node-forge` | Resolved to `1.4.0`. |
| `picomatch@2.3.1` | High, moderate | Metro, Jest, codegen, and micromatch paths under `react-native` | Resolved to `2.3.2`. |
| `ws@6.2.3`, `ws@7.5.10` | High | `react-native > ws`, Metro/dev-middleware/devtools paths | Resolved to `7.5.11`. Yarn warns this overrides `ws@^6.2.3`; Jest, TypeScript, and lint verification pass. Keep this resolution until a React Native/Metro upgrade can remove the override. |

## Moderate/Low + Transitive

The remaining accepted findings are lower severity. No critical or high
findings remain.

| Package | Severity | Path | Status |
| --- | --- | --- | --- |
| `brace-expansion@1.1.12` | Moderate | under `minimatch` from React Native build/codegen/test paths | Resolved to `1.1.13`. |
| `postcss@8.4.31` | Moderate | `styled-components > postcss` | Resolved to `8.5.10`. |
| `js-yaml@3.14.1` | Moderate | Metro config and Jest Istanbul config loaders under `react-native` | Accepted temporarily. This is Node-side Metro/Jest config parsing, not app runtime code. One advisory can be patched with `3.14.2`, but the newer quadratic DoS advisory requires `>=4.2.0`, a major override for older tooling. Track with React Native/Metro/Jest upgrade. |

## Accepted Risk

No confirmed false positives. The remaining moderate findings are real package
versions in the install graph, but they sit in Node-side React Native/Jest
tooling paths rather than app runtime code. The runtime critical/high target is
met: 0 critical and 0 high.

## Next Steps

1. Revisit the React Native version after release hardening; the remaining
   `js-yaml` moderate findings are best fixed by a coordinated
   React Native/Metro/Jest tooling upgrade.
2. Plan a UI dependency upgrade for `@rneui/base` and `@rneui/themed` from
   `4.0.0-rc.8` to the current `5.x` line, with focused regression coverage
   for screens using RNEUI components and `react-native-ratings`. This is no
   longer required for the lodash high advisory because lodash is resolved.
3. Keep the Yarn resolutions under review during the next React Native upgrade
   so pinned transitive overrides can be removed once upstream packages carry
   patched versions.

## Verification

Commands run after the upgrade sprint:

```bash
yarn audit --groups dependencies --level high 2>&1
yarn test --runInBand && yarn typecheck
```

Final required verification before commit:

```bash
yarn test --runInBand
yarn typecheck
yarn lint --max-warnings 99999
```

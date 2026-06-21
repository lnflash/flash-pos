# Dependency Triage

Generated during M2 security hardening on 2026-06-21.

Audit command:

```bash
yarn audit --groups dependencies --level moderate --json
```

## Summary

Before easy-win upgrades, the production dependency audit returned 96 advisory rows:

- 2 critical
- 56 high
- 38 moderate

The direct runtime easy win was upgraded:

- `axios`: `1.10.0` -> `1.18.0`
- `form-data`: `4.0.3` -> `4.0.6` through `axios`
- `follow-redirects`: `1.15.9` -> `1.16.0` through `axios`

After the upgrade, the audit returns 69 advisory rows, representing 22 unique advisories:

- 1 critical
- 13 high
- 8 moderate

## Critical/High + Runtime

These packages can ship in the app runtime or sit under runtime UI dependencies.

| Package | Severity | Path | Status |
| --- | --- | --- | --- |
| `lodash@4.17.21` | High, moderate | `@rneui/base > react-native-ratings > lodash` | Remaining. `@rneui/base` latest is `5.0.0`; this is a major UI dependency upgrade from `4.0.0-rc.8`, so it needs planned screen/regression testing rather than an automatic bump. |

Fixed in this pass:

| Package | Severity | Path | Status |
| --- | --- | --- | --- |
| `axios@1.10.0` | High, moderate | direct dependency | Upgraded to `1.18.0`. |
| `form-data@4.0.3` | Critical, high | `axios > form-data` | Upgraded to `4.0.6` through `axios`. |
| `follow-redirects@1.15.9` | Moderate | `axios > follow-redirects` | Upgraded to `1.16.0` through `axios`. |

## Critical/High + Dev-Only

These are installed under `dependencies` because React Native ships build, Metro, codegen, and devtools packages through the `react-native` dependency. The vulnerable paths are Node-side tooling/dev-server paths, not normal app business logic.

| Package | Severity | Path | Risk decision |
| --- | --- | --- | --- |
| `shell-quote@1.8.3` | Critical | `react-native > react-devtools-core > shell-quote` | Accept temporarily. Devtools path; fix should come from a React Native/devtools dependency update or lockfile override. |
| `minimatch@3.1.2` | High | `react-native > glob > minimatch`, `@react-native/codegen` paths, Jest coverage tooling paths | Accept temporarily. Build/test/codegen glob processing. |
| `node-forge@1.3.1` | High, moderate | `react-native > @react-native/community-cli-plugin > @react-native/dev-middleware > selfsigned > node-forge` | Accept temporarily. Metro/dev-middleware certificate generation path. |
| `picomatch@2.3.1` | High, moderate | Metro, Jest, codegen, and micromatch paths under `react-native` | Accept temporarily. Build/dev glob matching. |
| `ws@6.2.3`, `ws@7.5.10` | High | `react-native > ws`, Metro/dev-middleware/devtools paths | Accept temporarily. Dev-server/websocket tooling; review with React Native upgrade. |

## Moderate/Low + Transitive

These are transitive and not directly fixable without a parent package upgrade or a lockfile override. No low findings were returned by the moderate-level audit.

| Package | Severity | Path | Status |
| --- | --- | --- | --- |
| `brace-expansion@1.1.12` | Moderate | under `minimatch` from React Native build/codegen/test paths | Track with React Native/tooling upgrade. |
| `js-yaml@3.14.1` | Moderate | Metro config and Jest Istanbul config loaders under `react-native` | Track with React Native/tooling upgrade. |
| `postcss@8.4.31` | Moderate | `styled-components > postcss` | Runtime dependency path but moderate severity; consider a targeted `styled-components` upgrade after critical/high runtime work. |

## False Positives

No confirmed false positives. Several findings are lower practical risk because Yarn audit reports Node-side React Native tooling under `dependencies`, but they are still real vulnerable package versions in the install graph.

## Next Steps

1. Plan a UI dependency upgrade for `@rneui/base` and `@rneui/themed` from `4.0.0-rc.8` to the current `5.x` line, with focused regression coverage for screens using RNEUI components and `react-native-ratings`.
2. Evaluate whether Yarn `resolutions` can safely patch `shell-quote`, `minimatch`, `node-forge`, `picomatch`, `ws`, `brace-expansion`, and `postcss` without fighting React Native's pinned tooling.
3. Revisit the React Native version after release hardening; many remaining findings are likely best fixed by a coordinated React Native/Metro/tooling upgrade.

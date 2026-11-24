# Repository Guidelines

## Project Structure & Module Organization

- `app/` contains Expo Router screens. `app/_layout.tsx` sets up navigation and Watch inbox polling, and `app/trials/[id].tsx` renders an individual trial.
- `src/` holds shared UI and charts, route scoring, GPS recording, SQLite storage, Watch protocol and sync, trial analysis, and export logic. `src/demo.ts` generates synthetic trial data.
- `modules/walk-connectivity/ios/` contains the native iPhone bridge. `scripts/stage-watch.cjs` copies the companion from `../watch_app/targets/walk/` into `targets/walk/` during native setup. Edit companion source in `watch_app`.
- `tests/study.test.mjs` contains the automated study logic tests.

## Build, Test, and Development Commands

Use Node 22.13 or later. Native iOS builds require macOS, Xcode, CocoaPods, and the sibling `watch_app` directory.

- `npm ci` installs locked dependencies.
- `npm start` starts Metro for an installed Expo development client.
- `npm run prebuild:ios -- --clean` regenerates the iOS project and embeds the Watch target.
- `npm run ios -- --device` builds and runs the app on a connected iPhone.
- `npm run typecheck` checks strict TypeScript. `npm test` runs the Node test suite.
- `npx expo export --platform ios --no-bytecode` verifies iOS JavaScript bundling.

## Coding Style & Naming Conventions

Match nearby code. Use two-space indentation and double quotes in TypeScript, four-space indentation in Swift, PascalCase for components and types, and camelCase for functions. Preserve snake_case Watch payload fields for compatibility. Follow Expo Router naming, including `[id].tsx` for dynamic segments.

## Testing Guidelines

Use `node:test` and `node:assert/strict`. Add cases to `tests/study.test.mjs` or update `npm test` when adding a new `*.test.mjs` file. Use descriptive test names and deterministic fixtures for route scoring, sample integrity, and GPS or heart-rate alignment. Coverage thresholds are unspecified. Verify background GPS and delayed Watch sync on a signed, paired iPhone and Apple Watch when those paths change.

## Commits & Pull Requests

Use short, imperative commit subjects such as `Fix Watch sync after relaunch`. In pull requests, describe the behavior change, link related issues, record verification results, and attach screenshots for UI changes.

## Configuration

Use `.env.example` as the template for `.env.local`. Set `WALKING_STUDY_APPLE_TEAM_ID` for signing. Override `EXPO_PUBLIC_OVERPASS_URL` and `EXPO_PUBLIC_TERRARIUM_URL` when using alternate map and elevation data hosts. Use synthetic data in fixtures and screenshots.

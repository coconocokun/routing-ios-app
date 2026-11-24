# Walking Study for iPhone

Expo SDK 58 development project for planning walks, collecting background GPS, importing Watch observations and reviewing local trials. The app can save a clearly marked synthetic trial from **Plan a new walk → Explore synthetic routes**. The demo exercises route comparison, replay, HR maps, charts and ZIP export without requesting recording permissions.

## Build on macOS

Use Node 22.13 or later, Xcode with the iOS 27 SDK and CocoaPods. Keep this directory alongside [watch_app](../watch_app/README.md). Set `WALKING_STUDY_APPLE_TEAM_ID` to your Apple development team ID in the terminal or in `.env.local` before prebuild.

```sh
npm ci
npm run prebuild:ios -- --clean
npm run ios -- --device
```

The build scripts stage the Watch source into `targets/walk` and generate an embedded `WalkingStudyWatch` target. If Xcode prompts for signing, select the same team for the phone and Watch targets. Use the iPhone Watch app to install the companion if it does not install automatically. For a subsequent development session, start Metro with `npm start`. An Expo development build supplies the local WatchConnectivity module and background GPS capabilities.

The development bundle IDs are `org.walkingstudy.phone` and `org.walkingstudy.phone.watchkitapp`. If your team needs different IDs, change the phone ID in `app.config.js` and the matching value in the Watch source `Info.plist` before regenerating the project.

## Routing and map data

**Find walking routes** uses the public Valhalla server for pedestrian routes and elevation and the public Overpass API for OSM paths near the endpoints. Both endpoints are built in. To use other hosts, override `EXPO_PUBLIC_VALHALLA_URL` or `EXPO_PUBLIC_OVERPASS_URL` in `.env.local` using [.env.example](.env.example).

Valhalla receives the selected endpoints and points along proposed routes for elevation lookup. Overpass receives the endpoints for the path overlay. The phone applies its route quality checks and signed Minetti scoring locally. Labels compare the usable candidates returned for that request. See the [iOS development plan](IOS_APP_DEVELOPMENT_PLAN.md#4-routing--predicted-walking-cost-algorithm) for the request flow, scoring rules and provider limits.

## Data handling

Trials and measurements are stored in SQLite in the app sandbox. The paired Watch uses a durable outbox and a verified final manifest. The phone processes its native inbox when the app is active. Grade estimates use the selected DEM-backed corridor where the observed trace matches it. Deviations without a reliable match display missing grade.

The full ZIP contains exact coordinates and timestamps. The reduced ZIP omits exact locations, absolute timestamps and raw identifiers. It still retains enough measurement detail that privacy depends on the study’s sharing rules. Deletion removes the app’s records and queues a Watch deletion. Apple Health workouts and already shared copies are managed separately.

## Verification

```sh
npm run typecheck
npm test
npx expo export --platform ios --no-bytecode
```

The fixtures cover signed grade, route classification, rejection of invalid candidates, manifest integrity, UTC clock alignment, pauses and GPS/HR gaps. Paired-device verification requires signed builds and physical hardware. Before participant use, verify screen-lock GPS, permission denial, a 30–60 minute Watch workout, disconnect and delayed sync, app relaunch, and export round trips under the approved study protocol.

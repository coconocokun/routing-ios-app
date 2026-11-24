# Walking Study

Expo SDK 58 development project for planning walks, recording GPS and reviewing local trials. The iPhone build supports background GPS and optional heart-rate recording with Apple Watch.

## Test in a browser

Use Node 22.13 or later.

```sh
npm ci
npm run web
```

Open the localhost URL printed by Expo. Choose **Plan a new walk → Explore demo routes** to test route comparison, trial history, replay, HR charts and ZIP downloads without granting location access. Trials are saved in browser storage for that origin.

For a live GPS-only test, set the start and destination by searching or tapping the map. The start also supports **Use current location**. Once the routes appear, select one in the bottom sheet, authorize recording, enter an optional trial label, and select **Start navigation**. Grant location access when prompted and keep the tab open and visible during the walk. Use localhost or HTTPS for browser location access. Live planning requires internet access and providers that allow browser requests.

## Build on macOS

Use Node 22.13 or later, Xcode with the iOS 27 SDK and CocoaPods. Keep this directory alongside [watch_app](../watch_app/README.md). Set `WALKING_STUDY_APPLE_TEAM_ID` to your Apple development team ID in the terminal or in `.env.local` before prebuild.

```sh
npm ci
npm run prebuild:ios -- --clean
npm run ios -- --device
```

The build scripts stage the Watch source into `targets/walk` and generate an embedded `WalkingStudyWatch` target. If Xcode prompts for signing, select the same team for the phone and Watch targets. Use the iPhone Watch app to install the companion if it does not install automatically. For a subsequent development session, start Metro with `npm start`. An Expo development build supplies the local WatchConnectivity module and background GPS capabilities.

GPS-only tests are the default. When the paired companion is installed, turn on **Record heart rate with Apple Watch** during setup to run a paired trial.

The development bundle IDs are `org.walkingstudy.phone` and `org.walkingstudy.phone.watchkitapp`. If your team needs different IDs, change the phone ID in `app.config.js` and the matching value in the Watch source `Info.plist` before regenerating the project.

## Routing and map data

After both endpoints are selected, the app builds a local pedestrian graph from OpenStreetMap data and samples elevations from Mapzen Terrarium tiles. It searches for the shortest walking route, the route with the lowest total predicted energy in J/kg, and the lowest-energy route with slopes between −8% and +8% and a detour of at most 30%. Route details also report average J/kg/m. All three searches use the same modeled graph and snapped endpoints. See the [routing design](IOS_APP_DEVELOPMENT_PLAN.md#4-routing--predicted-walking-cost-algorithm) and [terrain data attribution](https://github.com/tilezen/joerd/blob/master/docs/attribution.md).

The planner sends a bounding box derived from the endpoints to the provider configured by `EXPO_PUBLIC_OVERPASS_URL` in `.env.local`. If that request fails or times out, it tries `overpass-api.de`, Private.coffee, and VK Maps (`maps.mail.ru`) in order, skipping any duplicate endpoint. Without an override, it starts with `overpass-api.de`. The elevation host receives regional tile indices. Place search sends a debounced query and an approximate map center rounded to 0.1 degrees to Photon. See [.env.example](.env.example), [Overpass public instance guidance](https://dev.overpass-api.de/overpass-doc/en/preface/commons.html), [Private.coffee’s privacy policy](https://overpass.private.coffee/#privacy-policy), [VK Maps Overpass](https://maps.mail.ru/osm/tools/overpass/), and [Photon’s demo server usage](https://github.com/komoot/photon#demo-server).

Expo includes `EXPO_PUBLIC_OVERPASS_URL` in the client bundle. For distribution, keep personal API keys on a server and configure its Overpass-compatible proxy URL here.

## Data handling

Trials and measurements are stored in SQLite on the iPhone or in the browser. The paired Watch uses a durable outbox and a verified final manifest. The phone processes its native inbox when the app is active. Grade estimates use the selected DEM-backed corridor where the observed trace matches it. Deviations without a reliable match display missing grade.

The full ZIP contains exact coordinates and timestamps. The reduced ZIP omits exact locations, absolute timestamps and raw identifiers. It still retains enough measurement detail that privacy depends on the study’s sharing rules. Deletion removes the app’s records and queues a Watch deletion for paired trials. Apple Health workouts and already shared copies are managed separately.

## Verification

```sh
npm run typecheck
npm test
npx expo export --platform web
npx expo export --platform ios --no-bytecode
```

The fixtures cover signed grade, graph-based route search, pedestrian access, missing elevation, manifest integrity, UTC clock alignment, pauses and GPS/HR gaps. Paired-device verification requires signed builds and physical hardware. Before participant use, verify screen-lock GPS, permission denial, a 30–60 minute Watch workout, disconnect and delayed sync, app relaunch, and export round trips under the approved study protocol.

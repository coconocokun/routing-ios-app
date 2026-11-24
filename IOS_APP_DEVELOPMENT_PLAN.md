# iPhone App — Expo / React Native Development Plan

**Project:** Walking Route & Heart-Rate Study  
**Platform:** iOS on a physical iPhone  
**Stack:** Expo SDK 58 (pin a known-good patch), React Native, TypeScript, native-development builds  
**Core responsibility:** Navigation + high-quality trace capture + trial archive + study visualizations

## 1. Functional requirements

| ID | Feature | MVP acceptance criterion |
|---|---|---|
| IOS-01 | Origin / destination | User can select two map points or choose current position as start. |
| IOS-02 | Route planning | Request pedestrian alternatives from Valhalla for the same endpoints. Score the candidates with complete elevation and show up to three distinct choices. |
| IOS-03 | Route comparison | Display color-coded paths and length, elevation gain, total predicted J/kg, predicted J/kg/m, and anticipated duration. |
| IOS-04 | Live location | Record timestamp, coordinates, horizontal accuracy, optionally elevation/altitude accuracy, speed and heading during active trial. |
| IOS-05 | Guidance | Show selected route and next waypoint/turn; automatically follow current marker; warn on a meaningful deviation. |
| IOS-06 | Trial lifecycle | Start, pause/resume (optional), finish, abandon; create trial ID and title; recover interrupted recording. |
| IOS-07 | Watch status | Show paired/install/reachable/HealthKit-running/sync-pending states without assuming reachability implies sampling. |
| IOS-08 | Persistence | Trial and received samples survive app force-close / reboot; no duplicate points after retry. |
| IOS-09 | History | Named trial list; filter/sort; detail, rename, delete, export. |
| IOS-10 | Visualization | GPS trace replay, HR map, HR vs walked distance, HR vs observed grade, with missing-data marks. |
| IOS-11 | Permission/privacy | Explain which planning coordinates go to the public providers. Keep recorded GPS and Watch data local by default and support explicit export and deletion. |

## 2. Recommended packages and boundaries

- **Navigation/UI:** Expo Router, React Native, TypeScript; small state store (Zustand or equivalent) to reduce screen coupling.
- **Location:** `expo-location`, `expo-task-manager`. Define the background task at module top level, not inside a React component. Configure iOS background location mode and permission usage strings in app config. Run a development build; Expo Go does not support the required background workflow.
- **Maps.** `react-native-maps` renders the iOS basemap, route choices, trace and HR overlays. Overpass supplies OSM path and step geometry near the selected endpoints. Maps that display OSM-derived geometry link to the OpenStreetMap attribution and license page.
- **Storage:** `expo-sqlite` for trial/route/sample records, file system for export ZIP/JSON/CSV bundles, OS share sheet for intentional external sharing. Database encryption via SQLCipher is a deliberate optional extension; at minimum use iOS device protections and avoid logging sensitive data.
- **Charts:** A React Native chart/SVG or Skia library selected after profiling; custom data transformations in pure TypeScript so research calculations don't depend on the chart component.
- **Connectivity:** a native bridge around `WCSession`, or the validated all-React watchOS package's WatchConnectivity bridge. Keep a shared JSON message schema independent of package.
- **Route computation.** `src/routing.ts` calls Valhalla for route candidates and terrain heights. `src/routes.ts` scores the candidates. The phone saves usable candidate geometry, elevation and metrics before a trial starts.

**Repository layout (illustrative):**

```text
repo/
  app/                         # Expo Router screens
    index.tsx                  # home
    plan.tsx                   # destination selection
    compare.tsx                # three-route comparison
    navigate.tsx               # active walk
    trials/index.tsx           # trial history
    trials/[id].tsx            # trial review
  src/
    features/navigation/       # guidance, off-route, lifecycle
    features/routing/          # candidate adapters, cost engine, safety filters
    features/recording/        # foreground/background location, trial writer
    features/analysis/         # alignment, metrics, chart series, playback
    features/watch/            # connectivity bridge and message handling
    db/                        # migrations, repositories, queries
    types/                     # shared trial schemas
  native/ or modules/          # iOS native modules if required
  targets/watch/               # watch target when using expo-targets approach
  tests/fixtures/              # synthetic routes, traces, HR sessions
```

## 3. Screens and interaction

### Home
- **New walk**, **Previous trials**, **Permissions / device diagnostics**.
- Indicate whether location permission is granted, Watch app is installed, and watch is reachable; these are informational only until recording starts.

### Plan and compare
- Set the start and destination by tapping the full-screen map or using the search fields. The start also supports current location. Load routes automatically after both endpoints are confirmed.
- Render up to three distinct paths with the `Shortest`, `Lowest J/kg/m`, and `Balanced` labels. Labels compare the usable Valhalla candidates for this request.
- Compare distance and estimated time in the bottom sheet, with gain and loss, mean and total predicted cost, maximum grade and warnings available for the selected route.
- Tap a route to highlight it. Use Valhalla's pedestrian access rules and exclude routes reported to include ferries. Verify study corridors in the field before participant use.
- If 2 methods produce the same geometry, mark that they coincide; show fewer than 3 truly different choices rather than inventing a route.

### Preflight and recording
- Enter the optional **trial label** above **Start navigation**. The expanded route details include the optional participant code.
- Start behavior: allocate `trial_id`, persist `preparing`, send `START` to Watch, await Watch `STARTED` or explicitly show “watch not recording” warning. Only transition to scientifically valid combined recording once both GPS and Watch streams are confirmed. If Watch unavailable, allow an explicitly flagged **GPS-only engineering test**, not a valid HR study trial.
- Active view: selected route and actual trace (different styles), position dot, elapsed active time, covered distance, next turn, Watch recording state, HR latest sample + age indicator (optional), **Finish / Pause**.
- Navigation recalculations are excluded from experiment by default; record off-route events and flag trials rather than silently replacing the treatment route.
- Arrival: provide “Destination nearby — Finish trial?” based on a configurable 20–35 m radius, but only a button commits completion.

### Trial history and details
- List: trial title, date/time, route type, duration, observed distance, sync/completeness state.
- Detail tabs: **Overview**, **Replay**, **HR map**, **HR vs distance**, **HR vs slope**, **Data quality**.
- Rename and delete trial; export the full event/sample record and analysis-ready tables.
- Use privacy-safe trial name defaults (`Trial 2026-11-24 #01`) rather than participant full names.

## 4. Routing / predicted walking-cost algorithm

### Source pipeline

1. Request a distance-costed pedestrian path and up to two alternates from Valhalla's OSM graph. Decode the polyline6 geometries, remove duplicate shapes and check that each path snaps within 60 m of the selected endpoints.
2. Sample evenly along each path at roughly 30 m spacing, including its endpoints. Send all sample points in one Valhalla `/height` request. Reject a candidate when any sample is missing or invalid.
3. Preserve the shape vertices, split long segments at intervals of at most 30 m and interpolate terrain elevation along the path. The DEM estimates ground elevation, which may differ from the walking surface on bridges and in tunnels.
4. For segment `i`, calculate horizontal distance `d_i` (m) and signed grade `g_i = (z_end-z_start)/d_i` (m/m; uphill positive), then evaluate **the walking equation** of Minetti et al. (2002):

   ```text
   Cw(g) = 280.5*g^5 - 58.7*g^4 - 76.8*g^3
           + 51.9*g^2 + 19.6*g + 2.5

   Units: J / (kg · m) of distance walked
   ```

   **Use signed grade, not absolute grade.** This empirical polynomial is not safely extrapolated outside the study's validated gradient range. Impose a predeclared grade domain/cost policy, log out-of-range segments and reject candidates with unreliable or implausible elevation/grade; do not clip silently or let extrapolation create negative costs.

5. Compute for a route `P`:

   ```text
   distance(P)     = Σ d_i                                 [m]
   mass_cost(P)    = Σ Cw(g_i) * d_i                        [J/kg]
   avg_cost(P)     = mass_cost(P) / distance(P)             [J/kg/m]
   total_cost_J(P) = mass_cost(P) * mass_kg                  [J] (optional)
   ```

6. Reject paths with repeated nodes, gaps or absolute grades above 25%. Cap the detour at 1.35 times the shortest usable candidate's distance. Merge labels for the same route and suppress substantially overlapping choices where detected.
7. Rank complete candidates by distance for `Shortest` and by average cost for `Lowest J/kg/m`. For `Balanced`, weight normalized distance and normalized total cost equally. Use stable tie-breaking and preserve all usable candidate metrics.
8. Save route geometry, interpolated elevation, scores, algorithm version and provider metadata. Mark the public Valhalla graph and DEM as unversioned because the responses lack snapshot identifiers. Freeze the saved routes throughout a study comparison.

**Critical research caution:** A route can have lower J/kg/m **yet higher total J/kg** because it is longer. Compare both outcomes; the experiment should not assume reduced mean cost implies reduced average HR.

### Public provider configuration

| Expo variable | Default endpoint | Use |
|---|---|---|
| `EXPO_PUBLIC_VALHALLA_URL` | `https://valhalla1.openstreetmap.de/` | POST `/route` and `/height` with the app's `X-Client-Id`. |
| `EXPO_PUBLIC_OVERPASS_URL` | `https://overpass-api.de/api/interpreter` | POST one Overpass QL query for footways, paths, pedestrian ways and steps within 200 m of either endpoint. Identify the app with its `User-Agent`. |
| `EXPO_PUBLIC_PHOTON_URL` | `https://photon.komoot.io` | GET `/api/` for place and address suggestions, with a search term and an approximate map center. |

- The public endpoints are enabled by default. Use `.env.local` to override provider URLs, for example with a study deployment that pins the graph and DEM revisions.
- After both endpoints are confirmed, the planner sends them and the terrain sample coordinates to Valhalla. It sends the confirmed endpoints to Overpass for the path overlay. Typing a place search sends the term and an approximate map center to Photon. GPS recordings, Watch readings and trial identifiers stay local.
- Keep Overpass requests small and wait at least 30 seconds after an Overpass HTTP 429. If Overpass is unavailable, show the route choices with the basemap. If Valhalla routing or elevation is unavailable, show the error and keep the synthetic demo available.
- Public services can change their data and limits. Review the operators' fair-use requirements before distributing the app with these endpoints.
- Persist the selected route and candidate metrics locally before the walk so navigation can use the saved geometry without another route request.

## 5. GPS collection and guidance

**Default sampling proposal (tune in field tests):** request high-accuracy location during active navigation; accept new fixes at roughly 1–5 s or a small distance interval based on battery/accuracy tests. Store **all original accepted fixes** before later thinning for maps. Keep rejected/low-quality fixes flagged for analysis instead of silently deleting them.

For each location fix record UTC instant, sequence, latitude/longitude, horizontal accuracy (m), optional altitude/vertical accuracy, speed/heading (if available), app state, and native provider information when available. Avoid using phone barometric/GPS altitude derivatives as the sole source of segment slope; use map matched position plus calibrated DEM/smoothed route elevation for slope analysis.

**Background:** request the minimum required foreground/background permissions with proper disclosure, enable location background mode, register `TaskManager.defineTask` at top-level, and write samples immediately into local storage. Test screen lock and app suspension on real devices. iOS may still interrupt or throttle execution; log gaps and mark incomplete sessions. Do not promise uninterrupted location when the process is force-quit.

**Deviation detection:** project the fix to the closest valid selected-route segment; use hysteresis such as distance >30 m on several accurate fixes before off-route warning. Avoid false deviations from GPS noise. Persist snapped distance and raw distance separately; never overwrite raw coordinates.

**Distance:** compute along-trace distance using validated successive GPS fixes, with a clearly documented noise filter; route progress may use snapped along-route distance. These two measurements must remain separate.

## 6. Recording state machine and crash recovery

States: `draft → preparing → recording ⇄ paused → stopping → sync_pending → complete` with `abandoned` and `incomplete` terminal alternatives.

1. Pre-create a record with UUID, title, route ID, user consent/setup flags, and `created_at`.
2. Start Watch workout; record event acknowledgement timestamps. Begin GPS session; persist initial event and first fix.
3. Append location fixes in batches inside SQLite transactions with incrementing sequence numbers; keep enough metadata to detect missing points.
4. A journal/recovery record tracks `active_trial_id` and the last committed sample. On relaunch, offer recovery/mark incomplete; never create a second trial with the same walk without explicit user action.
5. On finish, stop GPS and Watch, record end and paused intervals, compute **active and wall-clock duration** separately, then request pending final Watch records. If Watch transfer is late, show `sync_pending` and allow review of available data without claiming completeness.
6. Use `INSERT ... ON CONFLICT DO NOTHING` or equivalent keyed by `(trial_id, device, seq/sample_id)` to deduplicate retries.

## 7. Analysis UI implementation

| Screen | Implementation logic | Important guardrails |
|---|---|---|
| Trace replay | Scrub a time slider; interpolate position between valid GPS fixes; move a cursor along the true trace | Do not interpolate across large gaps; highlight pauses/off-route segments |
| HR spatial heatmap | Color segments of actual walked path by nearest/interpolated Watch HR where time gap is small | Label as **observed HR (bpm)**, not energy heatmap; unpaired regions remain gray |
| HR vs walked distance | For each HR timestamp, interpolate cumulative distance from surrounding GPS samples | Use monotonically increasing distance and mark missing/poor-accuracy periods |
| HR vs hilliness | Associate HR with time/position along DEM-derived **observed trace**; plot grade and BPM vs distance, with optional lag exploration | Grade is noisy at short lengths; show smoothing window, missing-data mask and no implied instant causality |

Every chart must allow the user to inspect session metadata (route category/version, date, Watch sample count, GPS sample count, matched fraction, average speed, paused time and data gaps).

## 8. Engineering acceptance tests

- **Routing.** Test pedestrian options, polyline6 decoding, missing elevation, signed grades, mean and total cost, detours, loops, and deterministic ordering. Test the Overpass query and geometry parsing with fixtures. On iPhone, confirm real route choices and the path overlay, then confirm routing still works when the overlay provider is unavailable.
- **Navigation:** 2 km field path without losing route on screen lock; compare plotted actual trace with another GPS map; no accidental finish when briefly within arrival radius.
- **Watch integration:** start/stop message acknowledgements, paired vs unreachable status, delayed delivery after reconnect, idempotent duplicate sample ingestion.
- **Persistence:** kill/restart app during GPS logging, then recover; rename/delete and confirm all child data deleted; export and parse back to equivalent samples.
- **Maps/charts:** 2,000+ location samples; HR gap; crossing/backtrack path; pause/resume; daylight saving/time zone independent UTC processing; export matches displayed statistics.
- **Privacy.** Confirm that place search sends only the query and approximate map center, and that routing sends only the selected endpoints and route elevation sample coordinates. Confirm users can delete study records on the device.

## 9. Deliverable checklist

- [ ] Route generator produces documented, valid path alternatives with stable costs.
- [ ] Expo iOS dev build installs and runs on physical paired iPhone.
- [ ] Route comparison map and metrics display correctly.
- [ ] GPS samples survive screen locking and normal app backgrounding (within iOS limitations).
- [ ] Paired Watch state and sample count are visible; unreliable linking is clearly flagged.
- [ ] Named trials persist locally with source/version metadata.
- [ ] Trial replay, HR map, HR-distance, HR-grade views pass fixture-based tests.
- [ ] Importable JSON/CSV bundle is reproducible and deletes cleanly.

## References

- Expo Location: https://docs.expo.dev/versions/latest/sdk/location/
- TaskManager: https://docs.expo.dev/versions/latest/sdk/task-manager/
- SQLite: https://docs.expo.dev/versions/latest/sdk/sqlite/
- Expo Maps: https://docs.expo.dev/versions/latest/sdk/maps/
- React Native Maps: https://docs.expo.dev/versions/latest/sdk/map-view/
- Minetti et al. (2002): https://doi.org/10.1152/japplphysiol.01177.2001
- [Valhalla routing API](https://valhalla.github.io/valhalla/api/route/api-reference/) and [elevation API](https://valhalla.github.io/valhalla/api/elevation/api-reference/)
- [Valhalla public demo server](https://github.com/valhalla/valhalla#demo-server)
- [Overpass public instance limits](https://dev.overpass-api.de/overpass-doc/en/preface/commons.html) and [operator usage rules](https://github.com/drolbr/Overpass-API/issues/791)
- [OpenStreetMap attribution and license](https://www.openstreetmap.org/copyright)

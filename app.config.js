module.exports = {
  name: "Walking Study",
  slug: "walking-study-ios",
  version: "0.1.0",
  scheme: "walking-study",
  platforms: ["ios", "web"],
  orientation: "portrait",
  ios: {
    bundleIdentifier: "org.walkingstudy.phone",
    appleTeamId: process.env.WALKING_STUDY_APPLE_TEAM_ID || undefined
  },
  plugins: [
    "expo-router",
    ["expo-location", {
      "locationWhenInUsePermission": "Walking Study uses your position to choose a starting point and record the path you walk.",
      "locationAlwaysAndWhenInUsePermission": "Walking Study records your path during a walk you start, including when your iPhone is locked.",
      "isIosBackgroundLocationEnabled": true
    }],
    "@bacons/apple-targets"
  ]
};

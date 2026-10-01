/*
 * Pure page logic: no DOM, no fetch, so `node web/check.js` can assert it.
 *
 * The daylight verdict is the browser-side judgment the architecture asks for:
 * missing or stale evidence must read "insufficient", never "no production".
 */

export function daylightVerdict(input) {
  if (!input || !input.hasLocation) {
    return { state: "no_location", message: "Add a site location in Settings to judge daylight." };
  }
  var sunrise = Date.parse(input.sunriseUtc);
  var sunset = Date.parse(input.sunsetUtc);
  if (!isFinite(sunrise) || !isFinite(sunset) || sunset <= sunrise) {
    // No stored weather at all is a waiting state, not a property of the site.
    return {
      state: "insufficient",
      message:
        input.weatherStored === false
          ? "Weather has not been stored yet, so daylight production cannot be judged."
          : "Daylight times are unavailable for this site, so production cannot be judged.",
    };
  }
  if (input.nowUtc < sunrise || input.nowUtc > sunset) {
    return { state: "outside_daylight", message: "" };
  }
  if (input.weatherStale) {
    return { state: "insufficient", message: "Weather is stale, so daylight production cannot be judged." };
  }
  if (!input.powerFresh) {
    return { state: "insufficient", message: "Solar readings are not fresh, so daylight production cannot be judged." };
  }
  if (typeof input.pvKw !== "number" || !isFinite(input.pvKw)) {
    return { state: "insufficient", message: "No measured solar power for this moment." };
  }
  if (input.pvKw > 0) return { state: "producing", message: "" };
  return { state: "no_production", message: "Daylight with no measured solar production. Check the PVS or the panels." };
}

export function formatDaylightDuration(seconds) {
  if (typeof seconds !== "number" || !isFinite(seconds) || seconds < 0) return "\u2014";
  var minutes = Math.round(seconds / 60);
  return Math.floor(minutes / 60) + "h " + String(minutes % 60).padStart(2, "0") + "m";
}

var WEATHER_TEXT = {
  0: "Clear",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Freezing fog",
  51: "Light drizzle",
  53: "Drizzle",
  55: "Heavy drizzle",
  56: "Freezing drizzle",
  57: "Freezing drizzle",
  61: "Light rain",
  63: "Rain",
  65: "Heavy rain",
  66: "Freezing rain",
  67: "Freezing rain",
  71: "Light snow",
  73: "Snow",
  75: "Heavy snow",
  77: "Snow grains",
  80: "Light showers",
  81: "Showers",
  82: "Violent showers",
  85: "Snow showers",
  86: "Snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with hail",
  99: "Thunderstorm with hail",
};

export function weatherText(code) {
  if (typeof code !== "number" || !isFinite(code)) return "No condition data";
  return WEATHER_TEXT[code] || "Code " + code;
}

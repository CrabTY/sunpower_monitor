/* Settings/Status page: confirm a site location, then read only provable cloud facts. */

var DASH = "\u2014";
var WEATHER_WINDOW_MS = 36 * 3600000;
var state = { health: null, weather: null, location: null, candidates: [] };
var notifications = null, notificationBusy = false;

function el(id) {
  return document.getElementById(id);
}

function formatTime(iso) {
  if (!iso) return DASH;
  var when = new Date(iso);
  if (isNaN(when.getTime())) return DASH;
  return when.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, function (character) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[character];
  });
}

function fact(label, value) {
  return '<p><span class="fact-label">' + label + "</span> " + value + "</p>";
}

function setNote(html, isError) {
  el("candidates").innerHTML = '<p class="note' + (isError ? " note-error" : "") + '">' + html + "</p>";
}

function setFieldError(id, message) {
  var input = el(id), error = el(id + "-error");
  error.textContent = message;
  error.hidden = !message;
  input.setAttribute("aria-invalid", String(Boolean(message)));
}

function setCityOpen(open) {
  el("city-entry").hidden = !open;
  el("city-toggle").setAttribute("aria-expanded", String(open));
}

["grid-ratio", "city"].forEach(function (id) {
  el(id).addEventListener("input", function () { setFieldError(id, ""); });
});

function getJson(path) {
  return fetch(path, { headers: { Accept: "application/json" }, cache: "no-store" }).then(function (response) {
    if (response.status === 401) {
      window.location.href = "/auth/login";
      return null;
    }
    if (!response.ok) throw new Error("status " + response.status);
    return response.json();
  });
}

function showCalibration(data) {
  var percent = data.grid_ratio * 100;
  el("grid-ratio").value = String(Math.round(percent * 10) / 10);
  setFieldError("grid-ratio", "");
  el("calibration-status").textContent = "Saved ratio: " + percent.toFixed(1) +
    "% \u00b7 grid multiplier " + (1 / data.grid_ratio).toFixed(3) + "×" +
    (data.updated_at_utc ? " \u00b7 updated " + formatTime(data.updated_at_utc) : " \u00b7 default");
}

function showRawReadings(data) {
  var power = function (value) {
    return typeof value === "number" && isFinite(value) ? value.toFixed(2) + " kW" : DASH;
  };
  el("raw-readings").innerHTML =
    fact("Latest raw PVS grid", power(data.grid_kw)) +
    fact("Latest raw PVS home", power(data.load_kw_reported)) +
    fact("Measured", formatTime(data.measured_at_utc));
}

function renderLocation(location) {
  if (!location || !location.configured) {
    el("current").innerHTML = fact("Confirmed location", "none yet \u2014 weather and daylight stay unavailable");
    el("location-edit").open = true;
    return;
  }
  var latitude = Number(location.latitude), longitude = Number(location.longitude);
  if (!isFinite(latitude) || !isFinite(longitude)) {
    el("current").innerHTML = fact("Confirmed location", "could not be read");
    return;
  }
  var coordinates = Math.abs(latitude).toFixed(3) + "° " + (latitude < 0 ? "S" : "N") + ", " +
    Math.abs(longitude).toFixed(3) + "° " + (longitude < 0 ? "W" : "E");
  var mapUrl = "https://www.openstreetmap.org/?mlat=" + latitude + "&mlon=" + longitude +
    "#map=16/" + latitude + "/" + longitude;
  var sources = { browser_geolocation: "Device location", open_meteo_geocoding: "City or ZIP", us_census: "Street address", manual: "Coordinates" };
  el("current").innerHTML =
    fact("Approximate site", coordinates + ' <a href="' + mapUrl + '" target="_blank" rel="noopener noreferrer">Check on OpenStreetMap ↗</a>') +
    fact("Time zone", escapeHtml(location.timezone)) +
    fact("Set via", sources[location.source] || escapeHtml(location.source)) +
    fact("Confirmed", formatTime(location.updated_at_utc));
}

function renderStatus() {
  var health = state.health;
  var rows = [];
  if (!health) {
    rows.push(fact("Collector", "status could not be read"));
  } else {
    rows.push(fact("Collector", health.state));
    rows.push(
      fact(
        "Authenticated upload",
        health.authenticated_upload ? "yes \u00b7 last " + formatTime(health.last_received_at_utc) : "none received yet",
      ),
    );
    rows.push(
      fact(
        "PVS measurement",
        health.valid_measurement
          ? formatTime(health.last_measured_at_utc) + " \u00b7 quality " + (health.latest_quality || "unknown")
          : "no valid measurement yet",
      ),
    );
    rows.push(fact("History starts", formatTime(health.first_minute_at_utc)));
    rows.push(fact("Last minute window", formatTime(health.last_minute_at_utc)));
    rows.push(
      fact(
        "Panels",
        health.panels_discovered
          ? health.known_panels + " known \u00b7 last slot " + formatTime(health.last_panel_slot_at_utc)
          : "waiting for the panel list",
      ),
    );
    rows.push(fact("Pi queue backlog", "unknown \u2014 the queue stays on the Pi and is never uploaded"));
  }
  var weather = state.weather;
  if (weather === null) {
    rows.push(fact("Weather", "could not be read"));
  } else if (!weather.configured) {
    rows.push(fact("Weather", "no confirmed site location"));
  } else {
    rows.push(
      fact(
        "Weather",
        (weather.stale ? "Open-Meteo forecast (stale)" : "Open-Meteo forecast") +
          " \u00b7 fetched " + formatTime(weather.newest_fetched_at_utc),
      ),
    );
    rows.push(fact("Forecast hours stored", String((weather.hours || []).length)));
  }
  el("status").innerHTML = rows.join("");
}

function renderEvents() {
  var health = state.health;
  var events = (health && health.events) || [];
  if (events.length === 0) {
    el("events").innerHTML = '<p class="note">No collector events stored yet.</p>';
    return;
  }
  el("events").innerHTML = events
    .map(function (event) {
      return fact(formatTime(event.event_ts_utc), escapeHtml(event.event_type) + " \u00b7 " + escapeHtml(event.details_code || DASH));
    })
    .join("");
}

function renderCandidates(candidates) {
  state.candidates = candidates || [];
  if (state.candidates.length === 0) {
    setNote("No candidates matched. Try a different city or ZIP.", true);
    return;
  }
  el("candidates").innerHTML = state.candidates
    .map(function (candidate, index) {
      var zone = candidate.timezone ? candidate.timezone : "time zone unknown";
      var disabled = candidate.timezone ? "" : " disabled";
      return (
        '<article class="candidate">' +
        "<p><strong>" + escapeHtml(candidate.label) + "</strong></p>" +
        '<p class="note">' + candidate.latitude + ", " + candidate.longitude + " \u00b7 " + escapeHtml(zone) +
        " \u00b7 " + escapeHtml(candidate.source) + "</p>" +
        '<button type="button" data-save="' + index + '"' + disabled + ">Confirm and save</button>" +
        "</article>"
      );
    })
    .join("");
}

function resolve(payload) {
  setNote("Looking up candidates\u2026", false);
  fetch("/api/v1/location/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
  })
    .then(function (response) {
      if (response.status === 401) {
        window.location.href = "/auth/login";
        return null;
      }
      return response.json().then(function (data) {
        return { status: response.status, body: data };
      });
    })
    .then(function (result) {
      if (!result) return;
      if (result.status === 429) {
        setNote("Too many lookups in a short time. Wait a few minutes and try again.", true);
        return;
      }
      if (result.status !== 200) {
        setNote("Lookup failed (" + escapeHtml(result.body.error || result.status) + "). Nothing was saved.", true);
        return;
      }
      renderCandidates(result.body.candidates);
    })
    .catch(function () {
      setNote("Lookup failed. Check the connection; nothing was saved.", true);
    });
}

function save(candidate) {
  if (!candidate || !candidate.timezone) {
    setNote("That candidate has no time zone, so it cannot be used for daylight or weather.", true);
    return;
  }
  // The site location is set once. Replacing it moves weather and daylight for
  // the whole history, so a real change has to be confirmed on purpose.
  var current = state.location;
  if (
    current &&
    current.configured &&
    (Math.abs(current.latitude - candidate.latitude) > 0.005 || Math.abs(current.longitude - candidate.longitude) > 0.005)
  ) {
    var confirmed = window.confirm(
      "Replace the saved site location?\n\n" +
        "Saved: " + current.latitude + ", " + current.longitude + " (" + current.timezone + ")\n" +
        "New: " + candidate.latitude + ", " + candidate.longitude + " (" + candidate.timezone + ")\n\n" +
        "Weather and daylight are recalculated for the new place. Stored power history keeps its own timestamps and never moves.",
    );
    if (!confirmed) {
      setNote("Kept the saved location. Nothing was changed.", false);
      return;
    }
  }
  fetch("/api/v1/location", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      latitude: candidate.latitude,
      longitude: candidate.longitude,
      timezone: candidate.timezone,
      source: candidate.source,
    }),
  })
    .then(function (response) {
      if (response.status === 401) {
        window.location.href = "/auth/login";
        return null;
      }
      return response.json().then(function (body) {
        return { status: response.status, body: body };
      });
    })
    .then(function (result) {
      if (!result) return;
      if (result.status !== 200) {
        setNote("Saving failed (" + escapeHtml(result.body.error || result.status) + ").", true);
        return;
      }
      state.location = result.body;
      renderLocation(result.body);
      el("location-edit").open = false;
      setCityOpen(false);
      setNote("Saved " + result.body.latitude + ", " + result.body.longitude + " (" + escapeHtml(result.body.timezone) + ").", false);
      refreshWeather();
    })
    .catch(function () {
      setNote("Saving failed. Check the connection.", true);
    });
}

function refreshWeather() {
  var now = Date.now();
  getJson(
    "/api/v1/weather?from=" + new Date(now - WEATHER_WINDOW_MS).toISOString() +
      "&to=" + new Date(now + WEATHER_WINDOW_MS).toISOString(),
  )
    .then(function (data) {
      if (data) {
        state.weather = data;
        renderStatus();
      }
    })
    .catch(function () {});
}

function load() {
  loadNotifications();
  getJson("/api/v1/calibration")
    .then(function (data) { if (data) showCalibration(data); })
    .catch(function () { el("calibration-status").textContent = "Could not read calibration."; });
  getJson("/api/v1/live")
    .then(function (data) { if (data) showRawReadings(data); })
    .catch(function () { el("raw-readings").textContent = "Could not read raw PVS values."; });
  getJson("/api/v1/location")
    .then(function (data) {
      if (data) {
        state.location = data;
        renderLocation(data);
      }
    })
    .catch(function () {
      el("current").innerHTML = fact("Confirmed location", "could not be read");
    });
  getJson("/api/v1/health")
    .then(function (data) {
      if (!data) return;
      state.health = data;
      renderStatus();
      renderEvents();
    })
    .catch(function () {
      renderStatus();
      renderEvents();
    });
  refreshWeather();
  el("state").textContent = "Cloud reachable";
}

function notificationControls() {
  var configured = Boolean(notifications && notifications.configured);
  var enabled = Boolean(notifications && notifications.enabled);
  el("notification-save").textContent = enabled ? "Test and save device" : "Test and enable";
  var readOnly = Boolean(notifications && notifications.read_only);
  el("notification-save").disabled = notificationBusy || readOnly || !notifications || enabled && !el("bark-key").value.trim();
  el("notification-test").hidden = !configured;
  el("notification-pause").hidden = !enabled;
  el("notification-delete").hidden = !configured;
  ["notification-test", "notification-pause", "notification-delete"].forEach(function (id) {
    el(id).disabled = notificationBusy || readOnly;
  });
  el("bark-key").disabled = notificationBusy || readOnly;
}

function showNotifications(data) {
  notifications = data;
  var states = { normal: "Normal", data_missing: "Missing current readings", measurement_invalid: "Stale or invalid readings", recovering: "Confirming recovery" };
  var monitoring = { paused: "Paused", starting: "Starting", running: "Running", not_running: "Background checks may have stopped" };
  el("notification-facts").innerHTML =
    fact("Notifications", data.enabled ? "Enabled" : data.configured ? "Paused" : "Not configured") +
    (data.configured ? fact("Device", "Configured") : "") +
    (data.enabled ? fact("Background checks", monitoring[data.monitoring] || "Unknown") + fact("Readings", states[data.state] || "Unknown") : "") +
    fact("Last check", formatTime(data.last_checked_at_utc)) + fact("Last submission", formatTime(data.last_sent_at_utc)) +
    (data.last_error ? fact("Delivery", notificationError(data.last_error)) : "");
  notificationControls();
}

function notificationError(code) {
  var messages = {
    device_key_required: "Enter a Bark device Key first.",
    invalid_notification_settings: "Enter a Key with 8–128 letters, digits, dashes or underscores.",
    notification_busy: "A check or test is in progress. Wait 30 seconds and try again.",
    bark_rejected: "Bark rejected the request. Check your device Key; test and enable again.",
    bark_unreachable: "Could not reach Bark. Try again shortly.",
    key_unavailable: "The saved Key cannot be read. Paste it again and test to enable notifications.",
    notification_storage_failed: "Could not save notification settings. Try again shortly.",
    preview_read_only: "This preview is read only. Notifications cannot be sent.",
  };
  return messages[code] || "Could not update notifications. Try again shortly.";
}

function loadNotifications() {
  if (notificationBusy) return;
  getJson("/api/v1/notifications")
    .then(function (data) {
      if (data) { var initial = notifications === null; showNotifications(data); if (initial) el("notification-status").textContent = ""; }
    })
    .catch(function () { el("notification-status").textContent = "Could not read notification settings. Refresh to try again."; });
}

function updateNotifications(method, body, testing) {
  if (notifications && notifications.read_only) return;
  notificationBusy = true;
  notificationControls();
  el("notification-status").textContent = testing || body && body.enabled ? "Submitting test notification…" : "Saving…";
  return fetch("/api/v1/notifications" + (testing ? "/test" : ""), {
    method: method, headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: body === null ? undefined : JSON.stringify(body),
  }).then(function (response) {
    if (response.status === 401) { window.location.href = "/auth/login"; return null; }
    return response.json().then(function (data) {
      if (!response.ok) throw new Error(notificationError(data.error));
      showNotifications(data);
      el("notification-status").textContent = data.test_sent ? "Test submitted. Check your phone." :
        data.configured ? "Notifications paused. A previously submitted notification may still arrive." : "Notification configuration deleted.";
    });
  }).catch(function (error) {
    el("notification-status").textContent = error.message;
  }).finally(function () { notificationBusy = false; notificationControls(); });
}

el("bark-key").addEventListener("input", function () {
  setFieldError("bark-key", "");
  notificationControls();
});
el("notification-form").addEventListener("submit", function (event) {
  event.preventDefault();
  if (notificationBusy || !notifications) return;
  var key = el("bark-key").value.trim();
  if (key && !/^[A-Za-z0-9_-]{8,128}$/.test(key) || !key && !notifications.configured) {
    setFieldError("bark-key", "Paste your Bark device Key (8–128 letters, digits, dashes or underscores).");
    el("bark-key").focus(); return;
  }
  var body = { enabled: true };
  if (key) body.device_key = key;
  el("bark-key").value = "";
  setFieldError("bark-key", "");
  updateNotifications("PUT", body, false);
});
el("notification-test").addEventListener("click", function () { if (!notificationBusy) updateNotifications("POST", {}, true); });
el("notification-pause").addEventListener("click", function () { if (!notificationBusy) updateNotifications("PUT", { enabled: false }, false); });
el("notification-delete").addEventListener("click", function () {
  if (!notificationBusy) { el("bark-key").value = ""; updateNotifications("DELETE", null, false); }
});

el("calibration-form").addEventListener("submit", function (event) {
  event.preventDefault();
  var input = el("grid-ratio");
  var percent = Number(input.value);
  if (!input.checkValidity() || !isFinite(percent) || percent < 10 || percent > 200) {
    setFieldError("grid-ratio", "Enter a percentage from 10 to 200.");
    input.focus();
    return;
  }
  setFieldError("grid-ratio", "");
  el("calibration-status").textContent = "Saving…";
  fetch("/api/v1/calibration", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ grid_ratio: percent / 100 }),
  })
    .then(function (response) {
      if (response.status === 401) {
        window.location.href = "/auth/login";
        return null;
      }
      if (!response.ok) throw new Error("status " + response.status);
      return response.json();
    })
    .then(function (data) { if (data) showCalibration(data); })
    .catch(function () { el("calibration-status").textContent = "Could not save calibration. Try again."; });
});

el("candidates").addEventListener("click", function (event) {
  var button = event.target.closest("button[data-save]");
  if (!button) return;
  save(state.candidates[Number(button.dataset.save)]);
});

el("city-toggle").addEventListener("click", function () {
  var open = el("city-entry").hidden;
  setCityOpen(open);
  if (open) el("city").focus();
  else {
    state.candidates = [];
    el("candidates").innerHTML = "";
  }
});

el("use-device").addEventListener("click", function () {
  setCityOpen(false);
  state.candidates = [];
  el("candidates").innerHTML = "";
  if (!navigator.geolocation) {
    setNote("This browser has no location support. Enter a city or ZIP instead.", true);
    return;
  }
  setNote("Waiting for this device's location permission\u2026", false);
  navigator.geolocation.getCurrentPosition(
    function (position) {
      resolve({
        kind: "coordinates",
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        source: "browser_geolocation",
      });
    },
    function () {
      setNote("Location permission was refused. Enter a city or ZIP instead.", true);
    },
    { enableHighAccuracy: false, timeout: 15000, maximumAge: 600000 },
  );
});

el("city-form").addEventListener("submit", function (event) {
  event.preventDefault();
  var value = el("city").value.trim();
  if (value.length === 0) {
    setFieldError("city", "Enter a city or ZIP first.");
    el("city").focus();
    return;
  }
  setFieldError("city", "");
  resolve({ kind: "query", value: value });
});

setCityOpen(false);
load();
window.setInterval(loadNotifications, 30000);

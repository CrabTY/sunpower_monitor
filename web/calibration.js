/* The API and D1 keep PVS values raw; only page models use these estimates. */

export function gridRatio(data) {
  var value = data && data.calibration && data.calibration.grid_ratio;
  return typeof value === "number" && isFinite(value) && value >= 0.1 && value <= 2 ? value : 1;
}

function calibrated(row, ratio, gridKey, homeKey) {
  var grid = row[gridKey];
  var home = row[homeKey];
  var validGrid = typeof grid === "number" && isFinite(grid);
  var validHome = typeof home === "number" && isFinite(home);
  return {
    ...row,
    [gridKey]: validGrid ? grid / ratio : null,
    [homeKey]: validHome && (validGrid || ratio === 1)
      ? home + (validGrid ? grid / ratio - grid : 0) : null,
  };
}

export function calibrateLive(data) {
  return calibrated(data, gridRatio(data), "grid_kw", "load_kw_reported");
}

export function calibrateHistory(data) {
  var ratio = gridRatio(data);
  return { ...data, windows: (data.windows || []).map(function (row) {
    return calibrated(row, ratio, "grid_kw_avg", "load_kw_reported_avg");
  }) };
}

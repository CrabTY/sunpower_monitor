/* Native disclosure stays open on desktop and starts folded in narrow windows. */
export function initWeatherControls(control, media) {
  function sync() { control.open = !media.matches; }
  sync();
  media.addEventListener("change", sync);
}

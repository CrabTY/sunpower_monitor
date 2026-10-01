import * as echarts from "echarts/core";
import { BarChart, LineChart, PieChart } from "echarts/charts";
import { AriaComponent, AxisPointerComponent, GridComponent, MarkAreaComponent, MarkLineComponent, TooltipComponent } from "echarts/components";
import { SVGRenderer } from "echarts/renderers";

echarts.use([BarChart, LineChart, PieChart, AriaComponent, AxisPointerComponent, GridComponent, MarkAreaComponent, MarkLineComponent, TooltipComponent, SVGRenderer]);

const FALLBACK = { solar: "#e97400", solarText: "#b95300", home: "#5e7180", imported: "#377eb8", exported: "#43a340", text: "#152330", muted: "#5e7180", line: "#d9e2e8", card: "#ffffff", danger: "#984ea3" };

export function chartPalette() {
  const style = getComputedStyle(document.documentElement);
  const pick = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
  return {
    solar: pick("--solar", FALLBACK.solar), solarText: pick("--solar-text", FALLBACK.solarText), home: pick("--muted", FALLBACK.home),
    imported: pick("--grid-in", FALLBACK.imported), exported: pick("--grid-out", FALLBACK.exported),
    text: pick("--text", FALLBACK.text), muted: pick("--muted", FALLBACK.muted),
    line: pick("--line", FALLBACK.line), card: pick("--card", FALLBACK.card),
    danger: pick("--danger", FALLBACK.danger),
  };
}

export function renderEChart(container, option, height = 418) {
  container.style.height = `${height}px`;
  let chart = echarts.getInstanceByDom(container);
  if (!chart) {
    container.replaceChildren();
    chart = echarts.init(container, null, { renderer: "svg" });
  }
  chart.setOption({ animation: false, aria: { enabled: true }, ...option }, { notMerge: true });
  chart.resize();
  return chart;
}

export function clearEChart(container, message) {
  echarts.getInstanceByDom(container)?.dispose();
  container.style.height = "";
  container.innerHTML = `<p class="empty">${message}</p>`;
}

export function disposeEChart(container) {
  if (container) echarts.getInstanceByDom(container)?.dispose();
}

export function chartXValueAt(container, clientX) {
  const chart = echarts.getInstanceByDom(container);
  if (!chart) return null;
  const x = clientX - container.getBoundingClientRect().left;
  const value = chart.convertFromPixel({ xAxisIndex: 0 }, x);
  return Number.isFinite(value) ? value : null;
}

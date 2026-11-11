import { describe, expect, it } from "vitest";
import { CHART_MARGIN, Y_AXIS_WIDTH } from "./trend-chart";

describe("overview trend chart", () => {
  it("keeps the y-axis labels inside the plot area", () => {
    // A negative left margin pushed the axis ticks under the chart's edge, so the first label ("28")
    // lost its left half. A non-negative margin plus a reserved axis width keep it inside the plot.
    expect(CHART_MARGIN.left).toBeGreaterThanOrEqual(0);
    expect(Y_AXIS_WIDTH).toBeGreaterThanOrEqual(32);
    // Two digits at the 11px tick size still start at or right of the chart edge.
    expect(CHART_MARGIN.left + Y_AXIS_WIDTH - 5 - "28".length * 7).toBeGreaterThanOrEqual(0);
  });
});

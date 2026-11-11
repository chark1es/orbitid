import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { DailyCount } from "../../lib/types";
import { formatNumber } from "../../lib/format";

function shortDay(value: string): string {
  // Dates arrive as YYYY-MM-DD.
  const [, month, day] = value.split("-");
  return month && day ? `${month}/${day}` : value;
}

const axisTick = { fontSize: 11, fill: "var(--muted-foreground)", fontFamily: "var(--font-mono, ui-monospace)" };

/**
 * The plot keeps a non-negative left margin and gives the y-axis its own width: a negative margin moved
 * the axis ticks under the chart edge, clipping the first label (for example "28").
 */
export const CHART_MARGIN = { top: 8, right: 8, bottom: 0, left: 0 } as const;
export const Y_AXIS_WIDTH = 36;

const tooltipStyle = {
  borderRadius: 4,
  border: "1px solid var(--border)",
  background: "var(--popover)",
  color: "var(--popover-foreground)",
  fontSize: 12,
  boxShadow: "0 6px 16px -8px oklch(0.2 0.01 60 / 0.35)",
};

/**
 * One daily count series. Daily counts arrive as small integers, so columns read more honestly than
 * a line: a zero day is an absent column, not a dip in a curve.
 */
export function TrendChart({
  data,
  tone,
  label,
}: {
  data: DailyCount[];
  tone: "ink" | "signal";
  label: string;
}) {
  const color = tone === "signal" ? "var(--signal)" : "var(--foreground)";

  return (
    <ResponsiveContainer width="100%" height={170}>
      <BarChart data={data} margin={CHART_MARGIN}>
        <CartesianGrid strokeDasharray="2 4" vertical={false} stroke="var(--border)" />
        <XAxis
          dataKey="date"
          tickFormatter={shortDay}
          tickLine={false}
          axisLine={false}
          minTickGap={28}
          tick={axisTick}
        />
        {/* The axis keeps its own width so the first tick label is drawn inside the plot instead of
            under the chart's left edge. */}
        <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={Y_AXIS_WIDTH} tick={axisTick} />
        <Tooltip
          labelFormatter={(value) => shortDay(String(value))}
          formatter={(value) => [formatNumber(Number(value)), label]}
          contentStyle={tooltipStyle}
          cursor={{ fill: "var(--muted)", fillOpacity: 0.4 }}
        />
        <Bar dataKey="count" name={label} fill={color} maxBarSize={12} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}

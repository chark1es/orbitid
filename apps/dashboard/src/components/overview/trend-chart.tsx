import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { DailyCount } from "../../lib/types";
import { formatNumber } from "../../lib/format";

function shortDay(value: string): string {
  // Dates arrive as YYYY-MM-DD.
  const [, month, day] = value.split("-");
  return month && day ? `${month}/${day}` : value;
}

const axisTick = { fontSize: 11, fill: "var(--muted-foreground)", fontFamily: "var(--font-mono, ui-monospace)" };

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
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -22 }}>
        <CartesianGrid strokeDasharray="2 4" vertical={false} stroke="var(--border)" />
        <XAxis
          dataKey="date"
          tickFormatter={shortDay}
          tickLine={false}
          axisLine={false}
          minTickGap={28}
          tick={axisTick}
        />
        <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={40} tick={axisTick} />
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

import { useId } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { DailyCount } from "../../lib/types";
import { formatNumber } from "../../lib/format";

function shortDay(value: string): string {
  // Dates arrive as YYYY-MM-DD.
  const [, month, day] = value.split("-");
  return month && day ? `${month}/${day}` : value;
}

const tooltipStyle = {
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border)",
  background: "var(--popover)",
  color: "var(--popover-foreground)",
  fontSize: 12,
};

/**
 * Sign-ups / sign-ins trend. Both charts share axes, tooltip and theme tokens; only the mark differs.
 */
export function TrendChart({
  data,
  kind,
  color,
  label,
}: {
  data: DailyCount[];
  kind: "area" | "bar";
  color: string;
  label: string;
}) {
  const gradientId = `trend-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const axisProps = {
    dataKey: "date",
    tickFormatter: shortDay,
    tickLine: false,
    axisLine: false,
    minTickGap: 24,
  } as const;
  const tooltip = (
    <Tooltip
      labelFormatter={(value) => shortDay(String(value))}
      formatter={(value) => [formatNumber(Number(value)), label]}
      contentStyle={tooltipStyle}
    />
  );

  return (
    <ResponsiveContainer width="100%" height={240}>
      {kind === "area" ? (
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.35} />
              <stop offset="100%" stopColor={color} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
          <XAxis {...axisProps} />
          <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={44} />
          {tooltip}
          <Area type="monotone" dataKey="count" name={label} stroke={color} strokeWidth={2} fill={`url(#${gradientId})`} />
        </AreaChart>
      ) : (
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
          <XAxis {...axisProps} />
          <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={44} />
          {tooltip}
          <Bar dataKey="count" name={label} fill={color} radius={[4, 4, 0, 0]} maxBarSize={22} />
        </BarChart>
      )}
    </ResponsiveContainer>
  );
}

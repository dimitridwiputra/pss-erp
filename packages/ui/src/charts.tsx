const DONUT_COLORS = ['var(--pss-navy-900)', 'var(--pss-red-600)', 'var(--info-700)', 'var(--success-700)', 'var(--warning-700)', 'var(--gray-400)'];

export type TrendPoint = { label: string; value: number };

/** Hand-rolled SVG line + area chart — no charting library, kept consistent with the rest of `@pss/ui`. */
export function TrendLineChart({ points, height = 160 }: { points: readonly TrendPoint[]; height?: number }) {
  const width = 600;
  if (points.length === 0) return <p>Tidak ada data pada periode ini.</p>;
  const max = Math.max(1, ...points.map((p) => p.value));
  const min = Math.min(0, ...points.map((p) => p.value));
  const range = max - min || 1;
  const stepX = points.length > 1 ? width / (points.length - 1) : 0;
  const coords = points.map((p, i) => ({ x: i * stepX, y: height - ((p.value - min) / range) * height }));
  const linePath = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L${(coords[coords.length - 1]?.x ?? 0).toFixed(1)},${height} L0,${height} Z`;
  const showEveryLabel = points.length <= 12;

  return (
    <div className="pss-linechart">
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="Grafik tren">
        <path d={areaPath} className="pss-linechart-area" />
        <path d={linePath} className="pss-linechart-line" />
        {coords.map((c, i) => <circle key={i} cx={c.x} cy={c.y} r={3.5} className="pss-linechart-dot" />)}
      </svg>
      <div className="pss-linechart-labels">
        {points.map((p, i) => (showEveryLabel || i % Math.ceil(points.length / 12) === 0) ? <span key={p.label + i}>{p.label}</span> : <span key={p.label + i} aria-hidden="true" />)}
      </div>
    </div>
  );
}

export type DonutSegment = { label: string; value: number };

/** Hand-rolled SVG donut chart with a legend — segments colored from a fixed, token-derived palette. */
export function DonutChart({ segments, totalLabel = 'total' }: { segments: readonly DonutSegment[]; totalLabel?: string }) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  const radius = 60;
  const circumference = 2 * Math.PI * radius;
  let cumulative = 0;

  return (
    <div className="pss-donut">
      <svg viewBox="0 0 160 160" width="160" height="160" role="img" aria-label={`Diagram donat, total ${total}`}>
        <g transform="translate(80,80) rotate(-90)">
          {total === 0
            ? <circle r={radius} fill="none" stroke="var(--gray-200)" strokeWidth={22} />
            : segments.map((segment, i) => {
              const fraction = segment.value / total;
              const dash = fraction * circumference;
              const offset = -cumulative * circumference;
              cumulative += fraction;
              return (
                <circle
                  key={segment.label} r={radius} fill="none" stroke={DONUT_COLORS[i % DONUT_COLORS.length]}
                  strokeWidth={22} strokeDasharray={`${dash} ${circumference - dash}`} strokeDashoffset={offset}
                />
              );
            })}
        </g>
        <text x="80" y="76" textAnchor="middle" className="pss-donut-total">{total}</text>
        <text x="80" y="94" textAnchor="middle" className="pss-donut-caption">{totalLabel}</text>
      </svg>
      <ul className="pss-donut-legend">
        {segments.map((segment, i) => (
          <li key={segment.label}>
            <span className="pss-donut-swatch" style={{ background: DONUT_COLORS[i % DONUT_COLORS.length] }} aria-hidden="true" />
            <span className="pss-donut-legend-label">{segment.label}</span>
            <span className="pss-donut-legend-value">{segment.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export type BarDatum = { label: string; value: number };

/** Horizontal bar chart — used for backlog-per-type and short-reason style breakdowns. */
export function HorizontalBarChart({ bars }: { bars: readonly BarDatum[] }) {
  const max = Math.max(1, ...bars.map((b) => b.value));
  return (
    <div className="pss-hbar-chart">
      {bars.map((bar) => (
        <div className="pss-hbar-row" key={bar.label}>
          <span className="pss-hbar-label">{bar.label}</span>
          <div className="pss-hbar-track"><span className="pss-hbar-fill" style={{ width: `${(bar.value / max) * 100}%` }} /></div>
          <span className="pss-hbar-value">{bar.value}</span>
        </div>
      ))}
    </div>
  );
}

/** Vertical bar chart — used for hour-by-hour / day-by-day throughput. */
export function VerticalBarChart({ bars }: { bars: readonly BarDatum[] }) {
  const max = Math.max(1, ...bars.map((b) => b.value));
  return (
    <div className="pss-bar-chart" role="img" aria-label="Grafik batang">
      {bars.map((bar, i) => (
        <div className="pss-bar-chart-bar" key={bar.label + i}>
          <span className="pss-bar-chart-value">{bar.value}</span>
          <span className="pss-bar-chart-fill" style={{ height: `${Math.max(4, (bar.value / max) * 100)}%` }} />
          <span className="pss-bar-chart-label">{bar.label}</span>
        </div>
      ))}
    </div>
  );
}

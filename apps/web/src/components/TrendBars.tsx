import type { TrendBucket } from '../reports.js';
import { formatKes } from '../pages/FinancePage.js';

/**
 * Income and spending over the report period. Two bars per bucket, drawn with
 * CSS so the phone needs no chart library, and the numbers are printed under
 * each pair for screen readers and for print.
 */
export function TrendBars({ buckets }: { buckets: TrendBucket[] }) {
  const max = Math.max(0, ...buckets.flatMap((bucket) => [bucket.revenueKes, bucket.spendKes]));

  if (buckets.length === 0 || max === 0) {
    return <p className="muted">No priced sales or approved expenses in this period.</p>;
  }

  const height = (value: number) => {
    if (value <= 0) return 0;
    return Math.max(4, Math.round((value / max) * 100));
  };

  return (
    <div>
      <div className="trend" role="group" aria-label="Money in and out by period">
        {buckets.map((bucket) => (
          <div className="trend-bucket" key={`${bucket.startDay}:${bucket.endDay}`}>
            <div className="trend-bars" aria-hidden="true">
              <span
                className="trend-bar trend-bar--in"
                style={{ height: `${height(bucket.revenueKes)}%` }}
              />
              <span
                className="trend-bar trend-bar--out"
                style={{ height: `${height(bucket.spendKes)}%` }}
              />
            </div>
            <span className="trend-label">{bucket.label}</span>
            <span className="trend-numbers">
              <span>{formatKes(bucket.revenueKes)}</span>
              <span>{formatKes(bucket.spendKes)}</span>
            </span>
          </div>
        ))}
      </div>
      <p className="trend-key">
        <span>
          <i className="trend-swatch trend-swatch--in" aria-hidden="true" /> In
        </span>
        <span>
          <i className="trend-swatch trend-swatch--out" aria-hidden="true" /> Out
        </span>
      </p>
    </div>
  );
}

/**
 * What a screen looks like while its data is on the way — instead of a false empty state.
 * "0 completed audits" for a second before the real number lands is a number someone
 * screenshots into WhatsApp (B8). A skeleton has the shape of what is coming and no value
 * in it: no digit, no band colour, nothing that could be read as data.
 *
 * - `tiles`: KPI or Zone tiles, `count` of them, in the board's own grid.
 * - `rows`: a table — the real column heads (`columns`), so nothing moves when rows land.
 * - `chart`: a trend chart's box with its axis, and no line.
 *
 * It pulses slowly; under reduced motion it holds still. Screen readers hear `label` once.
 * Render it only while the query is loading — never as an empty state.
 */
export function Skeleton(
  props:
    | { variant: 'tiles'; count?: number; label?: string }
    | { variant: 'rows'; columns: string[]; rows?: number; label?: string }
    | { variant: 'chart'; label?: string },
) {
  const label = props.label ?? 'Loading…';
  return (
    <div className="gb-skeleton" role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      <div aria-hidden="true">
        {props.variant === 'tiles' ? <Tiles count={props.count ?? 4} /> : null}
        {props.variant === 'rows' ? <Rows columns={props.columns} rows={props.rows ?? 5} /> : null}
        {props.variant === 'chart' ? <Chart /> : null}
      </div>
    </div>
  );
}

function Tiles({ count }: { count: number }) {
  return (
    <div className="gb-skeleton-tiles">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="gb-skeleton-tile">
          <i className="gb-skeleton-bar" style={{ width: '46%' }} />
          <i className="gb-skeleton-bar gb-skeleton-bar--figure" style={{ width: '38%' }} />
          <i className="gb-skeleton-bar" style={{ width: '70%' }} />
          <i className="gb-skeleton-band" />
        </div>
      ))}
    </div>
  );
}

/** Varied widths, so the rows read as text to come rather than a striped pattern. */
const ROW_WIDTHS = ['72%', '48%', '60%', '36%', '54%', '66%'];

function Rows({ columns, rows }: { columns: string[]; rows: number }) {
  return (
    <div className="gb-tablewrap gb-tablewrap--flush">
      <table className="gb-table--register">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }, (_, row) => (
            <tr key={row}>
              {columns.map((column, index) => (
                <td key={column}>
                  <i
                    className="gb-skeleton-bar"
                    style={{ width: ROW_WIDTHS[(row + index * 2) % ROW_WIDTHS.length] }}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Chart() {
  return (
    <div className="gb-skeleton-chart">
      <i className="gb-skeleton-bar" style={{ width: '30%' }} />
      <div className="gb-skeleton-plot" />
    </div>
  );
}

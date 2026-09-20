import qrcode from 'qrcode-generator';

/**
 * The corrective-action link as a scannable square (§10.4, DECISIONS.md R-14).
 *
 * **Why a PDF needs this at all.** The link was printed as a single `<a>` and nothing
 * else. Chromium does emit a proper `/Link` annotation for it — but that annotation is
 * 15 pt tall, and a viewer fitting an A4 page to a 390 px phone screen draws it about ten
 * pixels high. Worse, the viewers these reports actually arrive in on a phone — WhatsApp's,
 * Gmail's preview, Drive's — commonly drop link annotations altogether. The result was a
 * button that worked on a desktop and was inert on a phone, which is where the Zone Leader
 * reading it is standing.
 *
 * So the link is now carried three ways, because no single one survives every viewer:
 * this square, the URL as selectable text, and the annotation that was always there. The
 * square is the one that works cross-device — the report open on a laptop or printed and
 * pinned to the board, the camera in the reader's hand.
 *
 * **Constraints this file is written against**, both from STACK.md §5:
 *
 *   * **Deterministic.** Same text in, same modules out — no clock, no randomness, and the
 *     mask is chosen by the spec's penalty score rather than arbitrarily. The byte-stability
 *     assertion (PART 15.7) covers this code too.
 *   * **No JavaScript-dependent layout.** What leaves here is a module matrix; the template
 *     draws it as inline SVG with a `viewBox`, which WeasyPrint renders as readily as
 *     Chromium. Nothing is measured, and nothing is drawn to a canvas.
 */

/** Error correction level. `M` — 15 % recovery, the usual choice for a URL. */
const ERROR_CORRECTION = 'M';

/**
 * The quiet zone, in modules. **Four is the specification's minimum, not a margin to
 * taste**: a scanner locates the symbol by finding clear space around it, and a QR code
 * printed flush against a border is the single most common reason one will not read.
 */
export const QUIET_ZONE_MODULES = 4;

export interface QrSymbol {
  /** Modules per side, quiet zone included — the SVG `viewBox` is `0 0 size size`. */
  readonly size: number;
  /** The dark modules as one SVG path, already offset by the quiet zone. */
  readonly path: string;
}

/**
 * Encode `text` and return what the template needs to draw it.
 *
 * The type number is left automatic: a 43-character `base64url` secret on a hostname lands
 * at version 5 or 6, and pinning a version would mean a longer host silently failing to
 * encode rather than growing by four modules.
 *
 * Non-ASCII is percent-encoded first. The library's default byte encoder truncates each
 * character to its low byte, so a non-ASCII host would otherwise encode to a symbol that
 * scans cleanly and resolves to the wrong address — a failure worth ruling out here rather
 * than discovering from a report already issued.
 */
export function encodeQr(text: string): QrSymbol {
  const code = qrcode(0, ERROR_CORRECTION);
  code.addData(encodeURI(text), 'Byte');
  code.make();

  const count = code.getModuleCount();
  return {
    size: count + QUIET_ZONE_MODULES * 2,
    path: pathFor(code, count),
  };
}

/**
 * The dark modules as one path, run-length merged along each row.
 *
 * One path rather than a rect per module: a version 6 symbol is 1681 modules, and roughly
 * half of them dark would be 800 elements in a document that already carries a photograph
 * per finding. Merging horizontal runs is both smaller and exactly as crisp — the shapes
 * are identical, and `shape-rendering="crispEdges"` in the template keeps their edges on
 * pixel boundaries when a viewer rasterises at a low zoom.
 */
function pathFor(code: ReturnType<typeof qrcode>, count: number): string {
  const segments: string[] = [];

  for (let row = 0; row < count; row += 1) {
    let runStart: number | null = null;

    for (let column = 0; column <= count; column += 1) {
      const dark = column < count && code.isDark(row, column);

      if (dark && runStart === null) {
        runStart = column;
      } else if (!dark && runStart !== null) {
        const width = column - runStart;
        const x = runStart + QUIET_ZONE_MODULES;
        const y = row + QUIET_ZONE_MODULES;
        segments.push(`M${x} ${y}h${width}v1h-${width}z`);
        runStart = null;
      }
    }
  }

  return segments.join('');
}

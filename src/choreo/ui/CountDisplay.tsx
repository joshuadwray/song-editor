/**
 * The big read-out: where she is in the dance, legible from across the studio.
 *
 * In phase 2 the rehearsal video takes this space, with the counts overlaid.
 */

import { SECTION_COLORS } from '../../../choreo/app.config';
import type { Position } from '../model/grid';
import { noteAt, sectionAt, type Piece } from '../model/piece';
import { ecLabel } from './format';

export function CountDisplay({ piece, pos, beforeStart }: { piece: Piece; pos: Position; beforeStart: boolean }) {
  const section = sectionAt(piece, pos.ec);
  const note = noteAt(piece, pos.ec);
  const next = noteAt(piece, pos.ec + 1);
  return (
    <section className="count-display" aria-label="Current count">
      <div className="cd-top">
        {section ? (
          <span className="cd-section" style={{ background: SECTION_COLORS[section.color % SECTION_COLORS.length] }}>
            {section.name}
          </span>
        ) : <span />}
        <span className="cd-ec" data-testid="current-ec">
          {beforeStart ? 'Before count 1' : `8-count ${ecLabel(pos.ec)}`}
        </span>
      </div>
      <div className="cd-counts" aria-hidden={beforeStart}>
        {[1, 2, 3, 4, 5, 6, 7, 8].map((c) => (
          <span key={c} className={`cd-count ${c === pos.count ? 'now' : ''} ${c < pos.count ? 'past' : ''}`}>{c}</span>
        ))}
      </div>
      <div className="cd-note">{note || <span className="faint">No notes for this 8-count yet</span>}</div>
      {next && <div className="cd-next"><span className="faint">Next:</span> {next.split('\n')[0]}</div>}
    </section>
  );
}

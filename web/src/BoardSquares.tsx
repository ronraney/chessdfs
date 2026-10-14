// Task 38b: the board's own checker pattern, drawn as 64 real squares (not
// a CSS gradient trick) so it's guaranteed to land on the same 8x8 grid
// chessground itself uses for pieces/highlights -- the previous
// `background-image: linear-gradient(...)` override in index.css tiled at
// half the board's actual resolution (4x4, each tile split diagonally),
// which is what produced both reported bugs at once: wedge-shaped tiles
// instead of a true checker, AND every real highlight/piece looking
// "offset" against that wrong-scale backdrop (e.g. a last-move highlight on
// e4 reading as if it sat on e2/e3) -- not an actual chessground
// positioning bug, just a background that never matched its own grid.
// Rendered behind chessground's own (now-transparent) cg-board, absolutely
// filling the same square frame -- see BuildBoard.tsx/BoardPreview.tsx.
import "./BoardSquares.css";

const FILES = "abcdefgh";

interface Props {
  // Build screen only (Task 38b): small rank/file labels in the corner of
  // each edge square, matching the PNGs. The opening-setup preview board
  // doesn't show them (too small to read, and the mockups never show any).
  labels?: boolean;
}

export default function BoardSquares({ labels = false }: Props) {
  const squares = [];
  for (let row = 0; row < 8; row++) {
    const rank = 8 - row;
    for (let col = 0; col < 8; col++) {
      const light = (row + col) % 2 === 0;
      const file = FILES[col];
      squares.push(
        <div key={`${row}-${col}`} className={light ? "board-square light" : "board-square dark"}>
          {labels && col === 0 && <span className="board-square-rank">{rank}</span>}
          {labels && row === 7 && <span className="board-square-file">{file}</span>}
        </div>,
      );
    }
  }
  return (
    <div className="board-squares" aria-hidden="true">
      {squares}
    </div>
  );
}

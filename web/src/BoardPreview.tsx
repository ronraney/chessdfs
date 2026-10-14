// Task 34: a small, read-only board preview for whichever opening line
// is currently selected on the opening setup screen. chessground has no
// chess logic of its own (per its own docs) -- it just renders a FEN;
// `viewOnly` disables every interaction (drag, click-to-move, premoves),
// since this is a preview, not a board to play on.
import "@lichess-org/chessground/assets/chessground.base.css";
import "@lichess-org/chessground/assets/chessground.brown.css";
import "@lichess-org/chessground/assets/chessground.cburnett.css";
import { Chessground } from "@lichess-org/chessground";
import type { Api } from "@lichess-org/chessground/api";
import { useEffect, useRef } from "react";

interface Props {
  fen: string;
}

export default function BoardPreview({ fen }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<Api | null>(null);

  useEffect(() => {
    if (containerRef.current === null) return;
    apiRef.current = Chessground(containerRef.current, {
      fen,
      viewOnly: true,
      coordinates: false,
      animation: { enabled: false },
    });
    return () => apiRef.current?.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    apiRef.current?.set({ fen });
  }, [fen]);

  return <div className="board-preview" ref={containerRef} />;
}

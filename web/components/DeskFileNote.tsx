import { navigate } from "../lib/router.ts";
import { DESK_FILE_ROUTE, setCodeView } from "../agent/parts.tsx";

// D-84: a quiet line under settings that desk.yaml also holds, with a link to the file in the
// Agent page's Code view.

export function openDeskFile(): void {
  setCodeView(true);
  navigate(DESK_FILE_ROUTE);
}

export function DeskFileNote() {
  return (
    <p className="desk-file-note">
      Also in <code>desk.yaml</code> ·{" "}
      <a href={DESK_FILE_ROUTE} onClick={(e) => { e.preventDefault(); openDeskFile(); }}>View code</a>
    </p>
  );
}

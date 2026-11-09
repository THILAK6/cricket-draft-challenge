import { useRef, useState } from "preact/hooks";
import { api } from "../api";
import type { RoomProps } from "./Draft";

/**
 * Moves a player in the user's XI: the new order shows straight away and the server's copy
 * replaces it (or the old order comes back with an error).
 */
export async function reorderXI(props: Pick<RoomProps, "state" | "roomId" | "onState" | "toast">, from: number, to: number) {
  const squad = props.state.userPicks;
  if (to < 0 || to > 10 || from === to || !squad[from]) return;
  const optimistic = squad.slice();
  const [m] = optimistic.splice(from, 1);
  optimistic.splice(to, 0, m);
  props.onState({ ...props.state, userPicks: optimistic });
  try {
    const { state: next } = await api.reorder(props.roomId, from, to);
    props.onState(next);
  } catch (e) {
    props.onState(props.state);
    props.toast((e as Error).message, "error");
  }
}

/**
 * Dragging a row of an XI by its handle (pointer events, so touch works): where it started, where it
 * would land, and how far it has moved. The rows between make room as it passes.
 */
export function useDragOrder(onMove: (from: number, to: number) => void, enabled = true) {
  const [drag, setDrag] = useState<{ from: number; to: number; dy: number } | null>(null);
  const ref = useRef<{ from: number; to: number; startY: number; rowH: number } | null>(null);

  const onGrab = (i: number, e: PointerEvent) => {
    if (!enabled || e.button > 0) return;
    const row = (e.currentTarget as HTMLElement).closest(".xrow") as HTMLElement | null;
    if (!row) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    ref.current = { from: i, to: i, startY: e.clientY, rowH: row.getBoundingClientRect().height };
    setDrag({ from: i, to: i, dy: 0 });
    e.preventDefault();
  };
  const onDrag = (e: PointerEvent) => {
    const d = ref.current;
    if (!d) return;
    const dy = e.clientY - d.startY;
    d.to = Math.max(0, Math.min(10, d.from + Math.round(dy / d.rowH)));
    setDrag({ from: d.from, to: d.to, dy });
  };
  const onDrop = () => {
    const d = ref.current;
    ref.current = null;
    setDrag(null);
    if (d && d.to !== d.from) onMove(d.from, d.to);
  };
  const onCancel = () => {
    ref.current = null;
    setDrag(null);
  };
  /** The batting spot a row will have if the dragged row is dropped where it is now. */
  const landing = (i: number) => {
    if (!drag) return i;
    if (i === drag.from) return drag.to;
    if (drag.from < drag.to && i > drag.from && i <= drag.to) return i - 1;
    if (drag.from > drag.to && i < drag.from && i >= drag.to) return i + 1;
    return i;
  };
  /** Rows between the start and the landing spot make room for the dragged one. */
  const rowStyle = (i: number) => {
    if (!drag || !ref.current) return undefined;
    const h = ref.current.rowH;
    if (i === drag.from) return { transform: `translateY(${drag.dy}px)` };
    if (drag.from < drag.to && i > drag.from && i <= drag.to) return { transform: `translateY(${-h}px)` };
    if (drag.from > drag.to && i < drag.from && i >= drag.to) return { transform: `translateY(${h}px)` };
    return { transform: "translateY(0)" };
  };
  /** Props for the drag handle of row i (arrow keys work too). */
  const gripProps = (i: number, label: string) => ({
    "aria-label": `Move ${label}, batting at ${i + 1}: drag, or use the arrow keys`,
    onPointerDown: (e: Event) => onGrab(i, e as unknown as PointerEvent),
    onPointerMove: (e: Event) => onDrag(e as unknown as PointerEvent),
    onPointerUp: onDrop,
    onPointerCancel: onCancel,
    onKeyDown: (e: KeyboardEvent) => {
      if (!enabled) return;
      if (e.key === "ArrowUp" && i > 0) (e.preventDefault(), onMove(i, i - 1));
      if (e.key === "ArrowDown" && i < 10) (e.preventDefault(), onMove(i, i + 1));
    },
  });
  return { drag, landing, rowStyle, gripProps };
}

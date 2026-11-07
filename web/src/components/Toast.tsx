import { useRef, useState } from "preact/hooks";

export type ToastKind = "info" | "error";
export type ShowToast = (text: string, kind?: ToastKind) => void;

/** One toast at a time: a new message replaces the old one. */
export function useToast() {
  const [current, setCurrent] = useState<{ text: string; kind: ToastKind } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const show: ShowToast = (text, kind = "info") => {
    window.clearTimeout(timer.current);
    setCurrent({ text, kind });
    timer.current = window.setTimeout(() => setCurrent(null), kind === "error" ? 4500 : 2500);
  };
  return { current, show };
}

export function Toast({ toast }: { toast: { text: string; kind: ToastKind } | null }) {
  if (!toast) return null;
  return (
    <div class={`toast ${toast.kind === "error" ? "error" : ""}`} role="status" aria-live="polite">
      {toast.text}
    </div>
  );
}

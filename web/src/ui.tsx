import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { formatEuro, parseEuro } from "../../src/shared/money";

// ---------- Toasts ----------
type ToastItem = { id: number; msg: string; kind: "ok" | "err" };
let toasts: ToastItem[] = [];
const listeners = new Set<() => void>();
let nextId = 1;

export function toast(msg: string, kind: "ok" | "err" = "ok") {
  const t = { id: nextId++, msg, kind };
  toasts = [...toasts, t];
  listeners.forEach((l) => l());
  setTimeout(() => {
    toasts = toasts.filter((x) => x.id !== t.id);
    listeners.forEach((l) => l());
  }, kind === "err" ? 6000 : 3000);
}

export function Toaster() {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return (
    <div class="toaster" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} class={`toast ${t.kind}`}>
          {t.msg}
        </div>
      ))}
    </div>
  );
}

// ---------- Modal ----------
export function Modal(props: { title: string; onClose?: () => void; children: ComponentChildren; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Browser fokussieren dynamisch eingefügte Felder nicht von selbst
    const el = [...(ref.current?.querySelectorAll<HTMLElement>("input,button") ?? [])].find((e) => (e as HTMLInputElement).autofocus);
    el?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose?.();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.onClose]);
  return (
    <div class="overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onClose?.()}>
      <div ref={ref} class={`modal ${props.wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={props.title}>
        <div class="modal-head">
          <h2>{props.title}</h2>
          {props.onClose && (
            <button class="icon-btn" onClick={props.onClose} aria-label="Schließen">
              ✕
            </button>
          )}
        </div>
        <div class="modal-body">{props.children}</div>
      </div>
    </div>
  );
}

// ---------- Geldeingabe ----------
export function MoneyField(props: {
  label: string;
  value: string;
  onInput: (v: string) => void;
  placeholder?: string;
  autofocus?: boolean;
  hint?: string;
}) {
  const invalid = props.value.trim() !== "" && parseEuro(props.value) === null;
  return (
    <label class="field">
      <span>{props.label}</span>
      <div class={`money ${invalid ? "invalid" : ""}`}>
        <input
          type="text"
          inputMode="decimal"
          value={props.value}
          placeholder={props.placeholder ?? "0,00"}
          autoFocus={props.autofocus}
          onInput={(e) => props.onInput((e.target as HTMLInputElement).value)}
        />
        <b>€</b>
      </div>
      {invalid ? <small class="err">Bitte einen Betrag wie 1,50 eingeben</small> : props.hint ? <small>{props.hint}</small> : null}
    </label>
  );
}

export const euro = formatEuro;

/** Logo: Registrierkasse (Farben folgen dem Theme) */
export function RegisterIcon(props: { size?: number }) {
  return (
    <svg width={props.size ?? 46} height={props.size ?? 46} viewBox="0 0 64 64" aria-hidden="true">
      <rect x="19" y="8" width="26" height="12" rx="3" fill="var(--brand-ink)" />
      <rect x="23" y="12" width="18" height="4" rx="1.5" fill="var(--brand)" />
      <path d="M15 23h34l6 17H9z" fill="var(--brand-ink)" />
      <g fill="var(--brand)">
        <rect x="19" y="27" width="6" height="3.5" rx="1" />
        <rect x="29" y="27" width="6" height="3.5" rx="1" />
        <rect x="39" y="27" width="6" height="3.5" rx="1" />
        <rect x="17.5" y="33" width="6" height="3.5" rx="1" />
        <rect x="29" y="33" width="6" height="3.5" rx="1" />
        <rect x="40.5" y="33" width="6" height="3.5" rx="1" />
      </g>
      <rect x="8" y="42" width="48" height="12" rx="3.5" fill="var(--brand-ink)" />
      <rect x="25" y="46.5" width="14" height="3" rx="1.5" fill="var(--brand)" />
    </svg>
  );
}

export function Stat(props: { label: string; value: string; tone?: "good" | "warn" | "bad" }) {
  return (
    <div class={`stat ${props.tone ?? ""}`}>
      <span>{props.label}</span>
      <b>{props.value}</b>
    </div>
  );
}

export function diffTone(d: number | null): "good" | "warn" | "bad" | undefined {
  if (d == null) return undefined;
  return d === 0 ? "good" : Math.abs(d) <= 50 ? "warn" : "bad";
}

export function diffLabel(d: number | null): string {
  if (d == null) return "–";
  if (d === 0) return "stimmt genau";
  return `${d > 0 ? "+" : ""}${formatEuro(d)} (${d > 0 ? "Überschuss" : "Fehlbetrag"})`;
}

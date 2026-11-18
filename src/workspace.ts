import type { WriteResult } from "./collection.js";

/** Wspólny interfejs trybów: central (sesja z branchem i MR-em) i local (pliki w bieżącym repo). */
export interface Workspace {
  mode: "central" | "local";
  /** Opis miejsca pracy do instrukcji dla modelu. */
  label: string;
  /** Zmienne przekazywane do bru jako process.env (tylko tryb central — z nagłówków). */
  secrets: Record<string, string>;
  read<T>(fn: (root: string) => Promise<T>): Promise<T>;
  write(fn: (root: string) => Promise<WriteResult>): Promise<string>;
  /** Tylko tryb central. */
  status?(): Promise<string>;
  newMr?(): Promise<string>;
}

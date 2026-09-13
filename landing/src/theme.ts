// Theme: system / light / dark, shared with the app through the same storage
// key, applied as data-theme on <html>. The 3D scene subscribes too.

import { useSyncExternalStore } from "react";

export type ThemePref = "system" | "light" | "dark";
export type ThemeMode = "light" | "dark";

const KEY = "mx402.theme";
const media = () => window.matchMedia("(prefers-color-scheme: dark)");

export function getPref(): ThemePref {
  try {
    const t = localStorage.getItem(KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

export const resolveMode = (p: ThemePref): ThemeMode => (p === "system" ? (media().matches ? "dark" : "light") : p);

const listeners = new Set<() => void>();
let snapshot = `${getPref()}:${resolveMode(getPref())}`;
function emit() {
  snapshot = `${getPref()}:${resolveMode(getPref())}`;
  listeners.forEach((l) => l());
}

export function setPref(p: ThemePref) {
  if (p === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", p);
  try {
    if (p === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, p);
  } catch {}
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", resolveMode(p) === "dark" ? "#1a1a20" : "#f5f4ee");
  emit();
}

media().addEventListener("change", emit);

export function useTheme() {
  const snap = useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    () => snapshot,
  );
  const [pref, mode] = snap.split(":") as [ThemePref, ThemeMode];
  return { pref, mode, setPref };
}

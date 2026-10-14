// Task 36: Club/Slate theme toggle, shown in the header on every screen.
// "Active" is whichever theme is actually rendering right now -- an
// explicit saved choice, or (absent one) the device's prefers-color-scheme,
// tracked live so the toggle stays in sync if the device setting changes
// while the choice is still "follow device."
import { useEffect, useState } from "react";
import "./ThemeToggle.css";
import { devicePrefersSlate, getSavedTheme, saveTheme, type Theme } from "./theme";

export default function ThemeToggle() {
  const [saved, setSaved] = useState<Theme | null>(() => getSavedTheme());
  const [deviceSlate, setDeviceSlate] = useState<boolean>(() => devicePrefersSlate());

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    function onChange(event: MediaQueryListEvent): void {
      setDeviceSlate(event.matches);
    }
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  const active: Theme = saved ?? (deviceSlate ? "slate" : "club");

  function choose(theme: Theme): void {
    saveTheme(theme);
    setSaved(theme);
  }

  return (
    <div className="theme-toggle" role="group" aria-label="Theme">
      <button
        type="button"
        className={active === "club" ? "theme-option selected" : "theme-option"}
        aria-pressed={active === "club"}
        onClick={() => choose("club")}
      >
        Club
      </button>
      <button
        type="button"
        className={active === "slate" ? "theme-option selected" : "theme-option"}
        aria-pressed={active === "slate"}
        onClick={() => choose("slate")}
      >
        Slate
      </button>
    </div>
  );
}

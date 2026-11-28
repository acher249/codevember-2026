"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type SyntheticEvent } from "react";
import { hovered, ITEMS, pack, type ItemKind, type Rarity } from "./collectibles";
import { Inspect, inspect } from "./inspect";
import { PANEL, panels } from "./panels";
import { PhotoRoll, photos, PhotoViewer, usePhotos, Viewfinder, viewfinder } from "./photos";
import { supply } from "./torches";
import { ladders, LadderIcon } from "./ladder";
import { touchActions, TOUCH_QUERY, useTouch } from "./touch";

// The backpack: a glass panel listing what you have found (open from the start on a desktop), opened with I or Tab or
// its button, whose bag bumps with a "+1" as each find's card (found.tsx) lands in it; click a find to take it out and
// turn it over (inspect.tsx).
// Beside it the camera roll (photos.tsx), and the button that raises the camera (P). Each item's icon is the find itself, rendered at load
// (a painted stand-in until then). Every panel blocks the scene: nothing pressed on one digs or looks round.

export const RARITY: Record<Rarity, string> = { Common: "#c9c1b2", Uncommon: "#86d39a", Rare: "#79b0ff", Epic: "#cf98ff", Legendary: "#ffbd5c" };
const ORDER: ItemKind[] = [
  "idol",
  "diamond",
  "shard",
  "meteorite",
  "sapphire",
  "compass",
  "watch",
  "amethyst",
  "emerald",
  "ruby",
  "amber",
  "tooth",
  "trilobite",
  "fossil",
  "coin",
  "arrowhead",
  "quartz",
  "nugget"
];

export function paint(kind: ItemKind) {
  const size = 96;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const g = canvas.getContext("2d") as CanvasRenderingContext2D;
  g.translate(size / 2, size / 2);
  const radial = (r: number, inner: string, outer: string) => {
    const grad = g.createRadialGradient(-r * 0.3, -r * 0.35, r * 0.1, 0, 0, r);
    grad.addColorStop(0, inner);
    grad.addColorStop(1, outer);
    return grad;
  };
  const gem = (sides: number, rx: number, ry: number, light: string, mid: string, dark: string) => {
    // A cut stone seen from the side: an outline, a table across the top, facets fanning down to the point.
    const pts = Array.from({ length: sides }, (_, k) => [Math.cos((k / sides) * Math.PI * 2 - Math.PI / 2) * rx, Math.sin((k / sides) * Math.PI * 2 - Math.PI / 2) * ry]);
    g.beginPath();
    pts.forEach(([x, y], k) => (k ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.closePath();
    g.fillStyle = radial(rx, light, dark);
    g.fill();
    g.strokeStyle = "rgba(255,255,255,0.35)";
    g.lineWidth = 1.2;
    for (const [x, y] of pts) {
      g.beginPath();
      g.moveTo(0, -ry * 0.15);
      g.lineTo(x, y);
      g.stroke();
    }
    g.fillStyle = mid;
    g.globalAlpha = 0.5;
    g.beginPath();
    g.ellipse(0, -ry * 0.15, rx * 0.38, ry * 0.22, 0, 0, Math.PI * 2);
    g.fill();
    g.globalAlpha = 1;
    g.fillStyle = "rgba(255,255,255,0.9)";
    g.beginPath();
    g.arc(-rx * 0.35, -ry * 0.4, 3, 0, Math.PI * 2);
    g.fill();
  };
  switch (kind) {
    case "nugget": {
      g.beginPath();
      for (let k = 0; k <= 14; k++) {
        const a = (k / 14) * Math.PI * 2;
        const r = 30 + Math.sin(a * 3 + 1) * 5 + Math.sin(a * 5) * 3;
        const x = Math.cos(a) * r;
        const y = Math.sin(a) * r * 0.75;
        if (k) g.lineTo(x, y);
        else g.moveTo(x, y);
      }
      g.fillStyle = radial(32, "#fff1b0", "#a86f12");
      g.fill();
      g.fillStyle = "rgba(255,255,230,0.85)";
      for (const [x, y] of [
        [-10, -9],
        [8, -4],
        [-2, 7]
      ]) {
        g.beginPath();
        g.arc(x, y, 2.5, 0, Math.PI * 2);
        g.fill();
      }
      break;
    }
    case "diamond":
      gem(8, 28, 32, "#ffffff", "#e8f4ff", "#8fb0c8");
      break;
    case "emerald":
      gem(6, 24, 34, "#9cf5b8", "#38c06a", "#0b5a2a");
      break;
    case "ruby":
      gem(6, 30, 28, "#ff9aa2", "#e0283c", "#6a0612");
      break;
    case "sapphire":
      gem(6, 28, 31, "#a9c4ff", "#2f5fe0", "#0b1e6a");
      break;
    case "fossil": {
      g.fillStyle = radial(32, "#efe2c4", "#8a7655");
      g.beginPath();
      g.arc(0, 0, 31, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = "rgba(70,55,35,0.75)";
      g.lineWidth = 2;
      g.beginPath();
      for (let a = 0; a < Math.PI * 7; a += 0.1) {
        const r = 2 + a * 1.35;
        const x = Math.cos(a) * r;
        const y = Math.sin(a) * r;
        if (a) g.lineTo(x, y);
        else g.moveTo(x, y);
      }
      g.stroke();
      break;
    }
    case "coin": {
      g.fillStyle = radial(30, "#f5d590", "#7a4f18");
      g.beginPath();
      g.arc(0, 0, 30, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = "rgba(90,60,20,0.8)";
      g.lineWidth = 3;
      g.beginPath();
      g.arc(0, 0, 24, 0, Math.PI * 2);
      g.stroke();
      g.fillStyle = "rgba(90,60,20,0.7)";
      g.font = "bold 22px serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText("1", 0, 1);
      break;
    }
    case "compass":
    case "watch": {
      g.fillStyle = radial(32, "#f7dc95", "#7d5418");
      g.beginPath();
      g.arc(0, 4, 30, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = "#efe8d6";
      g.beginPath();
      g.arc(0, 4, 23, 0, Math.PI * 2);
      g.fill();
      if (kind === "compass") {
        g.fillStyle = "#b8231a";
        g.beginPath();
        g.moveTo(0, -15);
        g.lineTo(4, 4);
        g.lineTo(-4, 4);
        g.fill();
        g.fillStyle = "#333";
        g.beginPath();
        g.moveTo(0, 23);
        g.lineTo(4, 4);
        g.lineTo(-4, 4);
        g.fill();
      } else {
        g.strokeStyle = "#2a2a2a";
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(0, 4);
        g.lineTo(0, -12);
        g.moveTo(0, 4);
        g.lineTo(10, 8);
        g.stroke();
      }
      g.fillStyle = radial(8, "#f7dc95", "#7d5418");
      g.fillRect(-4, -34, 8, 9);
      break;
    }
    case "arrowhead": {
      g.fillStyle = radial(32, "#9a948c", "#3a3631");
      g.beginPath();
      g.moveTo(0, -34);
      g.quadraticCurveTo(20, -4, 12, 22);
      g.lineTo(5, 18);
      g.lineTo(0, 32);
      g.lineTo(-5, 18);
      g.lineTo(-12, 22);
      g.quadraticCurveTo(-20, -4, 0, -34);
      g.fill();
      g.strokeStyle = "rgba(255,255,255,0.18)";
      g.lineWidth = 1;
      for (let k = -24; k < 18; k += 7) {
        g.beginPath();
        g.moveTo(-10, k);
        g.lineTo(0, k + 5);
        g.lineTo(10, k);
        g.stroke();
      }
      break;
    }
  }
  return canvas.toDataURL();
}

function usePack() {
  return useSyncExternalStore(
    (listener) => {
      pack.listeners.add(listener);
      return () => pack.listeners.delete(listener);
    },
    () => pack.version,
    () => 0
  );
}

function useSupply() {
  return useSyncExternalStore(
    (listener) => {
      supply.listeners.add(listener);
      return () => supply.listeners.delete(listener);
    },
    () => supply.version,
    () => 0
  );
}

// A torch, for the count: a stick with a flame.
function TorchIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3c2 2.2 3 3.9 3 5.4A3 3 0 0 1 9 8.4C9 6.9 10 5.2 12 3z" />
      <path d="M9.5 11.5h5l-1.2 2H10.7z" />
      <path d="M12 13.5V21" />
    </svg>
  );
}

export function Backpack() {
  usePack();
  useSupply();
  usePhotos();
  useSyncExternalStore(
    (listener) => {
      ladders.listeners.add(listener);
      return () => ladders.listeners.delete(listener);
    },
    () => ladders.version,
    () => 0
  );
  const touch = useTouch();
  // Open from the start on a desktop (a fine pointer and room for it); closed on phones and small screens.
  const [panel, setPanel] = useState<{ open: boolean; tab: "pack" | "photos" }>({ open: false, tab: "pack" });
  const { open, tab } = panel;
  const setTab = (which: "pack" | "photos") => setPanel({ open: true, tab: which });
  useEffect(() => {
    if (window.matchMedia("(pointer: fine)").matches && window.innerWidth >= 900 && window.innerHeight >= 600) setPanel((p) => ({ ...p, open: true }));
  }, []);
  const icons = useMemo(() => (typeof document === "undefined" ? ({} as Record<ItemKind, string>) : (Object.fromEntries(ORDER.map((k) => [k, paint(k)])) as Record<ItemKind, string>)), []);
  // The pack's button and the roll's: open on that page, or close if it is already showing.
  const show = (which: "pack" | "photos") => setPanel((p) => (p.open && p.tab === which ? { ...p, open: false } : { open: true, tab: which }));
  useEffect(() => {
    // (While a modal view is open its own handler takes every key first; see inspect.tsx and photos.tsx.)
    const key = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
      const element = event.target as HTMLElement | null;
      if (element?.tagName === "INPUT" && (element as HTMLInputElement).type !== "range") return;
      if (event.code === "KeyI" || event.code === "Tab") {
        event.preventDefault();
        setPanel((p) => (p.open && p.tab === "pack" ? { ...p, open: false } : { open: true, tab: "pack" }));
      }
      if (event.code === "Escape") setPanel((p) => ({ ...p, open: false }));
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  // On a touch screen the open panel is a sheet over the scene: nothing behind it digs or walks until it is closed (a
  // tap outside it, its ✕, or the Pack button again).
  const sheet = touch && open;
  useEffect(() => {
    if (!sheet) return;
    panels.open();
    return () => panels.close();
  }, [sheet]);
  const found = ORDER.filter((k) => pack.counts[k]);
  const total = found.reduce((sum, k) => sum + (pack.counts[k] ?? 0), 0);
  const last = pack.last;
  const torchNews = supply.last;
  const out = supply.left <= 0;
  const roll = photos.list.length;
  // Panels take presses, releases and the wheel for themselves: none reaches the scene to dig or look.
  const block = { [PANEL]: "", onPointerDown: stop, onPointerUp: stop, onWheel: stop, onContextMenu: (event: SyntheticEvent) => event.preventDefault() };
  return (
    <>
      <style>{`
        .burrow-dock { position: fixed; right: 24px; bottom: 76px; z-index: 30; display: flex; align-items: center; gap: 8px; pointer-events: auto; }
        .burrow-pack-button { display: flex; align-items: center; gap: 8px; padding: 9px 14px 9px 11px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.14); background: rgba(22,19,16,0.55); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); color: #f3e7d6; font: inherit; font-size: 13px; cursor: pointer; }
        .burrow-pack-button:hover { background: rgba(40,34,28,0.65); }
        .burrow-pack-button[aria-expanded="true"] { border-color: rgba(255,200,120,0.4); }
        .burrow-shutter { width: 40px; height: 40px; padding: 0; justify-content: center; }
        .burrow-shutter:active { transform: scale(0.94); }
        .burrow-torch-count { position: fixed; right: 24px; bottom: 124px; z-index: 30; display: flex; align-items: center; gap: 7px; padding: 7px 13px 7px 10px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.14); background: rgba(22,19,16,0.55); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); color: #f3e7d6; font-size: 13px; pointer-events: none; }
        .burrow-torch-count b { font-weight: 600; color: #ffc27a; }
        .burrow-torch-count.out { border-color: rgba(255,120,90,0.55); color: #ffb3a0; }
        .burrow-torch-count.out b { color: #ff8a6e; }
        .burrow-pack-torches { display: flex; align-items: center; gap: 8px; margin: 0 0 12px; padding: 9px 12px; border-radius: 12px; background: rgba(255,190,110,0.08); border: 1px solid rgba(255,190,110,0.16); font-size: 13px; }
        .burrow-pack-torches.out { background: rgba(255,110,80,0.1); border-color: rgba(255,110,80,0.3); }
        .burrow-pack-torches small { margin-left: auto; opacity: 0.65; font-size: 11px; }
        .burrow-pack-button[data-burrow-pack] { position: relative; }
        .burrow-bump { animation: burrow-bump 0.5s cubic-bezier(0.3, 1.6, 0.5, 1); }
        @keyframes burrow-bump { 0% { transform: scale(1); } 30% { transform: scale(1.6) rotate(-8deg); } 100% { transform: scale(1); } }
        .burrow-pack-plus { position: absolute; right: 4px; top: -6px; font-style: normal; font-size: 18px; font-weight: 900; color: var(--rarity); text-shadow: 0 0 10px var(--rarity), 0 2px 4px rgba(0,0,0,0.6); pointer-events: none; animation: burrow-plus 1.1s ease-out forwards; }
        @keyframes burrow-plus { 0% { opacity: 0; transform: translateY(6px) scale(0.6); } 15% { opacity: 1; transform: translateY(-6px) scale(1.25); } 100% { opacity: 0; transform: translateY(-34px) scale(1); } }
        @media (prefers-reduced-motion: reduce) { .burrow-bump { animation: none; } .burrow-pack-plus { animation-name: burrow-plus-calm; } }
        @keyframes burrow-plus-calm { 0%, 60% { opacity: 1; } 100% { opacity: 0; } }
        .burrow-pack-button b { font-weight: 600; min-width: 1.2em; text-align: center; padding: 1px 7px; border-radius: 999px; background: rgba(255,200,120,0.18); }
        .burrow-pack { position: fixed; right: 24px; bottom: 216px; z-index: 30; width: min(380px, calc(100vw - 48px)); max-height: min(calc(100vh - 310px), 560px); overflow: auto; padding: 14px 16px 16px; border-radius: 18px; border: 1px solid rgba(255,255,255,0.13); background: rgba(20,17,14,0.62); backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px); color: #f3e7d6; box-shadow: 0 20px 60px rgba(0,0,0,0.45); animation: burrow-pack-in 0.22s ease; pointer-events: auto; overscroll-behavior: contain; }
        @keyframes burrow-pack-in { from { opacity: 0; transform: translateY(8px); } }
        .burrow-tabs { display: flex; gap: 4px; margin: 0 0 8px; }
        .burrow-tabs button { padding: 5px 12px; border-radius: 999px; border: 1px solid transparent; background: none; color: inherit; font: inherit; font-size: 14px; font-weight: 600; opacity: 0.55; cursor: pointer; }
        .burrow-tabs button[aria-selected="true"] { opacity: 1; background: rgba(255,255,255,0.07); border-color: rgba(255,255,255,0.1); }
        .burrow-tabs button:hover { opacity: 0.9; }
        .burrow-pack p { margin: 0 0 12px; font-size: 12px; opacity: 0.65; }
        .burrow-pack-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); gap: 8px; }
        .burrow-pack-item { position: relative; display: flex; flex-direction: column; align-items: center; padding: 10px 6px 8px; border-radius: 12px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.07); color: inherit; font: inherit; cursor: zoom-in; transition: background 0.15s ease, border-color 0.15s ease, transform 0.15s ease; }
        .burrow-pack-item:hover { background: rgba(255,255,255,0.1); border-color: color-mix(in srgb, var(--rarity) 55%, transparent); transform: translateY(-1px); }
        .burrow-pack-item img { width: 52px; height: 52px; filter: drop-shadow(0 3px 6px rgba(0,0,0,0.5)); transition: transform 0.2s ease; }
        .burrow-pack-item:hover img { transform: scale(1.08); }
        .burrow-pack-item span { margin-top: 6px; font-size: 12px; text-align: center; line-height: 1.2; }
        .burrow-pack-item em { font-style: normal; font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; margin-top: 3px; }
        .burrow-pack-item b { position: absolute; top: 6px; right: 8px; font-size: 12px; font-weight: 600; }
        .burrow-pack-empty { font-size: 13px; opacity: 0.7; padding: 18px 4px; text-align: center; }
        .burrow-toast { position: fixed; left: 50%; bottom: 18%; z-index: 30; transform: translateX(-50%); display: flex; align-items: center; gap: 10px; padding: 8px 16px 8px 10px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.14); background: rgba(22,19,16,0.6); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); color: #f6ead8; font-size: 14px; pointer-events: none; animation: burrow-toast 2.4s ease forwards; }
        @keyframes burrow-toast { 0% { opacity: 0; transform: translate(-50%, 14px) scale(0.96); } 10% { opacity: 1; transform: translate(-50%, 0) scale(1); } 75% { opacity: 1; } 100% { opacity: 0; transform: translate(-50%, -16px); } }
        .burrow-hover-tag { position: fixed; left: 0; top: 0; z-index: 31; pointer-events: none; display: flex; align-items: baseline; gap: 7px; padding: 5px 11px; border-radius: 999px; border: 1px solid color-mix(in srgb, var(--rarity) 45%, transparent); background: rgba(18,14,10,0.6); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); color: #f6ead8; font-size: 13px; white-space: nowrap; transform: translate(18px, -34px); animation: burrow-tag-in 0.16s ease; }
        .burrow-hover-tag em { font-style: normal; font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--rarity); }
        @keyframes burrow-tag-in { from { opacity: 0; } }
        .burrow-modal { position: fixed; inset: 0; z-index: 40; display: flex; align-items: center; justify-content: center; padding: 16px; background: radial-gradient(ellipse at center, rgba(14,11,8,0.55), rgba(4,3,2,0.82)); backdrop-filter: blur(5px); -webkit-backdrop-filter: blur(5px); pointer-events: auto; animation: burrow-pack-in 0.2s ease; touch-action: none; }
        .burrow-modal-card { position: relative; border-radius: 20px; border: 1px solid rgba(255,255,255,0.13); background: rgba(20,17,14,0.72); backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px); color: #f3e7d6; box-shadow: 0 30px 90px rgba(0,0,0,0.6); }
        .burrow-modal-close { position: absolute; top: 10px; right: 10px; z-index: 2; width: 32px; height: 32px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.14); background: rgba(22,19,16,0.6); color: #f3e7d6; font-size: 14px; cursor: pointer; }
        .burrow-modal-close:hover { background: rgba(50,42,34,0.8); }
        .burrow-inspect-card { width: min(560px, 100%); padding: 0 0 18px; overflow: hidden; }
        .burrow-inspect-stage { position: relative; width: 100%; aspect-ratio: 1; max-height: 62vh; margin: 0 auto; background: radial-gradient(circle at 50% 45%, color-mix(in srgb, var(--rarity) 14%, rgba(60,48,36,0.5)), rgba(10,8,6,0) 70%); }
        .burrow-inspect-canvas { position: absolute; inset: 0; width: 100%; height: 100%; cursor: grab; touch-action: none; transition: opacity 0.25s ease; }
        .burrow-inspect-canvas:active { cursor: grabbing; }
        .burrow-inspect-still { position: absolute; left: 50%; top: 50%; width: 46%; transform: translate(-50%, -50%); opacity: 0.8; }
        .burrow-inspect-text { padding: 0 22px; text-align: center; }
        .burrow-inspect-text em { font-style: normal; font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; }
        .burrow-inspect-text h3 { margin: 4px 0 6px; font-size: 22px; font-weight: 500; }
        .burrow-inspect-text p { margin: 0 auto 10px; max-width: 44ch; font-size: 14px; line-height: 1.45; opacity: 0.82; }
        .burrow-inspect-text small { font-size: 11px; opacity: 0.5; }
        @media (max-width: 720px) {
          .burrow-dock { bottom: 96px; right: 16px; }
          .burrow-torch-count { bottom: 144px; right: 16px; }
          .burrow-pack { right: 16px; bottom: 236px; max-height: calc(100vh - 330px); }
          .burrow-pack-button span { display: none; }
        }
        /* A touch screen: four round buttons in the bottom right corner (torch, ladder, camera, pack) in place of the
           pills, and the pack as a sheet with its own close, scrolling inside, over a dimmed scene that closes it. */
        .burrow-touch, .burrow-pack-x, .burrow-scrim { display: none; }
        @media ${TOUCH_QUERY} {
          .burrow-dock, .burrow-torch-count { display: none; }
          .burrow-touch { position: fixed; right: max(16px, env(safe-area-inset-right)); bottom: var(--burrow-low); z-index: 30; display: grid; grid-template-columns: repeat(2, 60px); gap: 10px; pointer-events: auto; transition: bottom 0.3s ease; }
          .burrow-touch button { position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; width: 60px; height: 60px; padding: 0; border-radius: 50%; border: 1px solid rgba(255,255,255,0.18); background: rgba(22,19,16,0.58); -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px); color: #f3e7d6; font: inherit; touch-action: manipulation; user-select: none; -webkit-user-select: none; -webkit-tap-highlight-color: transparent; }
          .burrow-touch button:active { transform: scale(0.93); background: rgba(60,50,40,0.75); }
          .burrow-touch button span { font-size: 10px; letter-spacing: 0.04em; opacity: 0.85; }
          .burrow-touch button b { position: absolute; top: -4px; right: -4px; min-width: 22px; height: 22px; padding: 0 6px; box-sizing: border-box; border-radius: 999px; background: #3a2d20; border: 1px solid rgba(255,200,120,0.45); color: #ffd9a6; font-size: 11px; font-weight: 700; line-height: 20px; text-align: center; }
          .burrow-touch button.on { border-color: rgba(120,230,150,0.7); background: rgba(30,48,34,0.72); }
          .burrow-touch button.out { color: #ffb3a0; border-color: rgba(255,120,90,0.5); }
          .burrow-touch button.out b { color: #ff8a6e; border-color: rgba(255,120,90,0.5); }
          .burrow-touch button[aria-expanded="true"] { border-color: rgba(255,200,120,0.6); }
          .burrow-touch .burrow-pack-plus { right: -2px; top: -16px; }
          .burrow-scrim { display: block; position: fixed; inset: 0; z-index: 33; pointer-events: auto; background: rgba(6,5,4,0.45); animation: burrow-pack-in 0.2s ease; touch-action: none; }
          .burrow-pack { z-index: 34; left: max(12px, env(safe-area-inset-left)); right: max(12px, env(safe-area-inset-right)); bottom: calc(max(10px, env(safe-area-inset-bottom)) + 58px); width: auto; max-width: 460px; margin-left: auto; max-height: calc(100dvh - max(16px, env(safe-area-inset-top)) - 60px - max(10px, env(safe-area-inset-bottom)) - 58px); padding: 12px 14px 14px; -webkit-overflow-scrolling: touch; touch-action: pan-y; }
          .burrow-pack-x { display: grid; place-items: center; position: sticky; top: 0; float: right; width: 44px; height: 44px; margin: -6px -6px 0 0; border-radius: 50%; border: 1px solid rgba(255,255,255,0.16); background: rgba(22,19,16,0.8); color: #f3e7d6; font: inherit; font-size: 16px; z-index: 1; }
          .burrow-tabs button { min-height: 44px; padding: 0 16px; }
          .burrow-pack-grid { grid-template-columns: repeat(auto-fill, minmax(92px, 1fr)); }
          .burrow-toast { bottom: calc(var(--burrow-low) + 150px); max-width: calc(100vw - 32px); white-space: normal; }
          .burrow-modal { padding: max(12px, env(safe-area-inset-top)) max(12px, env(safe-area-inset-right)) max(12px, env(safe-area-inset-bottom)) max(12px, env(safe-area-inset-left)); }
          .burrow-modal-card { max-height: 100%; overflow-y: auto; overscroll-behavior: contain; touch-action: pan-y; }
          .burrow-modal-close { width: 44px; height: 44px; font-size: 16px; }
          .burrow-inspect-stage { width: min(100%, 52dvh); max-height: none; }
        }
        @media ${TOUCH_QUERY} and (orientation: landscape) and (max-height: 520px) {
          .burrow-toast { bottom: calc(max(10px, env(safe-area-inset-bottom)) + 66px); max-width: calc(100vw - 340px); }
          .burrow-pack { top: calc(max(12px, env(safe-area-inset-top)) + 52px); bottom: max(10px, env(safe-area-inset-bottom)); max-height: none; }
        }
      `}</style>
      <div className={`burrow-torch-count ${out ? "out" : ""}`} aria-live="polite">
        <TorchIcon />
        {out ? (
          "No torches left"
        ) : (
          <>
            Torches <b>{supply.left}</b>
          </>
        )}
      </div>
      <div className="burrow-dock" {...block}>
        <button type="button" className="burrow-pack-button burrow-shutter" onClick={() => viewfinder.toggle()} aria-label="Raise the camera (P)" title="Raise the camera (P)">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" />
            <circle cx="12" cy="13" r="3.6" />
          </svg>
        </button>
        <button type="button" className="burrow-pack-button" onClick={() => show("photos")} aria-expanded={open && tab === "photos"}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="5" width="18" height="14" rx="2.5" />
            <path d="M3 15l5-4 4 3 3-2 6 4" />
            <circle cx="16" cy="9.5" r="1.4" />
          </svg>
          <span>Photos</span> <b>{roll}</b>
        </button>
        {/* Where each find's card (found.tsx) flies to: it bumps and counts the find as the card lands. */}
        <button type="button" className="burrow-pack-button" data-burrow-pack="" onClick={() => show("pack")} aria-expanded={open && tab === "pack"}>
          <svg key={`bag${last?.at ?? 0}`} className={last ? "burrow-bump" : undefined} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M8 6V5a4 4 0 0 1 8 0v1" />
            <rect x="4" y="6" width="16" height="15" rx="4" />
            <path d="M4 12h16M10 12v2h4v-2" />
          </svg>
          <span>Backpack</span> <b key={`n${last?.at ?? 0}`} className={last ? "burrow-bump" : undefined}>{total}</b>
          {last ? (
            <i key={`p${last.at}`} className="burrow-pack-plus" style={{ ["--rarity" as string]: RARITY[ITEMS[last.kind].rarity] }}>
              +{last.n}
            </i>
          ) : null}
        </button>
      </div>
      <div className="burrow-touch" {...block}>
        <button type="button" className={out ? "out" : undefined} onClick={() => touchActions.torch()} aria-label={out ? "No torches left" : "Mount a torch where you look"}>
          <TorchIcon size={22} />
          <span>Torch</span>
          <b>{supply.left}</b>
        </button>
        <button type="button" className={ladders.placing ? "on" : ladders.left <= 0 ? "out" : undefined} onClick={() => ladders.toggle()} aria-pressed={ladders.placing} aria-label={ladders.placing ? "Put the ladder away" : "Carry a ladder"}>
          <LadderIcon size={22} />
          <span>{ladders.placing ? "Cancel" : "Ladder"}</span>
          <b>{ladders.left}</b>
        </button>
        <button type="button" onClick={() => viewfinder.toggle()} aria-label="Raise the camera">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" />
            <circle cx="12" cy="13" r="3.6" />
          </svg>
          <span>Camera</span>
        </button>
        <button type="button" data-burrow-pack="" onClick={() => show("pack")} aria-expanded={open} aria-label="Backpack and photos">
          <svg key={`tbag${last?.at ?? 0}`} className={last ? "burrow-bump" : undefined} width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M8 6V5a4 4 0 0 1 8 0v1" />
            <rect x="4" y="6" width="16" height="15" rx="4" />
            <path d="M4 12h16M10 12v2h4v-2" />
          </svg>
          <span>Pack</span>
          {total ? <b key={`tn${last?.at ?? 0}`} className={last ? "burrow-bump" : undefined}>{total}</b> : null}
          {last ? (
            <i key={`tp${last.at}`} className="burrow-pack-plus" style={{ ["--rarity" as string]: RARITY[ITEMS[last.kind].rarity] }}>
              +{last.n}
            </i>
          ) : null}
        </button>
      </div>
      {sheet ? <div className="burrow-scrim" {...block} onClick={() => setPanel((p) => ({ ...p, open: false }))} /> : null}
      {open ? (
        <div className="burrow-pack" role="dialog" aria-label={tab === "pack" ? "Backpack" : "Photos"} {...block}>
          <button type="button" className="burrow-pack-x" onClick={() => setPanel((p) => ({ ...p, open: false }))} aria-label="Close">
            ✕
          </button>
          <div className="burrow-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === "pack"} onClick={() => setTab("pack")}>
              Backpack
            </button>
            <button type="button" role="tab" aria-selected={tab === "photos"} onClick={() => setTab("photos")}>
              Photos{roll ? ` (${roll})` : ""}
            </button>
          </div>
          {tab === "pack" ? (
            <>
              <p>{touch ? "What you have dug out of the rock. Tap one to look at it closely." : "What you have dug out of the rock. Click one to look at it closely. I or Tab to close."}</p>
              <div className={`burrow-pack-torches ${out ? "out" : ""}`}>
                <TorchIcon />
                {out ? "No torches left" : `${supply.left} torch${supply.left === 1 ? "" : "es"}`}
                <small>{out ? "Find a lost explorer's camp for more" : touch ? "Torch button, or hold on a wall" : "T or right click to mount"}</small>
              </div>
              {found.length ? (
                <div className="burrow-pack-grid">
                  {found.map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      className="burrow-pack-item"
                      onClick={() => inspect.open(kind)}
                      aria-label={`Look at ${ITEMS[kind].name}`}
                      style={{ boxShadow: `inset 0 0 0 1px ${RARITY[ITEMS[kind].rarity]}33`, ["--rarity" as string]: RARITY[ITEMS[kind].rarity] }}
                    >
                      <b>×{pack.counts[kind]}</b>
                      {/* eslint-disable-next-line @next/next/no-img-element -- painted at runtime, not a static asset. */}
                      <img src={pack.icons[kind] ?? icons[kind]} alt="" />
                      <span>{(pack.counts[kind] ?? 0) > 1 ? ITEMS[kind].plural : ITEMS[kind].name}</span>
                      <em style={{ color: RARITY[ITEMS[kind].rarity] }}>{ITEMS[kind].rarity}</em>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="burrow-pack-empty">Nothing yet. Dig, and watch for a glint in the rock.</div>
              )}
            </>
          ) : (
            <PhotoRoll />
          )}
        </div>
      ) : null}
      {torchNews ? (
        <div key={`t${torchNews.at}`} className="burrow-toast">
          <TorchIcon />
          <span>{torchNews.kind === "empty" ? "Out of torches. A lost explorer's camp will have spares." : `+${torchNews.count} torches from the camp`}</span>
        </div>
      ) : null}
      <HoverTag />
      <Inspect colours={RARITY} />
      <PhotoViewer />
      <Viewfinder />
    </>
  );
}

const stop = (event: SyntheticEvent) => event.stopPropagation();

// The name of the find under the mouse, beside the pointer.
function HoverTag() {
  const kind = useSyncExternalStore(
    (listener) => {
      hovered.listeners.add(listener);
      return () => hovered.listeners.delete(listener);
    },
    () => hovered.kind,
    () => null
  );
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (ref.current) ref.current.style.translate = `${event.clientX}px ${event.clientY}px`;
    };
    window.addEventListener("pointermove", move);
    return () => window.removeEventListener("pointermove", move);
  }, []);
  if (!kind) return null;
  const item = ITEMS[kind];
  return (
    <div ref={ref} className="burrow-hover-tag" style={{ translate: `${hovered.x}px ${hovered.y}px`, ["--rarity" as string]: RARITY[item.rarity] }}>
      {item.name}
      <em>{item.rarity}</em>
    </div>
  );
}

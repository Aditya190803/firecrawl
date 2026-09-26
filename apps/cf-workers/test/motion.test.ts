import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const source = html.slice(html.indexOf("function animateBackdrop(){"), html.indexOf("function quickSnippet()"));
function mount(stored: string | null = null) {
  const frames = new Map<number, (time: number) => void>();
  let id = 0, marks: number[][] = [], storage = stored;
  const button: any = { setAttribute() {}, onclick: null };
  const ctx = { clearRect() { marks = []; }, setTransform() {}, fillRect(...args: number[]) { marks.push(args); } };
  const canvas = { dataset: {}, getContext: () => ctx };
  const scene = { clientWidth: 1200 };
  const observer = class { observe() {} disconnect() {} };
  const sandbox: any = {
    $: (selector: string) => selector === "#heroAtmosphere" ? canvas : selector === "#heroScene" ? scene : button,
    document: { hidden: false, documentElement: { dataset: { theme: "light" } }, addEventListener() {}, removeEventListener() {} },
    localStorage: { getItem: () => storage, setItem: (_: string, value: string) => { storage = value; } },
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    devicePixelRatio: 1, IntersectionObserver: observer, ResizeObserver: observer,
    requestAnimationFrame: (cb: (time: number) => void) => { frames.set(++id, cb); return id; },
    cancelAnimationFrame: (key: number) => frames.delete(key),
  };
  runInNewContext("let disposeBackdrop;" + source + ";animateBackdrop();globalThis.cleanup=()=>disposeBackdrop();", sandbox);
  return { button, frames, marks: () => JSON.stringify(marks), stored: () => storage, cleanup: sandbox.cleanup,
    step(time: number) { const pending = [...frames.values()]; frames.clear(); pending.forEach(cb => cb(time)); } };
}

describe("homepage motion", () => {
  it("actually changes drawing on play, freezes on pause, and resumes", () => {
    const ui = mount();
    expect(ui.frames.size).toBe(0); // respects reduced motion until explicitly enabled
    ui.button.onclick(); ui.step(100); const before = ui.marks(); ui.step(150);
    expect(ui.marks()).not.toBe(before);
    ui.button.onclick(); const paused = ui.marks(); ui.step(200);
    expect(ui.frames.size).toBe(0); expect(ui.marks()).toBe(paused);
    ui.button.onclick(); ui.step(250); ui.step(300);
    expect(ui.marks()).not.toBe(paused);
    ui.cleanup(); expect(ui.frames.size).toBe(0);
  });
  it("keeps explicit play preference on remount despite reduced-motion default", () => {
    const first = mount(); first.button.onclick(); first.cleanup();
    const next = mount(first.stored());
    expect(next.frames.size).toBe(1);
    next.cleanup();
  });
});

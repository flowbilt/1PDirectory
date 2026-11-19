// A finger drag for the browser checks (DP-15, V5c): raw touch events through Chrome's DevTools protocol (Playwright's own
// gestures don't scroll a page in headless Chromium)
export async function swipe(cdp, x, y, dy, steps = 12) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let i = 1; i <= steps; i++) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + (dy * i) / steps }] }); await new Promise((r) => setTimeout(r, 16)); }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

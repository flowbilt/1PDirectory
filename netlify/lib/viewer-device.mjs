// DP-15 (V5): what kind of device and browser a viewer visit or page load came from, as a category only (Scot,
// 2026-11-16: "OK"). Worked out from the browser's own description (the User-Agent header), which is never kept.
// Also tells crawlers and link-preview robots apart, so they aren't counted as visitors.

/** "phone", "tablet" or "desktop" (an iPad asking for desktop pages describes itself as a Mac: desktop) */
export function deviceOf(ua) {
  const s = String(ua || "");
  if (/iPad|Tablet|PlayBook|Silk|Kindle/i.test(s) || (/Android/i.test(s) && !/Mobile/i.test(s))) return "tablet";
  if (/Mobi|iPhone|iPod|Android|Windows Phone/i.test(s)) return "phone";
  return "desktop";
}

/** "instagram" or "facebook" for their in-app browsers, otherwise "other" */
export function browserOf(ua) {
  const s = String(ua || "");
  if (/Instagram/i.test(s)) return "instagram";
  if (/FBAN|FBAV|FB_IAB|FBIOS|FB4A|\[FB/i.test(s)) return "facebook";
  return "other";
}

/** Crawlers and link-preview robots (Facebook's, Google's, Bing's and the like): not visitors */
export const isRobot = (ua) => /bot\b|bot\/|crawl|spider|slurp|facebookexternalhit|facebookcatalog|embedly|preview|lighthouse|pagespeed/i.test(String(ua || ""));

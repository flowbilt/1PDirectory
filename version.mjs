// The display code that's live (public/display.js's VERSION; a test keeps the two equal). /api/screen sends it with
// every directory and folds it into the screen's version tag, so after a deploy every screen gets a fresh answer,
// sees it's running older code, and reloads itself (display 2.8.0 and later) instead of waiting for 3 a.m.
export const DISPLAY_VERSION = "2.8.0";

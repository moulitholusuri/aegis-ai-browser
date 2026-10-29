'use strict';
// Night Lens — dark mode via constructable stylesheets.
// adoptedStyleSheets are exempt from page CSP, so this works even on sites
// with strict style-src policies (a plain <style> append would be blocked).
(() => {
  const CSS = `html{filter:invert(.92) hue-rotate(180deg)!important;background:#101010!important}
img,video,picture,canvas,iframe,embed,object,[style*="background-image"]{filter:invert(1) hue-rotate(180deg)!important}`;

  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  } catch {
    const s = document.createElement('style');
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }
})();

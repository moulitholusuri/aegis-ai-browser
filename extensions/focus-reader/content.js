'use strict';
// Focus Reader — cosmetic declutter. Hides common distraction blocks and
// improves article typography. Pure display rules; no network, no tracking.
(() => {
  const CSS = `
.sidebar, #sidebar, #secondary, aside,
#comments, .comments, .comment-section, .comment-list, .comments-section,
.newsletter, .newsletter-popup, .newsletter-modal, .subscribe-overlay, .subscribe-box,
.related-posts, .related-articles, .recommended-posts, .more-stories,
.taboola, .taboola, .outbrain, .OUTBRAIN,
#cookie-consent-placeholder { display: none !important; }
article p, article li, .post-content p, .entry-content p { line-height: 1.75 !important; }
`;
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

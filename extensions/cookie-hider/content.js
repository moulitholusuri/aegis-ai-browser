'use strict';
// Cookie Banner Hider — hides the well-known consent/CMP overlays.
// It NEVER clicks "accept" for the user; it only hides the dialog element.
// Aegis additionally blocks the trackers themselves, so hiding the prompt
// does not mean agreeing to being tracked.
(() => {
  const CSS = `
#onetrust-consent-sdk, #onetrust-banner-sdk, #onetrust-policy,
#CybotCookiebotDialog, #CybotCookiebotDialogBodyUnderlay,
#ccc, #ccc-notify, #ccc-overlay, #ccc-banner,
#usercentrics-root, #qc-cmp2-container, .qc-cmp2-container,
#didomi-host, #didomi-popup, .didomi-popup, .didomi-notice,
#axeptio_overlay, #axeptio_notifications_container,
#ez-cookie-dialog-wrapper, #cookie-law-info-bar, #cookieChoiceInfo,
#cookiescript_injected, #cookiescript_injected_wrapper,
#cookie-banner, #cookie-notice, #cookiebar, #cookie-consent,
#cookie-consent-banner, #cookieConsent, #gdpr-banner,
.cookie-consent, .cookie-banner, .cookie-notice, .cookiebar, .cookie-message,
.cc-window, .cc-banner, .cc-container, .js-cookie-consent,
.gdpr-banner, .gdpr-consent, .eu-cookie-compliance-banner,
[id^="sp_message_container_"], [id^="sp_veil"],
[id*="cookiebot"], [id*="cookie-consent-banner"],
.qiota_consent, #usercentrics-cmp-ui
{ display: none !important; }
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

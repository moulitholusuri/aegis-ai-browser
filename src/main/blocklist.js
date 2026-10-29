'use strict';
// Network guard: ad + tracker blocking at the request layer, plus cosmetic
// filtering (hides ad containers that slip through as first-party content).

const { session } = require('electron');

// Curated list of ad / tracker / malvertising domains. Requests to these are
// cancelled before a byte leaves the machine.
const BLOCKED_DOMAINS = new Set([
  // Advertising networks
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'adservice.google.com',
  'pagead2.googlesyndication.com', 'ad.doubleclick.net', 'advertising.com', 'adnxs.com',
  'casalemedia.com', 'criteo.com', 'criteo.net', 'rubiconproject.com', 'pubmatic.com',
  'openx.net', 'smartadserver.com', 'teads.tv', 'taboola.com', 'outbrain.com', 'revcontent.com',
  'mgid.com', 'zergnet.com', 'sharethrough.com', 'indexww.com', 'moatads.com', 'adform.net',
  'adcolony.com', 'unityads.unity3d.com', 'applovin.com', 'admob.com', 'amazon-adsystem.com',
  'media.net', 'yllix.com', 'propellerads.com', 'popads.net', 'adsterra.com', 'exoclick.com',
  'juicyads.com', 'trafficjunky.com', 'exosrv.com', 'syndication.twitter.com', 'ads.yahoo.com',
  'advertising.yahoo.com', 'bing.com/aclick', 'ads.linkedin.com', 'snap.licdn.com',
  'amazon-adsystem.com', 'assoc-amazon.com', 'serving-sys.com', 'sizmek.com', 'adtechus.com',
  'turn.com', 'bidswitch.net', 'contextweb.com', 'semasio.net', 'bluekai.com', 'exelator.com',
  'krxd.net', 'rlcdn.com', 'agkn.com', 'addthis.com', 'addtoany.com', 'adroll.com', 'yieldmo.com',
  'spotxchange.com', 'springserve.com', 'videologygroup.com', 'w55c.net', '33across.com',
  'sharethis.com', 'static.hotjar.com', 'hotjar.com',
  // Analytics / tracking
  'google-analytics.com', 'analytics.google.com', 'googletagmanager.com', 'scorecardresearch.com',
  'quantserve.com', 'quantcast.com', 'mixpanel.com', 'segment.io', 'segment.com', 'amplitude.com',
  'fullstory.com', 'mouseflow.com', 'crazyegg.com', 'optimizely.com', 'heap.io', 'kissmetrics.com',
  'matomo.cloud', 'piwik.pro', 'clarity.ms', 'bugsnag.com', 'sentry.io', 'newrelic.com',
  'nr-data.net', 'branch.io', 'appsflyer.com', 'adjust.com', 'kochava.com', 'singular.net',
  'facebook.net', 'connect.facebook.net', 'analytics.tiktok.com', 'ads.tiktok.com',
  'pinterest.com/ct', 'pinimg.com/ct', 'bat.bing.com', 'yandex.ru/metrika', 'mc.yandex.ru',
  'stats.wp.com', 'pixel.facebook.com', 'tr.snapchat.com', 'sc-static.net', 'tiktokv.com',
  'log.byteoversea.com', 'sentry-cdn.com', 'insurads.com', 'omtrdc.net', 'demdex.net',
  'everesttech.net', 'adobedtm.com', 'launchdarkly.com', 'clevage.net', 'heapanalytics.com',
  'plausible.io', 'statcounter.com', 'doubleverify.com', 'izatcloud.io', 'simpli.fi',
  // Fingerprinting / session replay
  'fingerprintjs.com', 'fpcdn.io', 'deviceid.io', 'canvas-fingerprinting.com', 'tracker.metricool.com',
  'recaptcha.net', 'hCaptcha.com',
]);

// URL-pattern based blocking (catches ad paths on otherwise-legit hosts).
const BLOCKED_PATTERNS = [
  /\/(?:ads?|adserver|advert|adsense|pagead|popunder|pop-up|bannerads?)\//i,
  /(?:^|\.)(?:ads|adserver|adtrack|adtag)\./i,
  /[?&](?:ad_id|adid|adunit|ad_slot|adslot|clicktag|utm_adgroup)=/i,
  /\/(?:gtm|ga)\.js$/i,
  /\/(?:analytics|track|beacon|pixel)\.(?:php|js|html)$/i,
  /(?:^|\/)(?:doubleclick|googlesyndication|googleadservices)\./i,
];

const TRACKER_HOST_HINTS = ['track', 'analytics', 'pixel', 'beacon', 'metric', 'telemetry', 'adsrv', 'adserver'];

function shouldBlock(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (BLOCKED_DOMAINS.has(host)) return true;
  for (const domain of BLOCKED_DOMAINS) {
    if (host.endsWith('.' + domain)) return true;
  }
  for (const re of BLOCKED_PATTERNS) if (re.test(url)) return true;
  return false;
}

// Cosmetic filter: injected after load to hide ad containers that are served
// from the same origin as the page (network blocking can't see those).
const COSMETIC_CSS = `
  [id^="google_ads"], [id*="div-gpt-ad"], [id*="ad-slot"], [id*="ad-slot-"],
  [class*="adsbygoogle"], ins.adsbygoogle, .adsbygoogle,
  [data-ad-slot], [data-ad-unit], [data-ad-client],
  .sponsored-post, .sponsored-content, [class*="sponsored-"],
  iframe[src*="doubleclick"], iframe[src*="googlesyndication"], iframe[src*="adnxs"],
  iframe[src*="taboola"], iframe[src*="outbrain"],
  [class*="ad-banner"], [class*="ad-container"], [class*="ad-wrapper"],
  .taboola-below-article, .OUTBRAIN, [id^="taboola"],
  aside[aria-label*="ad" i], [aria-label*="advertisement" i],
  [class*="promo-"], [class*="affiliate-"],
  #cookie-consent, .cookie-banner, .cookie-consent, [id*="onetrust"], .qc-cmp2-container
  { display: none !important; visibility: hidden !important; height: 0 !important; max-height: 0 !important; }
`;

// Minimal anti-fingerprint / anti-leak injection.
const PRIVACY_JS = `(() => {
  try {
    // Stop WebGL renderer-string fingerprinting
    const gp = WebGLRenderingContext && WebGLRenderingContext.prototype.getParameter;
    if (gp) {
      const orig = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function (p) {
        if (p === 37445 || p === 37446) return 'Aegis Private GPU';
        return orig.call(this, p);
      };
    }
  } catch {}
  try {
    // Hide webdriver flag so sites don't treat us as a bot
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  } catch {}
  try {
    // Minimal client hints / platform leakage reduction
    const origPlugins = navigator.plugins;
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  } catch {}
  try {
    // Neutralize Battery API & Bluetooth (device tracking vectors)
    if (navigator.getBattery) navigator.getBattery = undefined;
    if (navigator.bluetooth) navigator.bluetooth = undefined;
  } catch {}
})();`;

class NetworkGuard {
  constructor(getSettings, onBlocked) {
    this.getSettings = getSettings;
    this.onBlocked = onBlocked || (() => {});
    this.sessions = new Map(); // partition -> { ses, counters }
  }

  attach(partition) {
    if (this.sessions.has(partition)) return this.sessions.get(partition);
    const ses = session.fromPartition(partition);
    const counters = { ads: 0, trackers: 0, total: 0 };

    // --- Request-level blocking + header hygiene in one pass ---
    ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      const s = this.getSettings();
      if (s.blockAds !== false && shouldBlock(details.url)) {
        counters.total++;
        if (/ad|banner|pop|syndicat|pagead|click/i.test(details.url)) counters.ads++;
        else counters.trackers++;
        this.onBlocked(details.url, details.resourceType);
        return callback({ cancel: true });
      }
      callback({});
    });

    // --- Leak proofing: strip cross-origin referrers, force DNT & GPC,
    //     pin language, isolate third-party cookies (Total-Cookie-Protection style) ---
    ses.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, callback) => {
      const headers = details.requestHeaders;
      const s = this.getSettings();
      try {
        const pageHost = details.referrer ? new URL(details.referrer).hostname.replace(/^www\./, '') : null;
        const targetHost = new URL(details.url).hostname.replace(/^www\./, '');
        const thirdParty = !!(pageHost && pageHost !== targetHost);

        if (thirdParty) {
          if (s.strictReferrer !== false) headers['Referer'] = '';
          else headers['Referer'] = `${new URL(details.url).origin}/`;
          // Third-party cookie isolation: cross-site embeds/trackers never
          // receive the user's cookies. Main-frame navigations keep theirs,
          // so first-party sign-ins (Google, Microsoft…) still work.
          if (s.strictCookies !== false && details.resourceType !== 'mainFrame') {
            delete headers['Cookie'];
          }
        }
        headers['DNT'] = '1';
        headers['Sec-GPC'] = '1';
        // Pin Accept-Language so language stops being a tracking signal.
        if (s.forceEnglish !== false) headers['Accept-Language'] = 'en-US,en;q=0.9';
        delete headers['X-Client-Data'];           // Google experiment fingerprint
        delete headers['X-Chrome-UMA-Enabled'];
        delete headers['X-Chrome-Connected'];
      } catch { /* pass through */ }
      callback({ requestHeaders: headers });
    });

    // --- Permission lockdown: deny mic/camera/geolocation/notifications/clipboard by default ---
    ses.setPermissionRequestHandler((wc, permission, callback, details) => {
      const allow = ['fullscreen', 'pointerLock', 'clipboard-sanitized-write'];
      const ok = allow.includes(permission);
      if (!ok) this.onBlocked(`permission:${permission}`, 'permission');
      callback(ok);
    });

    // --- WebRTC IP leak prevention: never leak local/public IP via STUN ---
    try { ses.setWebrtcIPHandlingPolicy('disable_non_proxied_udp'); } catch { /* older electron */ }

    // --- Anti-fingerprint + cosmetic filters on every page ---
    ses.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (details, callback) => {
      callback({ responseHeaders: details.responseHeaders });
    });
    ses.webContents?.on?.('did-finish-load', () => {});

    const entry = { ses, counters };
    this.sessions.set(partition, entry);
    return entry;
  }

  // Inject cosmetic + privacy scripts into a tab's contents.
  hardenContents(contents) {
    contents.on('did-finish-load', async () => {
      try {
        const s = this.getSettings();
        if (s.blockAds !== false) {
          await contents.insertCSS(COSMETIC_CSS, { cssOrigin: 'user' });
        }
        if (s.antiFingerprint !== false) {
          await contents.executeJavaScript(PRIVACY_JS, true);
        }
      } catch { /* page may have navigated away */ }
    });
  }

  stats() {
    let total = 0, ads = 0, trackers = 0;
    for (const { counters } of this.sessions.values()) {
      total += counters.total; ads += counters.ads; trackers += counters.trackers;
    }
    return { total, ads, trackers };
  }

  resetStats() {
    for (const { counters } of this.sessions.values()) {
      counters.total = 0; counters.ads = 0; counters.trackers = 0;
    }
  }
}

module.exports = { NetworkGuard, shouldBlock };

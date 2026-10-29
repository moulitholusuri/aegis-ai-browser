// Reading Time — a minimal MV3 community extension example.
// Counts the words in the main article and shows a badge in the corner.
(() => {
  const root = document.querySelector('article, main, [role="main"]') || document.body;
  if (!root) return;
  const words = (root.innerText || '').trim().split(/\s+/).filter(Boolean).length;
  if (words < 180) return; // don't clutter short pages
  const minutes = Math.max(1, Math.round(words / 220));

  const badge = document.createElement('div');
  badge.id = 'aegis-reading-time';
  badge.textContent = `⏱ ${minutes} min read`;
  badge.style.cssText = [
    'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
    'padding:6px 10px', 'border-radius:999px',
    'background:#0b1626', 'color:#fbf3e4',
    'font:600 12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    'border:1px solid #ff9933', 'opacity:.94', 'pointer-events:none',
    'box-shadow:0 4px 14px rgba(0,0,0,.35)',
  ].join(';');
  document.documentElement.appendChild(badge);
})();

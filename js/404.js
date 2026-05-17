// Restore the user's theme before paint to prevent a flash, then wire the
// "open from URL" form. Keeps the 404 page free of inline <script> so the
// CSP-hash drift CI check doesn't need to re-pin a hash for this file.

(function () {
  try {
    var saved = localStorage.getItem('mdlab.theme.v1');
    var theme = saved || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    document.documentElement.setAttribute('data-theme', theme);
  } catch (_) {
    // localStorage can throw in private mode / iframe sandbox; theme falls
    // back to the dark default already set on <html>.
  }

  function init() {
    var form = document.getElementById('nf-load-form');
    var input = document.getElementById('nf-load-url');
    if (!form || !input) return;

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var url = (input.value || '').trim();
      if (!url) { input.focus(); return; }
      // Path-prefix style is prettier but the rewrite isn't guaranteed on
      // every host (e.g. forks served from github.io). Query-style works
      // everywhere and the SPA strips it via replaceState on load.
      window.location.assign('/?url=' + encodeURIComponent(url));
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();

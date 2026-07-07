// Content script: applies the user's settings to this page.
// webpenguins.js (loaded before this file) provides the WebPenguins global.
(function () {
  "use strict";

  var DEFAULTS = {
    enabled: true,
    penguins: 8,
    snow: true,
    santa: "medium",
    trees: 0,
    blood: true,
    zap: true,
    disabledSites: [],
    bombNonce: 0,
  };

  var flock = null;
  var lastBombNonce = null;
  var host = location.hostname;

  function shouldRun(s) {
    return s.enabled && (s.disabledSites || []).indexOf(host) === -1;
  }

  function apply(s) {
    if (lastBombNonce === null) {
      lastBombNonce = s.bombNonce || 0;
    } else if ((s.bombNonce || 0) !== lastBombNonce) {
      // One-shot: light the fuses. They stay gone until settings change again
      // or the page reloads.
      lastBombNonce = s.bombNonce || 0;
      if (flock) {
        var f = flock;
        flock = null;
        f.stop();
      }
      return;
    }

    if (shouldRun(s)) {
      if (flock) flock.destroy();
      flock = WebPenguins.start({
        penguins: Number(s.penguins),
        snow: !!s.snow,
        santa: s.santa === "off" ? false : s.santa,
        trees: Number(s.trees) || 0,
        blood: !!s.blood,
        zapOnClick: !!s.zap,
      });
    } else if (flock) {
      var g = flock;
      flock = null;
      g.stop(); // graceful: the classic exit sequence
    }
  }

  chrome.storage.sync.get(DEFAULTS, apply);
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === "sync") chrome.storage.sync.get(DEFAULTS, apply);
  });
})();

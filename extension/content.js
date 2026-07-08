// Content script: applies the user's settings to this page.
// webpenguins.js (loaded before this file) provides the WebPenguins global.
(function () {
  "use strict";

  var DEFAULTS = {
    enabled: true,
    penguins: 25,
    theme: "Penguins",
    snow: true,
    santa: "big",
    trees: 0,
    blood: true,
    zap: true,
    devMode: false,
    disabledSites: [],
    overrides: {}, // host -> { solid: [...], ignore: [...] }
    bombNonce: 0,
  };

  var flock = null;
  var lastBombNonce = null;
  var lastCore = null;
  var host = location.hostname;

  function shouldRun(s) {
    return s.enabled && (s.disabledSites || []).indexOf(host) === -1;
  }

  function siteOverrides(s) {
    return (s.overrides || {})[host] || { solid: [], ignore: [] };
  }

  function saveOverrides(ov) {
    chrome.storage.sync.get(DEFAULTS, function (cur) {
      var all = cur.overrides || {};
      if (ov.solid.length || ov.ignore.length) all[host] = ov;
      else delete all[host]; // keep the sync store tidy
      chrome.storage.sync.set({ overrides: all });
    });
  }

  function apply(s) {
    if (lastBombNonce === null) {
      lastBombNonce = s.bombNonce || 0;
    } else if ((s.bombNonce || 0) !== lastBombNonce) {
      // One-shot: light the fuses. They stay gone until settings change again
      // or the page reloads.
      lastBombNonce = s.bombNonce || 0;
      lastCore = null;
      if (flock) {
        var f = flock;
        flock = null;
        f.stop();
      }
      return;
    }

    var ov = siteOverrides(s);
    var core = JSON.stringify([
      shouldRun(s), s.penguins, s.theme, s.snow, s.santa, s.trees, s.blood, s.zap,
    ]);

    if (shouldRun(s)) {
      if (flock && core === lastCore) {
        // Only dev mode / overrides changed: update live, no restart.
        flock.set({ devMode: !!s.devMode, solid: ov.solid, ignore: ov.ignore });
        return;
      }
      lastCore = core;
      if (flock) flock.destroy();
      flock = WebPenguins.start({
        penguins: Number(s.penguins),
        theme: s.theme,
        snow: !!s.snow,
        santa: s.santa === "off" ? false : s.santa,
        trees: Number(s.trees) || 0,
        blood: !!s.blood,
        zapOnClick: !!s.zap,
        devMode: !!s.devMode,
        solid: ov.solid,
        ignore: ov.ignore,
        onOverridesChange: saveOverrides,
        onDevModeExit: function () {
          chrome.storage.sync.set({ devMode: false });
        },
      });
    } else if (flock) {
      var g = flock;
      flock = null;
      lastCore = null;
      g.stop(); // graceful: the classic exit sequence
    }
  }

  chrome.storage.sync.get(DEFAULTS, apply);
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === "sync") chrome.storage.sync.get(DEFAULTS, apply);
  });
})();

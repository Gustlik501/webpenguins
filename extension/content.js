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
  var host = location.hostname;

  function shouldRun(s) {
    return s.enabled && (s.disabledSites || []).indexOf(host) === -1;
  }

  function siteOverrides(s) {
    var ov = (s.overrides || {})[host] || {};
    return { solid: ov.solid || [], ignore: ov.ignore || [], pixel: ov.pixel || [] };
  }

  function saveOverrides(ov) {
    chrome.storage.sync.get(DEFAULTS, function (cur) {
      var all = cur.overrides || {};
      if (ov.solid.length || ov.ignore.length || ov.pixel.length) all[host] = ov;
      else delete all[host]; // keep the sync store tidy
      chrome.storage.sync.set({ overrides: all });
    });
  }

  // The in-page developer panel edited a setting: save it like the popup
  // would. The storage echo comes back through apply(), where flock.set()
  // sees nothing new and leaves the running flock alone.
  function saveSettings(p) {
    var patch = {};
    if ("penguins" in p) patch.penguins = p.penguins;
    if ("theme" in p) patch.theme = Array.isArray(p.theme) ? p.theme[0] : p.theme;
    if ("snow" in p) patch.snow = !!p.snow;
    if ("santa" in p) patch.santa = p.santa === false ? "off" : p.santa === true ? "big" : p.santa;
    if ("trees" in p) patch.trees = p.trees;
    if ("blood" in p) patch.blood = p.blood;
    if ("zapOnClick" in p) patch.zap = p.zapOnClick;
    chrome.storage.sync.set(patch);
  }

  function optionsFrom(s) {
    var ov = siteOverrides(s);
    return {
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
      pixel: ov.pixel,
    };
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
      if (flock) {
        // Live where possible; the flock rebuilds itself for theme/snow/…
        flock.set(optionsFrom(s));
        return;
      }
      var opts = optionsFrom(s);
      opts.onOverridesChange = saveOverrides;
      opts.onSettingsChange = saveSettings;
      opts.onDevModeExit = function () {
        chrome.storage.sync.set({ devMode: false });
      };
      flock = WebPenguins.start(opts);
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

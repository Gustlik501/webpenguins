// Popup: a thin UI over chrome.storage.sync. Content scripts react to
// storage changes, so there is no messaging and no background worker.
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
  overrides: {},
  bombNonce: 0,
};

var $ = function (id) {
  return document.getElementById(id);
};

var currentHost = null;

function save(patch) {
  chrome.storage.sync.get(DEFAULTS, function (s) {
    var next = Object.assign({}, s, patch);
    chrome.storage.sync.set(next);
  });
}

function render(s) {
  $("enabled").checked = !!s.enabled;
  $("penguins").value = s.penguins;
  $("penguinsCount").textContent = s.penguins;
  $("theme").value = s.theme || "Penguins";
  $("snow").checked = !!s.snow;
  $("santa").value = s.santa === false ? "off" : s.santa;
  $("trees").value = s.trees;
  $("blood").checked = !!s.blood;
  $("zap").checked = !!s.zap;
  $("dev").checked = !!s.devMode;
  if (currentHost) {
    $("site").checked = (s.disabledSites || []).indexOf(currentHost) === -1;
  }
}

chrome.storage.sync.get(DEFAULTS, render);

chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
  try {
    var url = new URL(tabs[0].url);
    if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "file:") {
      currentHost = url.hostname || "(local files)";
      $("siteLabel").textContent = "On " + (url.hostname || "this page");
      chrome.storage.sync.get(DEFAULTS, render);
      return;
    }
  } catch (e) {
    /* fall through */
  }
  $("site").disabled = true;
  $("siteLabel").textContent = "On this site (n/a)";
});

$("enabled").addEventListener("change", function () {
  save({ enabled: this.checked });
});

$("site").addEventListener("change", function () {
  var on = this.checked;
  chrome.storage.sync.get(DEFAULTS, function (s) {
    var sites = (s.disabledSites || []).filter(function (h) {
      return h !== currentHost;
    });
    if (!on && currentHost) sites.push(currentHost);
    save({ disabledSites: sites });
  });
});

$("penguins").addEventListener("input", function () {
  $("penguinsCount").textContent = this.value;
});
$("penguins").addEventListener("change", function () {
  save({ penguins: Number(this.value) });
});

$("theme").addEventListener("change", function () {
  save({ theme: this.value });
});
$("snow").addEventListener("change", function () {
  save({ snow: this.checked });
});
$("santa").addEventListener("change", function () {
  save({ santa: this.value });
});
$("trees").addEventListener("change", function () {
  save({ trees: Math.max(0, Math.min(12, Number(this.value) || 0)) });
});
$("blood").addEventListener("change", function () {
  save({ blood: this.checked });
});
$("zap").addEventListener("change", function () {
  save({ zap: this.checked });
});
$("dev").addEventListener("change", function () {
  save({ devMode: this.checked });
});

$("bomb").addEventListener("click", function () {
  save({ bombNonce: Date.now() });
  window.close();
});

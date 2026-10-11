// Scanner coverage: lazy gates, scrolling contents, line ink, occlusion
// spans, keeping ridden windows on large pages, and carrying moving riders.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser, Tab, sleep } from "./cdp.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scratch = process.env.WP_SCRATCH || path.join(root, ".test");
// Measured before the rewrite with the current dist build on demo/index.html.
// Informational only: sub-millisecond browser timings are inherently noisy.
// Warm up five scans before each measured five-scan median to separate JIT
// startup from the scanner's recurring cost. The recorded baseline is unchanged.
const baseline = { times: [0.9, 0.6, 0.8, 0.7, 0.7], medianMs: 0.7 };
const { proc, port } = await launchBrowser(path.join(scratch, "collide-profile"));
try {
  // Match the baseline's fresh-browser page: measure before loading the
  // large collision fixtures, rather than sharing their renderer history.
  const demo = await Tab.open(port, "file://" + path.join(root, "demo", "index.html"));
  await sleep(2000);
  await demo.eval(`window.flock.destroy(); window.flock = WebPenguins.start({ penguins: 4, snow: false, santa: false, debug: true }); "ok"`);
  await sleep(1500);
  const timing = await demo.eval(`
    (function () {
      for (var warmup = 0; warmup < 5; warmup++) __webpenguins.surfaces.scan();
      var times = [];
      for (var i = 0; i < 5; i++) {
        var start = performance.now();
        __webpenguins.surfaces.scan();
        times.push(performance.now() - start);
      }
      return { warmupScans: 5, times: times, medianMs: times.slice().sort(function (a, b) { return a - b; })[2] };
    })()
  `);
  console.log("SCAN-TIMING:", JSON.stringify({ baseline, current: timing }));
  await demo.eval('window.flock.destroy(); "ok"');
  await demo.send("Page.close");
  demo.close();

  const tab = await Tab.open(port, "file://" + path.join(root, "demo", "collide.html"));
  await sleep(1500);
  await tab.eval(`
    window.__pieces = function (id) {
      var el = document.getElementById(id);
      return __webpenguins.surfaces.surfaces.filter(function (s) { return s.el === el; });
    };
    window.__platformPieces = function (id) {
      var el = document.getElementById(id);
      return __webpenguins.surfaces.platforms.filter(function (s) { return s.el === el; });
    };
    window.__scan = function () {
      __webpenguins.surfaces.scan();
      __webpenguins.world.setRects(__webpenguins.surfaces.getRects());
    };
    window.__cardHit = function (id, x, y) {
      var w = __webpenguins.world;
      var all = w.rects;
      var ids = __pieces(id).map(function (s) { return s.id; });
      try {
        w.rects = all.filter(function (r) { return ids.includes(r.id); });
        return w.intersects(x, y, 1, 1);
      } finally { w.rects = all; }
    };
    window.__scanTiming = function () {
      for (var warmup = 0; warmup < 5; warmup++) __webpenguins.surfaces.scan();
      var times = [];
      for (var i = 0; i < 5; i++) {
        var start = performance.now();
        __webpenguins.surfaces.scan();
        times.push(performance.now() - start);
      }
      return { warmupScans: 5, times: times, medianMs: times.slice().sort(function (a, b) { return a - b; })[2] };
    };
    __scan(); "ok"
  `);

  const scroll = await tab.eval(`
    (async function () {
      // Tracking now mutates live pieces; snapshot the pre-scroll geometry.
      var before = Object.assign({}, __pieces("scroll-card")[0]);
      var scans = __webpenguins.surfaces.scanCount;
      document.getElementById("scroll-box").scrollTop = 60;
      // No manual scan: only the captured element scroll can update in time.
      await new Promise(function (r) { setTimeout(r, 400); });
      var after = __pieces("scroll-card")[0];
      var world = after && __webpenguins.world.rects.find(function (r) { return r.id === after.id; });
      return {
        beforeY: before && before.y, afterY: after && after.y,
        moved60: !!before && !!after && Math.abs(before.y - after.y - 60) <= 1,
        stableId: !!before && !!after && before.id === after.id,
        rescanned: __webpenguins.surfaces.scanCount > scans,
        worldUpdated: !!world && Math.abs(world.y - after.y) <= 1
      };
    })()
  `);
  console.log("SCROLL-BOX:", JSON.stringify(scroll));

  const thin = await tab.eval(`
    (function () {
      __scan();
      var piece = __pieces("thin-rule")[0];
      var rect = piece && __webpenguins.world.rects.find(function (r) { return r.id === piece.id; });
      return { solid: !!rect, height: rect && rect.h, explain: __webpenguins.explain(document.getElementById("thin-rule")).solid };
    })()
  `);
  console.log("THIN-RULE:", JSON.stringify(thin));

  const slim = await tab.eval(`
    (async function () {
      __scan();
      var card = document.getElementById("slim-forced"), before = __pieces("slim-forced")[0];
      var id = before && before.id, y = before && before.y;
      card.style.transform = "translateY(-20px)";
      try {
        await new Promise(function (r) { setTimeout(r, 400); });
        var rect = __webpenguins.world.rects.find(function (r) { return r.id === id; });
        var top = card.getBoundingClientRect().top + scrollY;
        return {
          solid: !!before && before.w === 30, tracked: !!rect && rect.w === 30 && Math.abs(rect.y - top) <= 1,
          moved20: !!rect && Math.abs(y - rect.y - 20) <= 1,
          hot: __webpenguins.surfaces.hot.has(card)
        };
      } finally {
        card.style.transition = "none";
        card.style.transform = "";
        card.getBoundingClientRect();
        card.style.transition = "";
        __scan();
      }
    })()
  `);
  console.log("SLIM-FORCED:", JSON.stringify(slim));

  const headings = await tab.eval(`
    (function () {
      __scan();
      var w = __webpenguins.world;
      var pieces = __pieces("heading-lines").slice().sort(function (a, b) { return a.y - b.y; });
      var range = document.createRange();
      range.selectNodeContents(document.getElementById("heading-lines"));
      var union = range.getBoundingClientRect();
      var first = pieces[0], second = pieces[1];
      var beside = second && { x: (union.left + scrollX + second.x) / 2, y: second.y + second.h / 2 };
      var ids = pieces.map(function (s) { return s.id; });
      __scan();
      var single = __pieces("heading-single");
      range.selectNodeContents(document.getElementById("heading-single"));
      var ink = range.getBoundingClientRect();
      var s = single[0];
      return {
        count: pieces.length,
        boxes: pieces.map(function (s) { return { x: s.x, y: s.y, w: s.w, h: s.h, id: s.id }; }),
        secondShorter: !!second && second.w < first.w * 0.75,
        besideShortLineEmpty: !!beside && !w.intersects(beside.x, beside.y, 1, 1),
        topsSolid: pieces.length === 2 && pieces.every(function (s) { return w.intersects(s.x + s.w / 2, s.y, 1, 1); }),
        unmasked: pieces.every(function (s) { return !s.mask; }) && !!s && !s.mask,
        stableDistinctIds: ids.length === 2 && ids[1] === ids[0] + 1 && ids[0] % 16 === 0 &&
          JSON.stringify(ids) === JSON.stringify(__pieces("heading-lines").map(function (s) { return s.id; })),
        singleUnchanged: single.length === 1 && s.x === ink.left + scrollX && s.y === ink.top + scrollY && s.w === ink.width && s.h === ink.height,
        containingWorks: __webpenguins.surfaces.surfaceContaining(document.querySelector("#heading-lines span")) === document.getElementById("heading-lines"),
        maskedWorks: !__webpenguins.surfaces.surfaceMasked(document.getElementById("heading-lines")),
        explainWorks: __webpenguins.explain(document.getElementById("heading-lines")).solid === true &&
          __webpenguins.explain(document.getElementById("heading-lines")).lines === 2
      };
    })()
  `);
  console.log("HEADING-LINES:", JSON.stringify(headings));

  const deep = await tab.eval(`
    (function () {
      __scan();
      var second = __pieces("deep-second")[0];
      return {
        descendants: document.getElementById("deep-first").querySelectorAll("*").length,
        firstSolid: __pieces("deep-first").length === 1,
        secondSolid: !!second && __webpenguins.world.rects.some(function (r) { return r.id === second.id; })
      };
    })()
  `);
  console.log("DEEP-PAGE:", JSON.stringify(deep));
  const deepTiming = await tab.eval("__scanTiming()");
  console.log("DEEP-SCAN-TIMING:", JSON.stringify(deepTiming));

  const precedence = await tab.eval(`
    (function () {
      var s = __webpenguins.surfaces;
      var initial = __pieces("ignored-region").length === 0 && __pieces("ignored-auto").length === 0 &&
        __pieces("ignored-forced").length === 1 && __pieces("nested-region").length === 1 && __pieces("nested-forced").length === 1;
      // Ignore on the SAME element wins over both solid and pixel selectors.
      s.setOverrides(["#ignored-forced"], ["#ignored-forced"], ["#ignored-forced"]);
      var ignoreWins = __pieces("ignored-forced").length === 0 && s.explain(document.getElementById("ignored-forced")).solid === false;
      s.setOverrides([], [], []);
      return { forcedDescendantsWin: initial, sameElementIgnoreWins: ignoreWins };
    })()
  `);
  console.log("FORCED-PRECEDENCE:", JSON.stringify(precedence));

  const clips = await tab.eval(`
    (function () {
      var s = __webpenguins.surfaces;
      var box = document.getElementById("scroll-box");
      var card = document.getElementById("scroll-card");
      var rect = card.getBoundingClientRect();
      var input = { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
      var original = box.getBoundingClientRect;
      var width = box.style.width;
      var reads = 0;
      box.getBoundingClientRect = function () { reads++; return original.call(this); };
      try {
        s.clearClipCache();
        var first = s.clipByAncestors(card, input);
        var second = s.clipByAncestors(card, input);
        var memoized = reads === 1 && JSON.stringify(first) === JSON.stringify(second);
        box.style.width = "200px";
        s.clearClipCache();
        var changed = s.clipByAncestors(card, input);
        return { memoized: memoized, invalidated: reads === 2 && !!changed && changed.w === 160 };
      } finally {
        box.getBoundingClientRect = original;
        box.style.width = width;
        __scan();
      }
    })()
  `);
  console.log("CLIP-CACHE:", JSON.stringify(clips));

  const occlusion = await tab.eval(`
    (function () {
      scrollTo(0, 0);
      __scan();
      var pieces = __pieces("occluded-card");
      var ids = pieces.map(function (s) { return s.id; });
      var explain = __webpenguins.explain(document.getElementById("occluded-card"));
      __scan();
      return {
        count: pieces.length,
        boxes: pieces.map(function (s) { return { x: s.x, w: s.w, id: s.id }; }),
        coveredEmpty: !__cardHit("occluded-card", 392, 602),
        leftSolid: __cardHit("occluded-card", 152, 602),
        rightSolid: __cardHit("occluded-card", 632, 602),
        coverSolid: __cardHit("occluded-cover", 392, 602),
        stableIds: ids.length === 2 && ids[0] % 16 === 0 && ids[1] === ids[0] + 1 &&
          JSON.stringify(ids) === JSON.stringify(__pieces("occluded-card").map(function (s) { return s.id; })),
        explain: explain.spans,
        explainWorks: explain.solid === true && /^2 visible spans: 32[.][.]272, 512[.][.]752$/.test(explain.spans)
      };
    })()
  `);
  console.log("OCCLUDED-SPANS:", JSON.stringify(occlusion));

  const refinement = await tab.eval(`
    (function () {
      var cover = document.getElementById("occluded-cover");
      var original = cover.style.cssText;
      var narrow = document.createElement("div");
      // All coarse samples miss this sliver, but the surviving left span's
      // midpoint sees it once the large middle cover has been subtracted.
      narrow.style.cssText = "position:absolute;left:145px;top:580px;width:14px;height:120px;background:#623f72;z-index:3";
      document.body.appendChild(narrow);
      try {
        __scan();
        var refined = __pieces("occluded-card").length === 3 && !__cardHit("occluded-card", 152, 602);
        narrow.remove();
        cover.style.left = "32px";
        cover.style.width = "720px";
        __scan();
        var fullyCovered = __pieces("occluded-card").length === 0 &&
          __webpenguins.explain(document.getElementById("occluded-card")).because === "top edge covered by another painting element";
        cover.style.background = "transparent";
        __scan();
        var transparentTrusted = __pieces("occluded-card").length === 1;
        return { refined: refined, fullyCovered: fullyCovered, transparentTrusted: transparentTrusted };
      } finally {
        narrow.remove();
        cover.style.cssText = original;
        __scan();
      }
    })()
  `);
  console.log("SPAN-REFINEMENT:", JSON.stringify(refinement));

  const masks = await tab.eval(`
    (function () {
      scrollTo(0, 600);
      __scan();
      var pieces = __pieces("masked-card");
      var left = pieces[0], right = pieces[1];
      var out = {
        count: pieces.length,
        sharedMask: !!left && !!right && !!left.mask && left.mask === right.mask,
        shiftedDX: !!right && right.maskDX === 480 && left.maskDX === 0 && right.maskDY === left.maskDY,
        rightInk: __cardHit("masked-card", 632, 850),
        rightGap: !__cardHit("masked-card", 592, 850),
        leftInk: __cardHit("masked-card", 152, 850),
        coveredEmpty: !__cardHit("masked-card", 392, 822)
      };
      scrollTo(0, 0);
      __scan();
      out.offscreenTrusted = __pieces("masked-card").length === 1;
      return out;
    })()
  `);
  console.log("MASKED-SPANS:", JSON.stringify(masks));

  const headingSpans = await tab.eval(`
    (function () {
      var first = __pieces("heading-lines")[0];
      var cover = document.createElement("div");
      cover.style.cssText = "position:absolute;z-index:3;background:#ab7046;width:70px;" +
        "left:" + (first.x + 100) + "px;top:" + (first.y - 4) + "px;height:" + (first.h + 4) + "px";
      document.body.appendChild(cover);
      try {
        __scan();
        var pieces = __pieces("heading-lines");
        return {
          count: pieces.length,
          distinctParts: pieces.length === 3 && pieces[0].id % 16 === 0 && pieces[1].id === pieces[0].id + 1 && pieces[2].id === pieces[0].id + 2,
          coveredEmpty: !__cardHit("heading-lines", first.x + 135, first.y + 2),
          unmasked: pieces.every(function (s) { return !s.mask; })
        };
      } finally { cover.remove(); __scan(); }
    })()
  `);
  console.log("HEADING-SPANS:", JSON.stringify(headingSpans));

  const pinned = await tab.eval(`
    (function () {
      var d = __webpenguins, m = d.manager, t = m.toons[0];
      var saved = m.toons.slice(0, m.penguinNumber).map(function (toon) { return Object.assign({}, toon); });
      var cards = document.createElement("div");
      for (var i = 0; i < 200; i++) {
        var card = document.createElement("div");
        card.id = "pin-card-" + i;
        card.setAttribute("data-webpenguins", "solid");
        card.style.cssText = "position:absolute;left:32px;width:160px;height:30px;background:#426b92;top:" + (4000 + i * 100) + "px";
        cards.appendChild(card);
      }
      document.body.appendChild(cards);
      try {
        m.toons.slice(0, m.penguinNumber).forEach(function (toon) { toon.active = false; });
        t.setType("walker", 0, "here");
        t.setVelocity(0, 0);
        scrollTo(0, 600);
        __scan();
        var split = __pieces("masked-card");
        var right = split[1];
        if (!right) return { primed: false };
        t.setPosition(632, right.y - t.data().height);
        t.setAssociation("down");
        // Pin part 1, then scroll far away: off-screen trust merges the
        // card back into part 0. Ownership, not the old part ID, must win.
        scrollTo(0, 23900);
        __scan();
        var ownerPinned = __pieces("masked-card").length === 1 &&
          d.world.rects.some(function (r) { return r.id === split[0].id; });
        // The last card is now in the previous-scan nearest-160 window.
        // Move the camera to the top, not the toon about to stand on it.
        var last = __pieces("pin-card-199")[0];
        if (!last) return { primed: false };
        scrollTo(0, 0);
        t.setType("walker", 0, "here");
        t.setPosition(last.x + 20, last.y - t.data().height);
        t.setVelocity(0, 0);
        t.setAssociation("down");
        __scan();
        var retained = d.world.rects.some(function (r) { return r.id === last.id; });
        var count = d.world.rects.length;
        var sides = [];
        for (var side of ["up", "left", "right", null]) {
          var data = t.data();
          if (side === "up") t.setPosition(last.x + 20, last.y + last.h);
          else if (side === "left") t.setPosition(last.x + last.w, last.y + 5);
          else if (side === "right") t.setPosition(last.x - data.width, last.y + 5);
          else t.setPosition(last.x + 20, last.y - data.height);
          t.setAssociation(side);
          __scan();
          sides.push({ side: side, retained: d.world.rects.some(function (r) { return r.id === last.id; }) });
        }
        t.active = false;
        __scan();
        return {
          primed: true, retained: retained, ownerPinned: ownerPinned, count: count, sides: sides,
          evictedWhenInactive: !d.world.rects.some(function (r) { return r.id === last.id; })
        };
      } finally {
        cards.remove();
        saved.forEach(function (state, i) { Object.assign(m.toons[i], state); });
        scrollTo(0, 0);
        __scan();
      }
    })()
  `);
  console.log("PINNED:", JSON.stringify(pinned));

  const ride = await tab.eval(`
    (async function () {
      var d = __webpenguins, s = d.surfaces, m = d.manager, t = m.toons[0];
      var card = document.getElementById("ride-card");
      var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
      scrollTo(0, 800);
      await wait(350); // let the camera's pending scan settle before placing a rider
      __scan();
      var saved = m.toons.slice(0, m.penguinNumber).map(function (toon) { return Object.assign({}, toon); });
      var originalTrack = s.track;
      var trackedUpdates = 0;
      s.track = function () {
        var before = __pieces("ride-card")[0];
        var y = before && before.y;
        originalTrack.call(this);
        var after = __pieces("ride-card")[0];
        if (after && after.y !== y) trackedUpdates++;
      };
      try {
        m.toons.slice(0, m.penguinNumber).forEach(function (toon) { toon.active = false; });
        var surface = __pieces("ride-card")[0];
        if (!surface) return { placed: false };
        var startY = surface.y;
        t.setType("walker", 0, "here");
        t.setPosition(surface.x + (surface.w - t.data().width) / 2, Math.round(surface.y) - t.data().height);
        t.setVelocity(0, 0);
        t.setAssociation("down");
        var scans = s.scanCount;
        card.style.transform = "translateY(-120px)";
        await wait(1800);
        var freshTop = card.getBoundingClientRect().top + scrollY;
        var feet = t.y + t.data().height;
        var fullScans = s.scanCount - scans;
        return {
          placed: true, active: t.active, type: t.type, feet: feet, cardTop: freshTop,
          riding: t.active && !["squashed", "faller", "tumbler"].includes(t.type) && Math.abs(feet - freshTop) <= 2,
          moved120: Math.abs(startY - freshTop - 120) <= 2,
          fullScans: fullScans, trackedUpdates: trackedUpdates,
          trackingNeeded: trackedUpdates > fullScans && trackedUpdates >= 10,
          err: d.engine.lastError || "none"
        };
      } finally {
        s.track = originalTrack;
        saved.forEach(function (state, i) { Object.assign(m.toons[i], state); });
        card.style.transition = "none";
        card.style.transform = "";
        card.getBoundingClientRect(); // reset without starting a second transition
        card.style.transition = "";
        scrollTo(0, 0);
        __scan();
      }
    })()
  `);
  console.log("RIDE-TRANSITION:", JSON.stringify(ride));

  const bobbing = await tab.eval(`
    (async function () {
      var d = __webpenguins, card = document.getElementById("bobbing-card");
      var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
      var nextTick = function () {
        var tick = d.engine.tickCount, start = performance.now();
        return new Promise(function (resolve) {
          var frame = function () {
            if (d.engine.tickCount !== tick || performance.now() - start > 1000) resolve();
            else requestAnimationFrame(frame);
          };
          requestAnimationFrame(frame);
        });
      };
      // Start sampling just after a natural iteration, away from the
      // triangle wave's turning point (which could repeat a rounded y).
      var animation = card.getAnimations()[0];
      await wait(1000 - animation.currentTime % 1000 + 10);
      var samples = [];
      for (var i = 0; i < 3; i++) {
        if (i) await wait(150);
        // Observe a real engine tick, not a manual scan/track. At 80px/s a
        // random sample could lag the 60ms ticker by more than 2px.
        await nextTick();
        var surface = __pieces("bobbing-card")[0];
        var rect = surface && d.world.rects.find(function (r) { return r.id === surface.id; });
        var domY = card.getBoundingClientRect().top + scrollY;
        samples.push({ atMs: performance.now(), y: rect && rect.y, domY: domY, matches: !!rect && Math.abs(rect.y - domY) <= 2 });
      }
      return {
        samples: samples,
        varying: new Set(samples.map(function (s) { return s.y; })).size === 3,
        allMatch: samples.every(function (s) { return s.matches; }),
        stillHot: d.surfaces.hot.get(card) > performance.now(),
        err: d.engine.lastError || "none"
      };
    })()
  `);
  console.log("BOBBING:", JSON.stringify(bobbing));

  const trackedMask = await tab.eval(`
    (function () {
      var d = __webpenguins, s = d.surfaces;
      var clip = document.getElementById("track-clip");
      var card = document.getElementById("track-mask-card");
      var track = function () { s.track(); d.world.setRects(s.getRects()); };
      scrollTo(0, 1200);
      __scan();
      var pieces = __pieces("track-mask-card");
      if (pieces.length !== 2) return { primed: false };
      var mask = pieces[0].mask, scans = s.scanCount;
      try {
        card.style.transform = "translateX(-60px)";
        // An ancestor's event must heat its surface descendants too.
        clip.dispatchEvent(new Event("transitionrun"));
        track();
        var moved = __pieces("track-mask-card");
        var restoredWidth = moved.length === 2 && moved[1].w === 180 && moved[1].maskDX === 480 && moved[0].maskDX === 60;
        clip.style.width = "660px";
        track();
        var expanded = __pieces("track-mask-card");
        var clipRecomputed = expanded.length === 2 && expanded[1].w === 240;
        var gap = !__cardHit("track-mask-card", 532, 1400);
        var ink = __cardHit("track-mask-card", 600, 1400);
        var beforeSize = expanded.map(function (p) { return [p.x, p.y, p.w, p.h]; });
        var scheduled = s.rescheduleCount;
        card.style.width = "730px";
        track();
        var resizeDeferred = s.rescheduleCount > scheduled && JSON.stringify(beforeSize) ===
          JSON.stringify(__pieces("track-mask-card").map(function (p) { return [p.x, p.y, p.w, p.h]; }));
        card.style.width = "";
        clip.scrollTop = 60;
        clip.dispatchEvent(new Event("scroll"));
        track();
        var scrolled = __pieces("track-mask-card");
        var scrollClipped = scrolled.length === 2 && scrolled.every(function (p) { return p.y === 1340 && p.h === 50 && p.maskDY === 40; });
        var masksPreserved = scrolled.every(function (p) { return p.mask === mask; });
        clip.scrollTop = 130;
        track();
        return {
          primed: true, restoredWidth: restoredWidth, clipRecomputed: clipRecomputed,
          gap: gap, ink: ink, resizeDeferred: resizeDeferred, scrollClipped: scrollClipped,
          masksPreserved: masksPreserved, fullyClippedRemoved: __pieces("track-mask-card").length === 0,
          noFullScans: s.scanCount === scans
        };
      } finally {
        clip.style.width = "";
        clip.scrollTop = 0;
        card.style.width = "";
        card.style.transform = "";
        scrollTo(0, 0);
        __scan();
      }
    })()
  `);
  console.log("TRACK-MASK-CLIP:", JSON.stringify(trackedMask));

  const hot = await tab.eval(`
    (function () {
      var s = __webpenguins.surfaces;
      var saved = new Map(s.hot);
      var parent = document.createElement("div"), cards = [];
      parent.setAttribute("data-webpenguins", "ignore");
      for (var i = 0; i < 33; i++) {
        var card = document.createElement("div");
        card.setAttribute("data-webpenguins", "solid");
        card.style.cssText = "position:absolute;left:900px;width:200px;height:30px;top:" + (2000 + i * 50) + "px";
        parent.appendChild(card);
        cards.push(card);
      }
      document.body.appendChild(parent);
      try {
        __scan();
        s.hot.clear();
        cards.forEach(function (card) { card.dispatchEvent(new Event("transitionstart")); });
        var capped = s.hot.size === 32 && !s.hot.has(cards[0]) && cards.slice(1).every(function (card) { return s.hot.has(card); });
        cards[1].dispatchEvent(new Event("transitionrun"));
        cards[0].dispatchEvent(new Event("animationstart"));
        var recentWins = s.hot.has(cards[0]) && s.hot.has(cards[1]) && !s.hot.has(cards[2]);
        s.hot.clear();
        parent.dispatchEvent(new Event("transitionstart"));
        var ancestorHeats = s.hot.size === 32 && s.hot.has(cards[32]);
        s.hot.clear();
        var child = document.createElement("span");
        cards[32].appendChild(child);
        child.dispatchEvent(new Event("animationiteration"));
        var descendantHeats = s.hot.has(cards[32]) && s.hot.get(cards[32]) > performance.now() + 1900;
        s.hot.clear();
        parent.dispatchEvent(new Event("scroll"));
        var scrollHeats = s.hot.size === 32 && s.hot.has(cards[32]);
        cards[32].style.transform = "translateY(-10px)";
        s.track(); // update live geometry before comparing full-scan snapshots
        s.hot.clear();
        __scan();
        var scanHeats = s.hot.has(cards[32]);
        s.hot.clear();
        s.hot.set(cards[32], performance.now() - 1);
        var scheduled = s.rescheduleCount;
        s.track();
        var coolsAndRescans = !s.hot.has(cards[32]) && s.rescheduleCount > scheduled;
        return {
          capped: capped, recentWins: recentWins, ancestorHeats: ancestorHeats,
          descendantHeats: descendantHeats, scrollHeats: scrollHeats,
          scanHeats: scanHeats, coolsAndRescans: coolsAndRescans
        };
      } finally {
        parent.remove();
        s.hot.clear();
        saved.forEach(function (until, el) { s.hot.set(el, until); });
        __scan();
      }
    })()
  `);
  console.log("HOT-LIFECYCLE:", JSON.stringify(hot));

  const fixed = await tab.eval(`
    (async function () {
      var d = __webpenguins, m = d.manager, t = m.toons[0];
      var saved = m.toons.slice(0, m.penguinNumber).map(function (toon) { return Object.assign({}, toon); });
      var random = Math.random;
      var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
      try {
        m.toons.slice(0, m.penguinNumber).forEach(function (toon) { toon.active = false; toon.terminating = true; });
        // Keep the port's random runner/book choices out of this walker test.
        Math.random = function () { return 0.5; };
        // An empty document-space lane isolates one-way collision from the
        // ordinary cards under the bar when the camera is at the page top.
        scrollTo(0, 1600);
        await wait(350);
        __scan();
        d.engine.tick();
        var piece = __platformPieces("fixed-bar")[0];
        var bar = piece && d.world.platforms.find(function (r) { return r.id === piece.id; });
        if (!bar) return { found: false };
        var separate = !d.world.rects.some(function (r) { return r.id === bar.id; }) &&
          !d.world.intersects(bar.x + bar.w / 2, bar.y + 10, 1, 1);
        var explain = d.explain(document.getElementById("fixed-bar"));
        t.setType("faller", 0, "here");
        t.terminating = false;
        m.penguinNumber = 1; // idle terminated toons may have shrunk the live count
        t.setPosition(bar.x + (bar.w - t.data().width) / 2, bar.y - 60 - t.data().height);
        t.setVelocity(0, 3);
        t.setAssociation(null);
        var start = performance.now();
        while (performance.now() - start < 1400 && t.type !== "walker") await wait(20);
        var landing = { type: t.type, feet: t.y + t.data().height };
        var landed = t.active && t.type === "walker" && Math.abs(t.y + t.data().height - bar.y) <= 1;
        // Keep a stationary rider for the camera move, not a timing-dependent
        // point near the end of the ledge after a long walk.
        t.setPosition(bar.x + (bar.w - t.data().width) / 2, bar.y - t.data().height);
        t.setVelocity(0, 0);
        var oldTop = bar.y;
        scrollBy(0, 20);
        await wait(200);
        var next = d.world.platforms.find(function (r) { return r.id === bar.id; });
        var feet = t.y + t.data().height;
        return {
          found: true, separate: separate, rectangular: !bar.mask,
          explainWorks: explain.platform === true && explain.solid === false && /one-way/.test(explain.note),
          landed: landed, landing: landing, moved20: !!next && next.y === oldTop + 20,
          riding: !!next && t.active && t.type === "walker" && Math.abs(feet - next.y) <= 1,
          feet: feet, top: next && next.y, err: d.engine.lastError || "none"
        };
      } finally {
        Math.random = random;
        saved.forEach(function (state, i) { Object.assign(m.toons[i], state); });
        m.penguinNumber = saved.length;
      }
    })()
  `);
  console.log("FIXED-PLATFORM:", JSON.stringify(fixed));

  const oneWay = await tab.eval(`
    (function () {
      var d = __webpenguins, t = d.manager.toons[0], saved = Object.assign({}, t);
      var platforms = d.world.platforms, rects = d.world.rects;
      var bar = platforms.find(function (r) { return r.id === __platformPieces("fixed-bar")[0].id; });
      var el = document.getElementById("fixed-bar"), left = el.style.left;
      try {
        t.setType("faller", 0, "here");
        t.setPosition(bar.x + 180, bar.y + bar.h + 10);
        var dy = -(bar.h + t.data().height + 30), expected = t.y + dy;
        t.setVelocity(0, dy);
        var status = t.advance();
        var upwardPasses = status === 0 && t.y === expected && t.y + t.data().height < bar.y && !t.blocked("here");
        t.setType("walker", 0, "here");
        t.setPosition(bar.x + 180, bar.y - t.data().height);
        t.setAssociation("down");
        var downOnly = t.blocked("down") && !t.blocked("up") && !t.blocked("left") && !t.blocked("right") && !t.checkBlocked("walker", "here");
        var x = t.x;
        d.world.rects = rects.concat([{ id: -3, x: t.x, y: bar.y, w: t.data().width, h: 1 }]);
        el.style.left = "120px";
        d.engine.updatePlatforms();
        var realGroundWins = t.x === x;
        d.world.rects = rects;
        el.style.left = left;
        d.engine.updatePlatforms();
        t.setPosition(x, bar.y - t.data().height);
        d.world.rects = rects.concat([{ id: -4, x: x + t.data().width + 5, y: t.y, w: 20, h: t.data().height }]);
        el.style.left = "120px";
        d.engine.updatePlatforms();
        var blockedRideLeaves = t.x === x;
        d.world.rects = rects;
        el.style.left = left;
        d.engine.updatePlatforms();
        t.setPosition(x, bar.y - t.data().height);
        el.style.left = "120px";
        d.engine.updatePlatforms();
        var horizontalRide = t.x === x + 20 && t.y + t.data().height === bar.y;
        var horizontal = { beforeX: x, afterX: t.x };
        el.style.left = left;
        d.engine.updatePlatforms();
        var beforeFlick = t.y;
        scrollBy(0, 100);
        d.engine.updatePlatforms();
        var fastScrollLeaves = t.y === beforeFlick;
        var current = d.world.platforms.find(function (r) { return r.id === bar.id; });
        t.setPosition(current.x + 180, current.y + current.h + 10);
        t.setAssociation("down");
        var belowY = t.y;
        scrollBy(0, 20);
        d.engine.updatePlatforms();
        var belowNotCarried = t.y === belowY;
        current = d.world.platforms.find(function (r) { return r.id === bar.id; });
        t.setPosition(current.x + current.w + 1, current.y - t.data().height);
        var offEndUnsupported = !t.blocked("down");
        d.world.platforms = [{ ...current, id: -2, y: current.y + 40 }, current];
        t.setType("faller", 0, "here");
        t.setPosition(current.x + 180, current.y - 10 - t.data().height);
        t.setVelocity(0, 100);
        t.advance();
        var highestWins = t.y + t.data().height === current.y;
        // A landing uses the NEW x, not the starting horizontal position.
        t.setPosition(current.x + current.w + 5, current.y - 10 - t.data().height);
        t.setVelocity(-30, 30);
        t.advance();
        var newXUsed = t.y + t.data().height === current.y;
        t.setPosition(current.x + 180, current.y - t.data().height);
        t.setType("angel", 0, "down");
        t.setVelocity(0, 50);
        var oldFeet = t.y + t.data().height;
        t.advance();
        var noblockPasses = t.data().noblock && t.y + t.data().height === oldFeet + 50;
        return {
          upwardPasses: upwardPasses, downOnly: downOnly, horizontalRide: horizontalRide, horizontal: horizontal,
          fastScrollLeaves: fastScrollLeaves, belowNotCarried: belowNotCarried,
          realGroundWins: realGroundWins, blockedRideLeaves: blockedRideLeaves, offEndUnsupported: offEndUnsupported,
          highestWins: highestWins, newXUsed: newXUsed, noblockPasses: noblockPasses
        };
      } finally {
        el.style.left = left;
        d.world.platforms = platforms;
        d.world.rects = rects;
        Object.assign(t, saved);
        d.engine.updatePlatforms();
      }
    })()
  `);
  console.log("ONE-WAY:", JSON.stringify(oneWay));

  const sticky = await tab.eval(`
    (function () {
      var d = __webpenguins;
      scrollTo(0, 2050);
      // No full scan: sticky geometry must follow the camera on this tick.
      d.engine.tick();
      var el = document.getElementById("sticky-header"), dom = el.getBoundingClientRect();
      var piece = __platformPieces("sticky-header")[0];
      var rect = piece && d.world.platforms.find(function (r) { return r.id === piece.id; });
      return {
        stuck: Math.abs(dom.top - 60) <= 1,
        matches: !!rect && Math.abs(rect.y - dom.top - scrollY) <= 1,
        separate: !!rect && !d.world.rects.some(function (r) { return r.id === rect.id; }),
        rectangular: !!rect && !rect.mask, y: rect && rect.y, domY: dom.top + scrollY
      };
    })()
  `);
  console.log("STICKY:", JSON.stringify(sticky));

  const platformGates = await tab.eval(`
    (function () {
      var d = __webpenguins, s = d.surfaces;
      var root = document.createElement("div");
      root.setAttribute("data-webpenguins", "ignore");
      var margin = document.createElement("div"), parent = document.createElement("div");
      margin.setAttribute("data-webpenguins", "solid");
      margin.style.cssText = "position:fixed;top:10px;left:520px;width:200px;height:10px;background:#345;z-index:30";
      parent.setAttribute("data-webpenguins", "solid");
      parent.style.cssText = "position:fixed;top:100px;left:520px;width:220px;height:100px;background:#345;z-index:30";
      var auto = document.createElement("div"), forced = document.createElement("div");
      auto.style.cssText = "position:absolute;top:30px;left:10px;width:90px;height:20px;background:#c65";
      forced.style.cssText = "position:absolute;top:50px;left:120px;width:70px;height:20px;background:#c65;border-radius:20px";
      forced.setAttribute("data-webpenguins", "pixel");
      parent.append(auto, forced);
      root.append(margin, parent);
      document.body.appendChild(root);
      try {
        __scan();
        d.engine.updatePlatforms();
        var topExcluded = !s.platforms.some(function (p) { return p.el === margin; }) &&
          /24px/.test(d.explain(margin).because);
        var nested = s.platforms.some(function (p) { return p.el === parent; }) &&
          s.platforms.some(function (p) { return p.el === forced; }) &&
          !s.platforms.some(function (p) { return p.el === auto; }) &&
          !s.surfaces.some(function (p) { return p.el === forced || p.el === parent; });
        var pixelIsRect = s.platforms.filter(function (p) { return p.el === forced; }).every(function (p) { return !p.mask; }) && d.explain(forced).platform;
        margin.remove(); parent.remove();
        var cards = [];
        for (var i = 0; i < 14; i++) {
          var card = document.createElement("div");
          card.setAttribute("data-webpenguins", "solid");
          card.style.cssText = "position:fixed;left:1100px;width:140px;height:20px;background:#345;z-index:30;top:" + (50 + i * 30) + "px";
          root.appendChild(card);
          cards.push(card);
        }
        __scan();
        d.engine.updatePlatforms();
        var all = [document.getElementById("fixed-bar"), document.getElementById("sticky-header")].concat(cards);
        all.sort(function (a, b) {
          var ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
          return Math.abs(ar.top + ar.height / 2 - innerHeight / 2) - Math.abs(br.top + br.height / 2 - innerHeight / 2);
        });
        var nearest12 = s.platforms.length === 12 && all.slice(0, 12).every(function (el) { return s.platforms.some(function (p) { return p.el === el; }); });
        var targets = s.platforms.filter(function (p) { return cards.includes(p.el); }).slice(0, 2);
        var detached = targets[0], zero = targets[1];
        detached.el.remove();
        s.getPlatforms();
        root.appendChild(detached.el);
        var detachNeedsScan = !s.getPlatforms().some(function (p) { return p.id === detached.id; });
        zero.el.style.display = "none";
        s.getPlatforms();
        zero.el.style.display = "";
        var zeroNeedsScan = !s.getPlatforms().some(function (p) { return p.id === zero.id; });
        __scan();
        var restored = s.getPlatforms();
        var restoreStableIds = restored.some(function (p) { return p.id === detached.id; }) && restored.some(function (p) { return p.id === zero.id; });
        return { topExcluded: topExcluded, nested: nested, pixelIsRect: pixelIsRect, nearest12: nearest12, detachNeedsScan: detachNeedsScan, zeroNeedsScan: zeroNeedsScan, restoreStableIds: restoreStableIds };
      } finally {
        root.remove();
        __scan();
        d.engine.updatePlatforms();
      }
    })()
  `);
  console.log("PLATFORM-GATES:", JSON.stringify(platformGates));

  const platformUi = await tab.eval(`
    (async function () {
      var d = __webpenguins;
      var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
      window.flock.set({ devMode: true });
      await wait(650);
      var root = document.querySelector("[data-webpenguins-devpanel]").shadowRoot;
      var fab = root.querySelector("[data-wp-fab]");
      if (!fab.hidden) fab.click();
      var count = d.engine.platformCount();
      var stats = root.querySelector("[data-wp-stats]").textContent;
      var canvas = document.createElement("canvas");
      canvas.width = innerWidth; canvas.height = innerHeight;
      var ctx = canvas.getContext("2d"), strokes = [], stroke = ctx.stroke;
      ctx.stroke = function () { strokes.push({ width: this.lineWidth, dash: this.getLineDash() }); stroke.call(this); };
      d.engine.dev.draw(ctx);
      var bar = d.world.platforms.find(function (r) { return r.id === __platformPieces("fixed-bar")[0].id; });
      var top = ctx.getImageData(bar.x + 200 - scrollX, bar.y - scrollY, 1, 1).data;
      var fill = ctx.getImageData(bar.x + 200 - scrollX, bar.y + 10 - scrollY, 1, 1).data;
      var out = {
        countMatches: count > 0 && count === d.world.platforms.length,
        stats: stats, statsIncludePlatforms: stats.includes(count + " platforms ·"),
        solidTop: strokes.some(function (s) { return s.width === 2 && s.dash.length === 0; }) && top[3] > 150,
        lightFill: fill[3] > 0 && fill[3] < 80,
        dashedRest: strokes.some(function (s) { return s.width === 1 && JSON.stringify(s.dash) === "[4,4]"; })
      };
      window.flock.set({ ignore: ["#fixed-bar", "#sticky-header"] });
      await wait(650);
      out.zeroHidden = d.engine.platformCount() === 0 && !root.querySelector("[data-wp-stats]").textContent.includes("platforms");
      window.flock.set({ ignore: [], devMode: false });
      await wait(100);
      scrollTo(0, 0);
      __scan();
      return out;
    })()
  `);
  console.log("PLATFORM-UI:", JSON.stringify(platformUi));

  // Tab.close() only closes CDP's socket. Stop and close the fixture page
  // itself rather than leaving an engine running behind the closed socket.
  await tab.eval('window.flock.destroy(); "ok"');
  await tab.send("Page.close");
  tab.close();

  const ok = scroll.moved60 && scroll.stableId && scroll.rescanned && scroll.worldUpdated &&
    thin.solid && thin.height === 2 && thin.explain && slim.solid && slim.tracked && slim.moved20 && slim.hot &&
    headings.count === 2 && headings.secondShorter && headings.besideShortLineEmpty && headings.topsSolid &&
    headings.unmasked && headings.stableDistinctIds && headings.singleUnchanged &&
    headings.containingWorks && headings.maskedWorks && headings.explainWorks &&
    deep.descendants === 7000 && deep.firstSolid && deep.secondSolid &&
    precedence.forcedDescendantsWin && precedence.sameElementIgnoreWins && clips.memoized && clips.invalidated &&
    occlusion.count === 2 && occlusion.coveredEmpty && occlusion.leftSolid && occlusion.rightSolid &&
    occlusion.coverSolid && occlusion.stableIds && occlusion.explainWorks &&
    refinement.refined && refinement.fullyCovered && refinement.transparentTrusted &&
    masks.count === 2 && masks.sharedMask && masks.shiftedDX && masks.rightInk && masks.rightGap &&
    masks.leftInk && masks.coveredEmpty && masks.offscreenTrusted &&
    headingSpans.count === 3 && headingSpans.distinctParts && headingSpans.coveredEmpty && headingSpans.unmasked &&
    pinned.primed && pinned.retained && pinned.ownerPinned && pinned.count === 160 && pinned.evictedWhenInactive && pinned.sides.every(function (s) { return s.retained; }) &&
    ride.placed && ride.riding && ride.moved120 && ride.trackingNeeded && ride.err === "none" &&
    bobbing.varying && bobbing.allMatch && bobbing.stillHot && bobbing.err === "none" &&
    trackedMask.primed && trackedMask.restoredWidth && trackedMask.clipRecomputed && trackedMask.gap && trackedMask.ink &&
    trackedMask.resizeDeferred && trackedMask.scrollClipped && trackedMask.masksPreserved && trackedMask.fullyClippedRemoved && trackedMask.noFullScans &&
    hot.capped && hot.recentWins && hot.ancestorHeats && hot.descendantHeats && hot.scrollHeats && hot.scanHeats && hot.coolsAndRescans &&
    fixed.found && fixed.separate && fixed.rectangular && fixed.explainWorks && fixed.landed && fixed.moved20 && fixed.riding && fixed.err === "none" &&
    oneWay.upwardPasses && oneWay.downOnly && oneWay.horizontalRide && oneWay.fastScrollLeaves && oneWay.belowNotCarried &&
    oneWay.realGroundWins && oneWay.blockedRideLeaves && oneWay.offEndUnsupported &&
    oneWay.highestWins && oneWay.newXUsed && oneWay.noblockPasses &&
    sticky.stuck && sticky.matches && sticky.separate && sticky.rectangular &&
    platformGates.topExcluded && platformGates.nested && platformGates.pixelIsRect && platformGates.nearest12 &&
    platformGates.detachNeedsScan && platformGates.zeroNeedsScan && platformGates.restoreStableIds &&
    platformUi.countMatches && platformUi.statsIncludePlatforms && platformUi.solidTop && platformUi.lightFill && platformUi.dashedRest && platformUi.zeroHidden;
  console.log("COLLIDE-CHECK:", ok ? "OK" : "FAIL");
  if (!ok) process.exitCode = 1;
} finally {
  proc.kill();
}

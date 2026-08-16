#engine v8

//============================================================================
// probe_preview.js - Measure the native preview pipeline for the screening UI
//
// docs/requirements.md 7.1 proposes building the Stage 2 preview with native
// PJSR calls (computeAutoStretch / applyDisplayFunction / render) instead of
// the per-pixel loop that manual-image-solver's createStretchedBitmap() uses,
// and rendering at 1:1 so that a faint 1-2 px trail is never thinned by a
// downsample. That proposal is reasoned, not measured. This probe measures it.
//
// Questions:
//   1. How long does the native pipeline take per frame, end to end?
//      (654 frames were screened at 757 ms/frame; the UI shows ~94 of them)
//   2. Does render()'s zoomLevel follow the PixInsight convention, i.e. is a
//      negative value a reduction factor? -2 should give 1:2, -3 gives 1:3.
//      PCL reserves -1, so it is not probed.
//   3. What does the `fast` argument change - time, quality, or both?
//   4. Does a reduced render preserve a real meteor trail? This is the
//      question that decides 1:1 versus downsampled, and it cannot be answered
//      from the documentation. Measured as the trail's contrast against the
//      neighbouring background, on a labelled meteor frame.
//   5. Can several 1:1 bitmaps be held at once? 6024x4024 ARGB32 is ~97 MB.
//   6. If 1:1 turns out to be too heavy, is a Bitmap.save() disk cache fast
//      enough to fall back on?
//
// The PJSR reference ships with PixInsight and lists signatures only, so the
// semantics above have to come from measurement. See ../CLAUDE.md.
//
// Run:
//   tools/run-remote.sh --pjsr tests/pjsr/probe_preview.js
//============================================================================

#include "../../javascript/detection_core.js"

var DATA_ROOT = "/Volumes/Extreme SSD/pi_works/meteor-composer-test";
var GROUP = "Light_BIN-1_6024x4024_EXPOSURE-13.00s_FILTER-NoFilter_RGB";
var REGISTERED_DIR = DATA_ROOT + "/registered/" + GROUP;

// A labelled meteor frame (tests/eval/ground_truth.json). Question 4 needs a
// frame that really contains a meteor; a random frame would measure nothing.
var METEOR_FRAME = REGISTERED_DIR + "/pct-2026-08-12_025329_ILCE-7M3_DSC05443_d_r.xisf";

var LOG_PATH = DATA_ROOT + "/probe_preview.log";
var CACHE_DIR = DATA_ROOT + "/probe_preview_cache";

var SCREEN_FACTOR = 8;

// Same options as the evaluated detection run, so the candidate this probe
// picks is the one the UI would actually show.
var DETECT_OPTIONS = {
   backgroundFactor: 8,
   k: 5.0,
   connectivity: 8,
   minPixels: 12,
   minElongation: 6.0,
   minLength: 10.0
};

var _log = [];
var _logPath = null;

function flushLog() {
   var text = _log.join("\n") + "\n";
   var candidates = _logPath !== null
      ? [_logPath]
      : [LOG_PATH, File.systemTempDirectory + "/probe_preview.log"];
   for (var i = 0; i < candidates.length; ++i) {
      try {
         File.writeTextFile(candidates[i], text);
         _logPath = candidates[i];
         return;
      } catch (e) {
      }
   }
}

// Flush on every line. A probe hits unsupported APIs by design, and an
// exception must not take the results collected so far with it.
function log(line) {
   _log.push(line);
   console.writeln(line);
   flushLog();
}

function section(title) {
   log("");
   log("==== " + title + " ====");
}

function probe(label, fn) {
   var t0 = Date.now();
   try {
      var result = fn();
      log("  [OK]   " + label + "  (" + (Date.now() - t0) + " ms)"
          + (result === undefined ? "" : "  => " + result));
      return { ok: true, value: result, ms: Date.now() - t0 };
   } catch (e) {
      log("  [FAIL] " + label + "  => " + e);
      return { ok: false, value: null, ms: -1 };
   }
}

function stage(name, fn) {
   try {
      fn();
   } catch (e) {
      log("  [ABORTED] stage '" + name + "' threw: " + e);
   }
}

// --- Shared state -----------------------------------------------------------

var g = {
   window: null,
   view: null,
   fullWidth: 0,
   fullHeight: 0,
   stf: null,
   stretched: null,   // Image copy with the STF baked in
   trail: null        // { x0, y0, x1, y1 } in full-resolution pixels
};

// --- 1. The native STF pipeline --------------------------------------------

function probeStfPipeline() {
   section("1. Native STF pipeline (WBPP's pattern)");

   var t0 = Date.now();
   var windows = ImageWindow.open(METEOR_FRAME);
   if (!windows || windows.length === 0) {
      log("  [FAIL] could not open " + METEOR_FRAME);
      return false;
   }
   g.window = windows[0];
   g.view = g.window.mainView;
   g.fullWidth = g.view.image.width;
   g.fullHeight = g.view.image.height;
   log("  ImageWindow.open: " + (Date.now() - t0) + " ms");
   log("  image: " + g.fullWidth + "x" + g.fullHeight
       + " x" + g.view.image.numberOfChannels + "ch");

   var median = null, mad = null;

   probe("view.computeOrFetchProperty(\"Median\")", function () {
      median = g.view.computeOrFetchProperty("Median");
      return "type=" + (median ? median.constructor.name : "null")
           + " length=" + (median && median.length !== undefined ? median.length : "n/a");
   });
   probe("view.computeOrFetchProperty(\"MAD\")", function () {
      mad = g.view.computeOrFetchProperty("MAD");
      return "type=" + (mad ? mad.constructor.name : "null");
   });

   // Second call should be nearly free if the property really is cached. That
   // matters: the UI recomputes the STF every time the user moves to a frame.
   probe("computeOrFetchProperty(\"Median\") again (cache check)", function () {
      g.view.computeOrFetchProperty("Median");
      return "";
   });

   probe("image.computeAutoStretch(median, 1.4826*mad, -2.8, 0.25, false)", function () {
      var sigma = [];
      for (var i = 0; i < mad.length; ++i) {
         sigma.push(1.4826 * mad[i]);
      }
      var centre = [];
      for (var j = 0; j < median.length; ++j) {
         centre.push(Math.max(0.00001, median[j]));
      }
      g.stf = g.view.image.computeAutoStretch(centre, sigma, -2.8, 0.25, false);
      return "rows=" + g.stf.length + " row0=[" + g.stf[0].join(", ") + "]";
   });

   if (g.stf === null) {
      log("  [FAIL] no STF; the remaining stages cannot run");
      return false;
   }

   probe("new Image(view.image)  (full-resolution copy)", function () {
      g.stretched = new Image(g.view.image);
      return g.stretched.width + "x" + g.stretched.height;
   });

   probe("image.applyDisplayFunction(stf)", function () {
      g.stretched.applyDisplayFunction(g.stf);
      return "";
   });

   return g.stretched !== null;
}

// --- 2. render() zoomLevel semantics ---------------------------------------

function probeZoomSemantics() {
   section("2. render() zoomLevel: is a negative value a reduction factor?");
   log("  full resolution: " + g.fullWidth + "x" + g.fullHeight);
   log("  (-1 is reserved by PCL and is not probed)");

   var levels = [1, -2, -3, -4, -8];
   for (var i = 0; i < levels.length; ++i) {
      (function (z) {
         probe("render(" + z + ")", function () {
            var bmp = g.stretched.render(z);
            var expected = z > 0
               ? Math.round(g.fullWidth * z)
               : Math.round(g.fullWidth / (-z));
            return bmp.width + "x" + bmp.height
                 + "   expected width if reduction=" + expected
                 + "   ratio=" + (g.fullWidth / bmp.width).toFixed(3);
         });
      })(levels[i]);
   }
}

// --- 3. render() timing, and what `fast` costs ------------------------------

function probeRenderTiming() {
   section("3. render() timing (3 repeats each; the figure that decides 1:1)");

   var cases = [
      { z: 1, fast: false }, { z: 1, fast: true },
      { z: -2, fast: false }, { z: -2, fast: true },
      { z: -3, fast: false }, { z: -3, fast: true }
   ];

   for (var i = 0; i < cases.length; ++i) {
      (function (c) {
         probe("render(" + c.z + ", true, " + c.fast + ") x3", function () {
            var last = null;
            for (var r = 0; r < 3; ++r) {
               last = g.stretched.render(c.z, true, c.fast);
            }
            return last.width + "x" + last.height + " (total for 3)";
         });
      })(cases[i]);
   }

   // End-to-end, as the UI would do it: open a frame, stretch it, render 1:1.
   // This is the number the screening workflow actually feels.
   section("3b. End-to-end per frame, as the UI would do it");
   probe("open + computeAutoStretch + copy + applyDisplayFunction + render(1)", function () {
      var t0 = Date.now();
      var w = ImageWindow.open(METEOR_FRAME)[0];
      var tOpen = Date.now() - t0;
      var v = w.mainView;

      var t1 = Date.now();
      var med = v.computeOrFetchProperty("Median");
      var m = v.computeOrFetchProperty("MAD");
      var sig = [];
      for (var i = 0; i < m.length; ++i) {
         sig.push(1.4826 * m[i]);
      }
      var stf = v.image.computeAutoStretch(med, sig, -2.8, 0.25, false);
      var tStf = Date.now() - t1;

      var t2 = Date.now();
      var img = new Image(v.image);
      img.applyDisplayFunction(stf);
      var tStretch = Date.now() - t2;

      var t3 = Date.now();
      var bmp = img.render();
      var tRender = Date.now() - t3;

      img.free();
      w.forceClose();

      return "open=" + tOpen + " stf=" + tStf + " stretch=" + tStretch
           + " render=" + tRender + " bmp=" + bmp.width + "x" + bmp.height;
   });
}

// --- 4. Does a reduced render preserve a real meteor trail? -----------------

// Luminance of an ARGB32 pixel, Rec. 709 weights, 0-255.
function bitmapLuminance(bmp, x, y) {
   if (x < 0 || y < 0 || x >= bmp.width || y >= bmp.height) {
      return -1;
   }
   var p = bmp.pixel(x, y);
   var r = (p >> 16) & 0xFF;
   var gg = (p >> 8) & 0xFF;
   var b = p & 0xFF;
   return 0.2126 * r + 0.7152 * gg + 0.0722 * b;
}

// Sample along the trail, and along a line offset perpendicular to it. The
// difference is the trail's contrast against its own local background, which
// is what a downsample would erode.
//
// Returns the mean and the peak. The peak matters more: point-sampling a
// 1-2 px line thins it in places, and a mean over the whole line can hide that.
function measureTrail(bmp, scale, samples) {
   var t = g.trail;
   var dx = t.x1 - t.x0, dy = t.y1 - t.y0;
   var len = Math.sqrt(dx * dx + dy * dy);
   if (len < 1) {
      return null;
   }
   var ux = dx / len, uy = dy / len;
   // Perpendicular offset, in full-resolution pixels, clear of the trail.
   var offset = 15;
   var px = -uy * offset, py = ux * offset;

   var sumOn = 0, sumOff = 0, n = 0, peak = -1;
   for (var i = 0; i <= samples; ++i) {
      var f = i / samples;
      var fx = t.x0 + dx * f;
      var fy = t.y0 + dy * f;

      var onX = Math.round(fx * scale), onY = Math.round(fy * scale);
      var offX = Math.round((fx + px) * scale), offY = Math.round((fy + py) * scale);

      var lOn = bitmapLuminance(bmp, onX, onY);
      var lOff = bitmapLuminance(bmp, offX, offY);
      if (lOn < 0 || lOff < 0) {
         continue;
      }
      sumOn += lOn;
      sumOff += lOff;
      if (lOn - lOff > peak) {
         peak = lOn - lOff;
      }
      ++n;
   }
   if (n === 0) {
      return null;
   }
   return {
      n: n,
      trail: sumOn / n,
      background: sumOff / n,
      meanContrast: (sumOn - sumOff) / n,
      peakContrast: peak
   };
}

function locateTrail() {
   section("4. Trail preservation: locate the meteor in the labelled frame");

   var Y = new Image();
   g.view.image.getLuminance(Y);
   Y.resample(1.0 / SCREEN_FACTOR);
   var m = Y.toMatrix();
   var field = { data: m.toArray(), width: Y.width, height: Y.height };

   var r = detectCandidates(field, DETECT_OPTIONS, null);
   log("  candidates in this frame: " + r.candidates.length);
   if (r.candidates.length === 0) {
      log("  [SKIP] no candidate detected; cannot measure trail preservation");
      return false;
   }

   // The longest candidate. On this frame the labelled meteor is the dominant
   // streak, but log them all so the choice can be checked afterwards.
   var best = r.candidates[0];
   for (var i = 0; i < r.candidates.length; ++i) {
      var c = r.candidates[i];
      log("    #" + (i + 1)
          + " length=" + c.length.toFixed(1)
          + " elong=" + c.elongation.toFixed(1)
          + " px=" + c.pixelCount
          + " ends=(" + c.x0 + "," + c.y0 + ")-(" + c.x1 + "," + c.y1 + ")");
      if (c.length > best.length) {
         best = c;
      }
   }

   // Detection coordinates are in the 1/8 field; scale back to full resolution.
   var sx = g.fullWidth / field.width;
   var sy = g.fullHeight / field.height;
   g.trail = {
      x0: best.x0 * sx, y0: best.y0 * sy,
      x1: best.x1 * sx, y1: best.y1 * sy
   };
   log("  chosen trail (full-res px): (" + g.trail.x0.toFixed(0) + "," + g.trail.y0.toFixed(0)
       + ") - (" + g.trail.x1.toFixed(0) + "," + g.trail.y1.toFixed(0) + ")"
       + "  scale=" + sx.toFixed(3) + "/" + sy.toFixed(3));
   return true;
}

function probeTrailPreservation() {
   section("4b. Trail contrast at each zoom level");
   log("  meanContrast/peakContrast are trail minus neighbouring background, 0-255.");
   log("  A reduction that thins the trail shows up as a falling peak.");

   var cases = [
      { z: 1, fast: false }, { z: 1, fast: true },
      { z: -2, fast: false }, { z: -2, fast: true },
      { z: -3, fast: false }, { z: -3, fast: true },
      { z: -4, fast: false }, { z: -4, fast: true }
   ];

   for (var i = 0; i < cases.length; ++i) {
      (function (c) {
         probe("contrast at render(" + c.z + ", true, " + c.fast + ")", function () {
            var bmp = g.stretched.render(c.z, true, c.fast);
            var scale = bmp.width / g.fullWidth;
            var r = measureTrail(bmp, scale, 200);
            if (r === null) {
               return "could not sample";
            }
            return "size=" + bmp.width + "x" + bmp.height
                 + " mean=" + r.meanContrast.toFixed(2)
                 + " peak=" + r.peakContrast.toFixed(2)
                 + " (trail=" + r.trail.toFixed(1) + " bg=" + r.background.toFixed(1)
                 + " n=" + r.n + ")";
         });
      })(cases[i]);
   }

   // Bitmap.scaled() is the other way to reduce: bilinear rather than whatever
   // render() does internally. Worth comparing before choosing.
   probe("contrast at render(1) then Bitmap.scaled(1/3, Bilinear)", function () {
      var bmp = g.stretched.render(1);
      var small = bmp.scaled(1 / 3, 1 / 3, BitmapInterpolation.Bilinear);
      var scale = small.width / g.fullWidth;
      var r = measureTrail(small, scale, 200);
      if (r === null) {
         return "could not sample";
      }
      return "size=" + small.width + "x" + small.height
           + " mean=" + r.meanContrast.toFixed(2)
           + " peak=" + r.peakContrast.toFixed(2);
   });
}

// --- 5. Holding several 1:1 bitmaps ----------------------------------------

function probeMemory() {
   section("5. Holding several 1:1 bitmaps (~97 MB each)");
   log("  The UI wants an LRU cache so that stepping back a frame is instant.");

   var held = [];
   for (var i = 0; i < 4; ++i) {
      (function (n) {
         probe("allocate 1:1 bitmap #" + (n + 1) + " (holding " + (n + 1) + ")", function () {
            held.push(g.stretched.render(1));
            var b = held[held.length - 1];
            return b.width + "x" + b.height
                 + "  approx " + ((b.width * b.height * 4 / 1048576) * held.length).toFixed(0)
                 + " MB held";
         });
      })(i);
   }

   // Confirm the earliest one is still readable, i.e. nothing was silently
   // evicted or invalidated.
   probe("first bitmap still readable after holding 4", function () {
      var l = bitmapLuminance(held[0], Math.round(g.fullWidth / 2), Math.round(g.fullHeight / 2));
      return "centre luminance=" + l.toFixed(1);
   });
}

// --- 6. Disk cache fallback -------------------------------------------------

function probeDiskCache() {
   section("6. Bitmap.save() / new Bitmap(path) as a fallback disk cache");

   try {
      if (!File.directoryExists(CACHE_DIR)) {
         File.createDirectory(CACHE_DIR, true);
      }
   } catch (e) {
      log("  [FAIL] could not create " + CACHE_DIR + " => " + e);
      return;
   }

   var cases = [
      { name: "full.png", z: 1, quality: -1 },
      { name: "third.png", z: -3, quality: -1 },
      { name: "third.jpg", z: -3, quality: 90 }
   ];

   for (var i = 0; i < cases.length; ++i) {
      (function (c) {
         var path = CACHE_DIR + "/" + c.name;
         probe("save " + c.name + " (render(" + c.z + "), quality=" + c.quality + ")", function () {
            var bmp = g.stretched.render(c.z);
            bmp.save(path, c.quality);
            var bytes = File.exists(path) ? File.size(path) : -1;
            return bmp.width + "x" + bmp.height
                 + "  " + (bytes / 1048576).toFixed(1) + " MB";
         });
         probe("load " + c.name, function () {
            var b = new Bitmap(path);
            return b.width + "x" + b.height;
         });
      })(cases[i]);
   }
}

// --- Main -------------------------------------------------------------------

function main() {
   log("MeteorComposer preview probe");
   log("started: " + (new Date()).toISOString());
   log("frame:   " + METEOR_FRAME);

   if (!probeStfPipeline()) {
      log("");
      log("[ABORTED] the STF pipeline did not come up; nothing else can be measured");
      flushLog();
      return;
   }

   stage("zoom semantics", probeZoomSemantics);
   stage("render timing", probeRenderTiming);
   if (locateTrail()) {
      stage("trail preservation", probeTrailPreservation);
   }
   stage("memory", probeMemory);
   stage("disk cache", probeDiskCache);

   section("Done");
   log("finished: " + (new Date()).toISOString());

   try {
      if (g.stretched !== null) {
         g.stretched.free();
      }
      if (g.window !== null) {
         g.window.forceClose();
      }
   } catch (e) {
      log("  cleanup threw: " + e);
   }
   flushLog();
}

main();

#engine v8

//============================================================================
// probe_pixel_access.js - Follow-up probe for MeteorComposer
//
// probe_pjsr_api.js showed that Image.getPixels/setPixels/toArray/pixelValue
// do not exist. The planned architecture (docs/tests.md section 2) hands a
// plain array across the PJSR boundary so the detection core can be tested in
// Node.js, so we must find how bulk pixel data is actually obtained.
//
// This probe answers three questions:
//   1. What is the complete Image API? (enumerate, do not guess)
//   2. Does IntegerResample support a median downsample mode? (the mode
//      constants are non-enumerable, so they must be probed by name)
//   3. Can StarDetector report star elongation? (needs fitPSF/psfElliptic;
//      the detection core wants to calibrate against measured star shape)
//
// Run:
//   /Applications/PixInsight/PixInsight.app/Contents/MacOS/PixInsight \
//     -n --automation-mode --no-splash \
//     -r="<repo>/tests/pjsr/probe_pixel_access.js" --force-exit
//============================================================================

var DATA_ROOT = "/Volumes/Extreme SSD/pi_works/meteor-composer-test/test-sky";
var REGISTERED_DIR = DATA_ROOT + "/registered/Light_BIN-1_6024x4024_EXPOSURE-13.00s_FILTER-NoFilter_RGB";
var SAMPLE_FRAME = REGISTERED_DIR + "/pct-2026-08-12_011807_ILCE-7M3_DSC05001_d_r.xisf";
var LOG_PATH = DATA_ROOT + "/probe_pixel_access.log";

var SCREEN_FACTOR = 8;

// --- Logging ---------------------------------------------------------------

var _log = [];
var _logPath = null;

function flushLog() {
   var text = _log.join("\n") + "\n";
   var candidates = _logPath !== null
      ? [_logPath]
      : [LOG_PATH, File.systemTempDirectory + "/probe_pixel_access.log"];
   for (var i = 0; i < candidates.length; ++i) {
      try {
         File.writeTextFile(candidates[i], text);
         _logPath = candidates[i];
         return;
      } catch (e) {
         // try next
      }
   }
}

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
      return { ok: true, value: result };
   } catch (e) {
      log("  [FAIL] " + label + "  => " + e);
      return { ok: false, value: null };
   }
}

function stage(name, fn) {
   try {
      fn();
   } catch (e) {
      log("  [ABORTED] stage '" + name + "' threw: " + e);
   }
}

// --- 1. Complete Image API -------------------------------------------------

// Enumerable iteration missed non-enumerable prototype members last time, so
// walk the prototype chain with getOwnPropertyNames instead.
function listAllMembers(obj, label) {
   log("  -- " + label + " --");
   var seen = {};
   var names = [];
   var o = obj;
   var depth = 0;
   while (o !== null && o !== undefined && depth < 5) {
      var own;
      try {
         own = Object.getOwnPropertyNames(o);
      } catch (e) {
         break;
      }
      for (var i = 0; i < own.length; ++i) {
         if (!seen[own[i]]) {
            seen[own[i]] = true;
            names.push(own[i]);
         }
      }
      o = Object.getPrototypeOf(o);
      ++depth;
   }
   names.sort();
   log("     " + names.length + " members (own + prototype chain)");
   var line = "     ";
   for (var j = 0; j < names.length; ++j) {
      line += names[j] + " ";
      if (line.length > 100) {
         log(line);
         line = "     ";
      }
   }
   if (line.trim().length > 0) {
      log(line);
   }
}

function probeImageApi() {
   section("Complete Image API");
   var img = new Image(8, 8, 1, ColorSpace.Gray);
   listAllMembers(img, "Image instance, own + prototype chain");

   section("Bulk pixel access candidates");
   var names = ["toArray", "getPixels", "setPixels", "pixelValue", "sample",
                "getSamples", "setSamples", "pixels", "samples", "data",
                "toBlob", "fromBlob", "read", "write", "apply",
                "toMatrix", "fromMatrix", "toVector", "fromVector",
                "getVector", "setVector", "getMatrix", "setMatrix",
                "getRowVector", "getColumnVector", "row", "column"];
   for (var i = 0; i < names.length; ++i) {
      var t;
      try {
         t = typeof img[names[i]];
      } catch (e) {
         t = "(threw)";
      }
      log("  " + (t === "undefined" ? "[MISSING] " : "[present]  ")
          + "Image." + names[i] + " : " + t);
   }
}

// --- 2. Bulk read performance ---------------------------------------------

function probeBulkRead() {
   section("Bulk read of a downsampled frame (753x503 = 378,759 samples)");

   var windows = ImageWindow.open(SAMPLE_FRAME);
   if (!windows || windows.length === 0) {
      log("  [FAIL] could not open sample frame");
      return;
   }
   var win = windows[0];
   try {
      var Y = new Image();
      win.mainView.image.getLuminance(Y);
      Y.resample(1.0 / SCREEN_FACTOR);
      log("  downsampled to " + Y.width + "x" + Y.height);

      // Whatever bulk API exists, try it first.
      probe("Y.toMatrix()", function () {
         var m = Y.toMatrix();
         return "rows=" + m.rows + " cols=" + m.cols;
      });
      probe("Y.toVector()", function () {
         var v = Y.toVector();
         return "length=" + v.length;
      });
      probe("Y.getSamples()", function () {
         var a = Y.getSamples();
         return "length=" + (a ? a.length : "null");
      });

      // Fallback: per-sample access. Measure whether 378k calls are viable.
      probe("Y.sample() over the whole image (per-pixel loop)", function () {
         var w = Y.width, h = Y.height;
         var sum = 0;
         for (var y = 0; y < h; ++y) {
            for (var x = 0; x < w; ++x) {
               sum += Y.sample(x, y);
            }
         }
         return "sum=" + sum.toFixed(6);
      });
   } finally {
      win.forceClose();
   }
}

// --- 3. IntegerResample downsample modes ----------------------------------

function probeIntegerResampleModes() {
   section("IntegerResample downsample modes (constants are non-enumerable)");
   listAllMembers(IntegerResample, "IntegerResample constructor");
   listAllMembers(IntegerResample.prototype, "IntegerResample.prototype");

   var candidates = ["Average", "Median", "Maximum", "Minimum", "Gaussian",
                     "DownsampleMode_Average", "DownsampleMode_Median",
                     "Truncate", "Round"];
   for (var i = 0; i < candidates.length; ++i) {
      var n = candidates[i];
      var v;
      try {
         v = IntegerResample.prototype[n];
      } catch (e) {
         v = undefined;
      }
      log("  " + (v === undefined ? "[MISSING] " : "[present]  ")
          + "IntegerResample.prototype." + n + " = " + v);
   }
}

// --- 4. StarDetector with PSF fitting -------------------------------------

function probeStarPSF() {
   section("StarDetector with PSF fitting (for measured star elongation)");
   var windows = ImageWindow.open(SAMPLE_FRAME);
   if (!windows || windows.length === 0) {
      log("  [FAIL] could not open sample frame");
      return;
   }
   var win = windows[0];
   try {
      var Y = new Image();
      win.mainView.image.getLuminance(Y);

      var d = new StarDetector;
      d.fitPSF = true;
      d.psfElliptic = true;

      var r = probe("stars() with fitPSF=true, psfElliptic=true", function () {
         var stars = d.stars(Y);
         return (stars ? stars.length : "null") + " stars";
      });
      if (!r.ok) {
         return;
      }
      var stars = d.stars(Y);
      if (stars && stars.length > 0) {
         listAllMembers(stars[0], "star[0] with PSF");
         for (var i = 0; i < Math.min(3, stars.length); ++i) {
            var s = stars[i];
            var parts = [];
            for (var k in s) {
               var v;
               try {
                  v = s[k];
                  if (typeof v === "function") {
                     continue;
                  }
                  if (typeof v === "object" && v !== null) {
                     v = "{obj}";
                  }
               } catch (e) {
                  v = "(threw)";
               }
               parts.push(k + "=" + v);
            }
            log("  star[" + i + "]: " + parts.join(" "));
         }
      }
   } finally {
      win.forceClose();
   }
}

// --- Main ------------------------------------------------------------------

function main() {
   log("MeteorComposer pixel access probe");
   log("started: " + (new Date()).toISOString());

   stage("imageApi",            probeImageApi);
   stage("integerResampleModes", probeIntegerResampleModes);
   stage("bulkRead",            probeBulkRead);
   stage("starPSF",             probeStarPSF);

   section("Done");
   log("finished: " + (new Date()).toISOString());
   flushLog();
}

main();

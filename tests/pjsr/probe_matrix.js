#engine v8

//============================================================================
// probe_matrix.js - Final follow-up probe for MeteorComposer
//
// probe_pixel_access.js found that Image.toMatrix() returns a Matrix in ~1 ms
// for a 753x503 image. That is the bulk pixel access the architecture needs,
// but Matrix is a PJSR object: the detection core must receive a plain
// JavaScript array so it can run under Node.js.
//
// Remaining questions:
//   1. What is the Matrix API, and what is the cheapest Matrix -> plain array
//      conversion? (this sits on the hot path: 654 frames)
//   2. What do star.rect / star.srect / star.pos contain? StarDetector does not
//      expose PSF axes, so star elongation must be derived from these.
//   3. Confirm IntegerResample.Median exists on the constructor.
//============================================================================

var DATA_ROOT = "/Volumes/Extreme SSD/pi_works/meteor-composer-test";
var REGISTERED_DIR = DATA_ROOT + "/registered/Light_BIN-1_6024x4024_EXPOSURE-13.00s_FILTER-NoFilter_RGB";
var SAMPLE_FRAME = REGISTERED_DIR + "/pct-2026-08-12_011807_ILCE-7M3_DSC05001_d_r.xisf";
var LOG_PATH = DATA_ROOT + "/probe_matrix.log";
var SCREEN_FACTOR = 8;

var _log = [];
var _logPath = null;

function flushLog() {
   var text = _log.join("\n") + "\n";
   var candidates = _logPath !== null
      ? [_logPath]
      : [LOG_PATH, File.systemTempDirectory + "/probe_matrix.log"];
   for (var i = 0; i < candidates.length; ++i) {
      try {
         File.writeTextFile(candidates[i], text);
         _logPath = candidates[i];
         return;
      } catch (e) {
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

function listAllMembers(obj, label) {
   log("  -- " + label + " --");
   if (obj === null || obj === undefined) {
      log("     (null or undefined)");
      return;
   }
   var seen = {}, names = [], o = obj, depth = 0;
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
   log("     " + names.length + " members");
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

function stage(name, fn) {
   try {
      fn();
   } catch (e) {
      log("  [ABORTED] stage '" + name + "' threw: " + e);
   }
}

// --- Matrix ----------------------------------------------------------------

function probeMatrix() {
   section("Matrix API and conversion to a plain array");

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
      var w = Y.width, h = Y.height;
      log("  working image: " + w + "x" + h + " = " + (w * h) + " samples");

      var m = Y.toMatrix();
      listAllMembers(m, "Matrix instance");
      log("  m.rows = " + m.rows + ", m.cols = " + m.cols);

      probe("m.at(0,0) / m.at(1,2)", function () {
         return m.at(0, 0) + " / " + m.at(1, 2);
      });
      probe("m.toArray()", function () {
         var a = m.toArray();
         return "type=" + (a ? a.constructor.name : "null")
              + " length=" + (a ? a.length : "n/a")
              + " a[0]=" + (a ? a[0] : "n/a");
      });
      probe("m.toFlatArray()", function () {
         var a = m.toFlatArray();
         return "length=" + a.length;
      });

      // The hot-path candidate: whole-pipeline conversion, repeated to get a
      // stable figure. 654 frames make even 50 ms per frame matter.
      probe("toMatrix() + toArray() x3", function () {
         var n = 0;
         for (var i = 0; i < 3; ++i) {
            var mm = Y.toMatrix();
            var aa = mm.toArray();
            n += aa.length;
         }
         return "total elements=" + n;
      });

      probe("m.at() loop over all samples", function () {
         var sum = 0;
         for (var y = 0; y < h; ++y) {
            for (var x = 0; x < w; ++x) {
               sum += m.at(y, x);
            }
         }
         return "sum=" + sum.toFixed(6);
      });
   } finally {
      win.forceClose();
   }
}

// --- Star geometry ---------------------------------------------------------

function probeStarGeometry() {
   section("star.pos / star.rect / star.srect structure");

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
      var stars = d.stars(Y);
      if (!stars || stars.length === 0) {
         log("  [FAIL] no stars");
         return;
      }
      log("  " + stars.length + " stars");
      listAllMembers(stars[0].pos, "star[0].pos");
      listAllMembers(stars[0].rect, "star[0].rect");

      // Concrete values make the field meanings unambiguous.
      for (var i = 0; i < Math.min(5, stars.length); ++i) {
         var s = stars[i];
         var r = s.rect, sr = s.srect, p = s.pos;
         log("  star[" + i + "]"
             + " pos=(" + fmt(p.x) + "," + fmt(p.y) + ")"
             + " rect=[" + fmt(r.x0) + "," + fmt(r.y0) + " - " + fmt(r.x1) + "," + fmt(r.y1) + "]"
             + " w=" + fmt(r.x1 - r.x0) + " h=" + fmt(r.y1 - r.y0)
             + " srect=[" + fmt(sr.x0) + "," + fmt(sr.y0) + " - " + fmt(sr.x1) + "," + fmt(sr.y1) + "]"
             + " sw=" + fmt(sr.x1 - sr.x0) + " sh=" + fmt(sr.y1 - sr.y0)
             + " size=" + fmt(s.size));
      }
      log("  NOTE: rect/srect aspect ratio is the only shape information the");
      log("        detector exposes. It is axis-aligned, so it underestimates");
      log("        elongation for diagonal features.");
   } finally {
      win.forceClose();
   }
}

function fmt(v) {
   if (v === undefined || v === null) {
      return "?";
   }
   return (typeof v === "number") ? v.toFixed(2) : ("" + v);
}

// --- IntegerResample -------------------------------------------------------

function probeIntegerResample() {
   section("IntegerResample downsample mode constants (on the constructor)");
   var names = ["Average", "Median", "Maximum", "Minimum"];
   for (var i = 0; i < names.length; ++i) {
      var v;
      try {
         v = IntegerResample[names[i]];
      } catch (e) {
         v = undefined;
      }
      log("  " + (v === undefined ? "[MISSING] " : "[present]  ")
          + "IntegerResample." + names[i] + " = " + v);
   }
}

// --- Main ------------------------------------------------------------------

function main() {
   log("MeteorComposer matrix / star geometry probe");
   log("started: " + (new Date()).toISOString());

   stage("integerResample", probeIntegerResample);
   stage("matrix",          probeMatrix);
   stage("starGeometry",    probeStarGeometry);

   section("Done");
   log("finished: " + (new Date()).toISOString());
   flushLog();
}

main();

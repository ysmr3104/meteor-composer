#engine v8

//============================================================================
// probe_rotation.js - Settle Bitmap.rotated()'s angle convention and cost
//
// The screening UI needs a rotated preview so that portrait framing can be
// worked with comfortably. Bitmap.rotated( Number angle[, int interpolation ] )
// exists natively, which means manual-image-solver's per-pixel rotateBitmap()
// is not needed - but the reference lists signatures only, and no script
// shipped with PixInsight calls it, so two things are unknown:
//
//   1. Is `angle` in degrees or radians?
//   2. Which way does a positive angle turn?
//
// Getting either wrong is not a crash, it is a preview that is upside down or
// mirrored, and the overlay coordinates would be wrong in a way that looks
// like a geometry bug. So measure instead of guessing.
//
// Also measured, because it decides whether rotation can be done per frame or
// has to be cached:
//
//   3. How long does rotating a 6024x4024 bitmap take?
//   4. Does rotating allocate a second full bitmap? (memory ceiling)
//
// Run:
//   tools/run-remote.sh --pjsr tests/pjsr/probe_rotation.js
//============================================================================

var DATA_ROOT = "/Volumes/Extreme SSD/pi_works/meteor-composer-test";
var GROUP = "Light_BIN-1_6024x4024_EXPOSURE-13.00s_FILTER-NoFilter_RGB";
var FRAME = DATA_ROOT + "/registered/" + GROUP
          + "/pct-2026-08-12_025329_ILCE-7M3_DSC05443_d_r.xisf";
var LOG_PATH = DATA_ROOT + "/probe_rotation.log";

var _log = [];
var _logPath = null;

function flushLog() {
   var text = _log.join("\n") + "\n";
   var candidates = _logPath !== null
      ? [_logPath]
      : [LOG_PATH, File.systemTempDirectory + "/probe_rotation.log"];
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
      return result;
   } catch (e) {
      log("  [FAIL] " + label + "  => " + e);
      return null;
   }
}

// --- A marked test bitmap ---------------------------------------------------
//
// Wider than tall, with a single bright pixel near the top-left corner. After
// a rotation both the shape and where that pixel ended up identify the angle
// unambiguously: a quarter turn one way puts it top-right, the other way
// bottom-left.
function makeMarkedBitmap() {
   var w = 40, h = 20;
   var bmp = new Bitmap(w, h);
   bmp.fill(0xFF000000);
   bmp.setPixel(2, 1, 0xFFFFFFFF);
   return bmp;
}

function findMarker(bmp) {
   for (var y = 0; y < bmp.height; ++y) {
      for (var x = 0; x < bmp.width; ++x) {
         if ((bmp.pixel(x, y) & 0x00FFFFFF) !== 0) {
            return x + "," + y;
         }
      }
   }
   return "not found";
}

function describe(bmp) {
   if (bmp === null || bmp === undefined) {
      return "null";
   }
   return bmp.width + "x" + bmp.height + "  marker at (" + findMarker(bmp) + ")";
}

function probeConvention() {
   section("1. Angle convention");

   var src = makeMarkedBitmap();
   log("  source: " + describe(src) + "   (marker placed at 2,1)");
   log("");
   log("  A quarter turn must swap the dimensions to 20x40. Whichever input");
   log("  produces that is the unit; the marker position gives the direction.");
   log("");

   probe("rotated(Math.PI/2)  [radians?]", function () {
      return describe(src.rotated(Math.PI / 2));
   });
   probe("rotated(90)         [degrees?]", function () {
      return describe(src.rotated(90));
   });
   probe("rotated(-Math.PI/2)", function () {
      return describe(src.rotated(-Math.PI / 2));
   });
   probe("rotated(Math.PI)    [half turn, radians?]", function () {
      return describe(src.rotated(Math.PI));
   });
   probe("rotated(180)        [half turn, degrees?]", function () {
      return describe(src.rotated(180));
   });

   // A half turn is the one case that can be cross-checked against a method
   // whose behaviour is not in doubt.
   probe("mirrored() [reference: a half turn by another route]", function () {
      return describe(src.mirrored());
   });

   log("");
   log("  For reference, an unrotated copy through scaled(1) so that the");
   log("  marker lookup itself can be trusted:");
   probe("scaled(1,1)", function () {
      return describe(src.scaled(1, 1));
   });
}

function probeCost() {
   section("2. Cost on a real frame");

   var windows = ImageWindow.open(FRAME);
   if (!windows || windows.length === 0) {
      log("  [FAIL] could not open " + FRAME);
      return;
   }
   var win = windows[0];
   var stretched = null;
   try {
      var view = win.mainView;
      var median = view.computeOrFetchProperty("Median");
      var mad = view.computeOrFetchProperty("MAD");
      var centre = [], sigma = [];
      for (var i = 0; i < median.length; ++i) {
         centre.push(Math.max(0.00001, median[i]));
         sigma.push(1.4826 * mad[i]);
      }
      var stf = view.image.computeAutoStretch(centre, sigma, -2.8, 0.25, false);
      stretched = new Image(view.image);
      stretched.applyDisplayFunction(stf);

      var full = stretched.render();
      log("  rendered: " + full.width + "x" + full.height
          + "  (~" + Math.round(full.width * full.height * 4 / 1048576) + " MB)");

      // Both candidate units, so the timing is recorded whichever one the
      // convention turns out to be.
      probe("full.rotated(Math.PI/2)", function () {
         var r = full.rotated(Math.PI / 2);
         return r.width + "x" + r.height;
      });
      probe("full.rotated(90)", function () {
         var r = full.rotated(90);
         return r.width + "x" + r.height;
      });

      // Interpolation should not matter for a quarter turn - no resampling is
      // required - but confirm rather than assume.
      probe("full.rotated(Math.PI/2, BitmapInterpolation.NearestNeighbor)", function () {
         var r = full.rotated(Math.PI / 2, BitmapInterpolation.NearestNeighbor);
         return r.width + "x" + r.height;
      });

      // Holding the original plus a rotated copy is the memory question: the
      // frame cache keeps 4 frames, and if each needed a rotated twin the
      // ceiling would double.
      probe("hold original + rotated together", function () {
         var r = full.rotated(Math.PI / 2);
         return "original " + full.width + "x" + full.height
              + " and rotated " + r.width + "x" + r.height + " both live";
      });
   } finally {
      if (stretched !== null) {
         stretched.free();
      }
      win.forceClose();
   }
}

function main() {
   log("MeteorComposer rotation probe");
   log("started: " + (new Date()).toISOString());

   try {
      probeConvention();
   } catch (e) {
      log("  [ABORTED] convention stage threw: " + e);
   }
   try {
      probeCost();
   } catch (e) {
      log("  [ABORTED] cost stage threw: " + e);
   }

   section("Done");
   log("finished: " + (new Date()).toISOString());
   flushLog();
}

main();

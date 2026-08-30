#engine v8

//============================================================================
// probe_pjsr_api.js - PJSR API availability probe for MeteorComposer
//
// NOTE: #engine v8 must be the first directive in the file. PixInsight 1.9.4
//       still runs scripts on the legacy SpiderMonkey runtime by default, and
//       that engine is absent from the arm64 build, so omitting the directive
//       fails with "The legacy 'sm' JavaScript engine is not available in this
//       PixInsight build." The failure is only visible in the PixInsight
//       Process Console, not on stdout.
//
// Purpose:
//   Verify the exact shape of the PJSR APIs the detection pipeline depends on,
//   BEFORE writing any implementation. Nothing here is asserted; the script
//   only reports what actually exists so that docs/requirements.md can be
//   corrected where it guessed.
//
//   Key unknowns (see docs/requirements.md "実装前に確認が必要な PJSR API"):
//     - StarDetector: return value structure of stars()
//     - IntegerResample: does it support a median downsample mode?
//     - Image.getLuminance() / Image.MAD() / Image.median(): signatures
//     - Real I/O timing for a registered frame (182 GB / 654 frames total)
//
// Run:
//   /Applications/PixInsight/PixInsight.app/Contents/MacOS/PixInsight \
//     -n --automation-mode --no-splash \
//     -r="<repo>/tests/pjsr/probe_pjsr_api.js" \
//     --force-exit
//
//   Results are written to LOG_PATH below. console.writeln() does not reach
//   the terminal in automation mode, so the log file is the only output.
//============================================================================

// --- Configuration ---------------------------------------------------------

var DATA_ROOT = "/Volumes/Extreme SSD/pi_works/meteor-composer-test/test-sky";
var REGISTERED_DIR = DATA_ROOT + "/registered/Light_BIN-1_6024x4024_EXPOSURE-13.00s_FILTER-NoFilter_RGB";
var MASTER_PATH = DATA_ROOT + "/master/masterLight_BIN-1_6024x4024_EXPOSURE-13.00s_FILTER-NoFilter_RGB.xisf";

// One frame that is known to contain a meteor (from answer/).
var SAMPLE_FRAME = REGISTERED_DIR + "/pct-2026-08-12_011807_ILCE-7M3_DSC05001_d_r.xisf";

var LOG_PATH = DATA_ROOT + "/probe_pjsr_api.log";

// Downsample factor used by the 1st screening pass.
var SCREEN_FACTOR = 8;

// --- Logging ---------------------------------------------------------------

var _log = [];

// Flush after every line. The probe is expected to hit unsupported APIs and
// throw; if the log were only written at the end, a single exception would
// destroy all results collected so far.
function log(line) {
   _log.push(line);
   console.writeln(line);
   flushLog();
}

function section(title) {
   log("");
   log("==== " + title + " ====");
}

var _logPath = null;

function flushLog() {
   var text = _log.join("\n") + "\n";
   if (_logPath !== null) {
      try {
         File.writeTextFile(_logPath, text);
         return;
      } catch (e) {
         // fall through and re-resolve the path
      }
   }
   var candidates = [LOG_PATH, File.systemTempDirectory + "/probe_pjsr_api.log"];
   for (var i = 0; i < candidates.length; ++i) {
      try {
         File.writeTextFile(candidates[i], text);
         _logPath = candidates[i];
         return;
      } catch (e2) {
         // try the next candidate
      }
   }
}

// typeof on an undeclared identifier is safe, but referencing one is not.
// Callers pass a thunk so a missing global cannot abort the whole probe.
function checkGlobal(name, thunk) {
   var t;
   try {
      t = thunk();
   } catch (e) {
      t = "undefined";
   }
   log("  " + (t === "undefined" ? "[MISSING] " : "[present]  ") + name + " : " + t);
   return t;
}

// Run fn, reporting success or the exception. Never throws.
function probe(label, fn) {
   var t0 = Date.now();
   try {
      var result = fn();
      var ms = Date.now() - t0;
      log("  [OK]   " + label + "  (" + ms + " ms)"
          + (result === undefined ? "" : "  => " + result));
      return { ok: true, value: result, ms: ms };
   } catch (e) {
      log("  [FAIL] " + label + "  => " + e);
      return { ok: false, value: null, ms: Date.now() - t0 };
   }
}

// List enumerable keys of an object with their types. Used to discover the
// real structure of objects whose API shape we are unsure about.
function describe(obj, label, maxKeys) {
   log("  -- " + label + " --");
   if (obj === null || obj === undefined) {
      log("     (null or undefined)");
      return;
   }
   var keys = [];
   for (var k in obj) {
      keys.push(k);
   }
   keys.sort();
   var limit = maxKeys ? Math.min(keys.length, maxKeys) : keys.length;
   log("     " + keys.length + " enumerable keys");
   for (var i = 0; i < limit; ++i) {
      var name = keys[i];
      var type, value = "";
      try {
         type = typeof obj[name];
         if (type === "number" || type === "boolean" || type === "string") {
            value = " = " + obj[name];
         }
      } catch (e) {
         type = "(threw: " + e + ")";
      }
      log("     ." + name + " : " + type + value);
   }
   if (limit < keys.length) {
      log("     ... (" + (keys.length - limit) + " more)");
   }
}

// --- Probes ----------------------------------------------------------------

function probeEnvironment() {
   section("Environment");
   probe("CoreApplication.versionMajor/Minor/Release", function () {
      return CoreApplication.versionMajor + "." + CoreApplication.versionMinor
           + "." + CoreApplication.versionRelease;
   });
   probe("CoreApplication.jsEngineNameAndVersion", function () {
      return CoreApplication.jsEngineNameAndVersion;
   });
   probe("File.systemTempDirectory", function () {
      return File.systemTempDirectory;
   });
}

function probeGlobals() {
   section("Global object availability");
   checkGlobal("Image",            function () { return typeof Image; });
   checkGlobal("ImageWindow",      function () { return typeof ImageWindow; });
   checkGlobal("StarDetector",     function () { return typeof StarDetector; });
   checkGlobal("IntegerResample",  function () { return typeof IntegerResample; });
   checkGlobal("Resample",         function () { return typeof Resample; });
   checkGlobal("LinearFit",        function () { return typeof LinearFit; });
   checkGlobal("PixelMath",        function () { return typeof PixelMath; });
   checkGlobal("MultiscaleLinearTransform", function () { return typeof MultiscaleLinearTransform; });
   checkGlobal("AutomaticBackgroundExtractor", function () { return typeof AutomaticBackgroundExtractor; });
   checkGlobal("Convolution",      function () { return typeof Convolution; });
   checkGlobal("MorphologicalTransformation", function () { return typeof MorphologicalTransformation; });

   section("Colour space constants (V8 dropped the SpiderMonkey globals)");
   checkGlobal("ColorSpace (class)", function () { return typeof ColorSpace; });
   checkGlobal("ColorSpace.RGB",     function () { return "" + ColorSpace.RGB; });
   checkGlobal("ColorSpace.Gray",    function () { return "" + ColorSpace.Gray; });
   checkGlobal("ColorSpace_RGB (legacy)", function () { return typeof ColorSpace_RGB; });
}

function probeImageMethods() {
   section("Image instance methods of interest");
   var img = new Image(64, 64, 3, ColorSpace.RGB);
   var names = ["getLuminance", "resample", "binarize", "median", "MAD",
                "mean", "stdDev", "minimum", "maximum", "rescale", "truncate",
                "convolve", "getPixels", "setPixels", "toArray", "sample",
                "pixelValue", "fill", "assign", "crop", "cropBy", "normalize"];
   for (var i = 0; i < names.length; ++i) {
      var n = names[i];
      var t = typeof img[n];
      log("  " + (t === "function" ? "[present]  " : "[MISSING] ") + "Image." + n + " : " + t);
   }
   describe(IntegerResample.prototype, "IntegerResample.prototype (looking for downsample modes)", 60);
}

function probeSampleFrame() {
   section("Open a registered frame");
   if (!File.exists(SAMPLE_FRAME)) {
      log("  [FAIL] sample frame not found: " + SAMPLE_FRAME);
      return null;
   }
   log("  path: " + SAMPLE_FRAME);

   var r = probe("ImageWindow.open()", function () {
      var w = ImageWindow.open(SAMPLE_FRAME);
      return (w && w.length) ? (w.length + " window(s)") : "no window";
   });
   if (!r.ok) {
      return null;
   }
   log("  NOTE: open took " + r.ms + " ms. Extrapolated for 654 frames: "
       + Math.round(r.ms * 654 / 1000) + " s ("
       + (r.ms * 654 / 60000).toFixed(1) + " min) for I/O alone.");
   return null;
}

function probeFrameDetails() {
   section("Frame geometry and sample format");
   var windows = ImageWindow.open(SAMPLE_FRAME);
   if (!windows || windows.length === 0) {
      log("  [FAIL] could not open frame");
      return;
   }
   var win = windows[0];
   try {
      var img = win.mainView.image;
      log("  width               = " + img.width);
      log("  height              = " + img.height);
      log("  numberOfChannels    = " + img.numberOfChannels);
      log("  bitsPerSample       = " + img.bitsPerSample);
      log("  isReal              = " + img.isReal);
      log("  colorSpace          = " + img.colorSpace);

      probeLuminance(img);
      probeDownsample(img);
      probeStatistics(img);
      probeStarDetector(img);
   } finally {
      win.forceClose();
   }
}

function probeLuminance(img) {
   section("Luminance extraction");
   probe("new Image() + img.getLuminance(Y)", function () {
      var Y = new Image();
      img.getLuminance(Y);
      return "Y is " + Y.width + "x" + Y.height + " ch=" + Y.numberOfChannels;
   });
}

function probeDownsample(img) {
   section("Downsample (screening pass uses 1/" + SCREEN_FACTOR + ")");

   probe("Image.resample(1/" + SCREEN_FACTOR + ") on a copy", function () {
      var tmp = new Image();
      img.getLuminance(tmp);
      tmp.resample(1.0 / SCREEN_FACTOR);
      return tmp.width + "x" + tmp.height;
   });

   // IntegerResample is a process, so it needs a view. Probe its parameters
   // first; the median mode is the thing we actually need to know about.
   probe("new IntegerResample()", function () {
      var p = new IntegerResample;
      var keys = [];
      for (var k in p) {
         keys.push(k);
      }
      return keys.length + " parameters";
   });
   describe(new IntegerResample, "IntegerResample instance parameters", 60);
}

function probeStatistics(img) {
   section("Robust statistics");
   var Y = new Image();
   img.getLuminance(Y);
   probe("Y.median()", function () { return Y.median(); });
   probe("Y.MAD()", function () { return Y.MAD(); });
   probe("Y.mean()", function () { return Y.mean(); });
   probe("Y.stdDev()", function () { return Y.stdDev(); });
   probe("Y.minimum() / Y.maximum()", function () {
      return Y.minimum() + " .. " + Y.maximum();
   });
}

function probeStarDetector(img) {
   section("StarDetector");
   if (typeof StarDetector === "undefined") {
      log("  [FAIL] StarDetector is not defined in this runtime");
      return;
   }
   var sd = probe("new StarDetector()", function () {
      return "created";
   });
   if (!sd.ok) {
      return;
   }
   var detector = new StarDetector;
   describe(detector, "StarDetector instance", 40);

   var Y = new Image();
   img.getLuminance(Y);

   var r = probe("detector.stars(Y) at full resolution", function () {
      var stars = detector.stars(Y);
      return (stars ? stars.length : "null") + " stars";
   });
   if (!r.ok) {
      return;
   }
   var stars = detector.stars(Y);
   if (stars && stars.length > 0) {
      describe(stars[0], "stars[0] structure", 30);
      // Print a couple of concrete entries so the field meanings are obvious.
      for (var i = 0; i < Math.min(3, stars.length); ++i) {
         var s = stars[i];
         var line = "  star[" + i + "]:";
         for (var k in s) {
            var v;
            try {
               v = s[k];
               if (typeof v === "object" && v !== null) {
                  v = "{obj}";
               }
            } catch (e) {
               v = "(threw)";
            }
            line += " " + k + "=" + v;
         }
         log(line);
      }
   }
}

function probeMaster() {
   section("Master light");
   if (!File.exists(MASTER_PATH)) {
      log("  [FAIL] master not found: " + MASTER_PATH);
      return;
   }
   var windows = ImageWindow.open(MASTER_PATH);
   if (!windows || windows.length === 0) {
      log("  [FAIL] could not open master");
      return;
   }
   var win = windows[0];
   try {
      var img = win.mainView.image;
      log("  width            = " + img.width);
      log("  height           = " + img.height);
      log("  numberOfChannels = " + img.numberOfChannels);
      log("  bitsPerSample    = " + img.bitsPerSample);
      log("  isReal           = " + img.isReal);
      log("  NOTE: the uncropped master must match the registered frame geometry");
      log("        exactly, otherwise it cannot be used as a reference or as a");
      log("        composition base without resampling.");
   } finally {
      win.forceClose();
   }
}

// --- Main ------------------------------------------------------------------

// Each stage is isolated so that one unsupported API cannot stop the rest.
function stage(name, fn) {
   try {
      fn();
   } catch (e) {
      log("  [ABORTED] stage '" + name + "' threw: " + e);
   }
}

function main() {
   log("MeteorComposer PJSR API probe");
   log("started: " + (new Date()).toISOString());

   stage("environment",  probeEnvironment);
   stage("globals",      probeGlobals);
   stage("imageMethods", probeImageMethods);
   stage("sampleFrame",  probeSampleFrame);
   stage("frameDetails", probeFrameDetails);
   stage("master",       probeMaster);

   section("Done");
   log("finished: " + (new Date()).toISOString());
   flushLog();
   console.writeln("log written to: " + _logPath);
}

main();

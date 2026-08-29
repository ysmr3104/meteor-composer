#engine v8

//============================================================================
// run_detection.js - Run the detection core over real registered frames
//
// This is the first end-to-end exercise of the Phase 1 screening pass on real
// data. It is deliberately thin: the PJSR layer only reads a frame, extracts
// luminance, downsamples, and hands a plain array to detection_core.js, which
// is the same pure module the Node.js Small tests exercise.
//
// Output is a JSON file of per-frame candidates. Evaluation against the ground
// truth happens in Node (tests/eval/evaluate.js), so that the scoring logic
// stays testable.
//
// Run:
//   /Applications/PixInsight/PixInsight.app/Contents/MacOS/PixInsight \
//     -n --automation-mode --no-splash \
//     -r="<repo>/tests/pjsr/run_detection.js" --force-exit
//
// Configure the frame selection with LIMIT / ONLY_LISTED below.
//============================================================================

#include "../../javascript/detection_core.js"
// detection_core.js merges collinear fragments through candidate_ops.js. Under
// PJSR that has to be included here: the fallback it would otherwise take is
// `require`, which does not exist.
#include "../../javascript/candidate_ops.js"
#include "../../javascript/trail_colour.js"
// For the coordinate system the results are written in. MeteorComposer.js
// records one in every results file, and its own comment says either
// producer's file must be readable by either consumer - so this producer
// records one too.
#include "../../javascript/coordinate_system.js"

var DATA_ROOT = "/Volumes/Extreme SSD/pi_works/meteor-composer-test";
var GROUP = "Light_BIN-1_6024x4024_EXPOSURE-13.00s_FILTER-NoFilter_RGB";
var REGISTERED_DIR = DATA_ROOT + "/registered/" + GROUP;
var OUTPUT_PATH = DATA_ROOT + "/detection_results.json";
var LOG_PATH = DATA_ROOT + "/run_detection.log";

// Which coordinate system these frames are read in (requirements 3.4). For a
// fixed-tripod night, point REGISTERED_DIR at the `debayered` group and set
// this to GROUND_REFERENCED - detection itself is per-frame arithmetic and
// does not care, but everything downstream of the results file does.
var COORDINATE_SYSTEM = SKY_REFERENCED;

// Screening parameters. These are the values under evaluation; they are NOT
// verified by unit tests (docs/tests.md section 5-1).
var SCREEN_FACTOR = 8;
var OPTIONS = {
   backgroundFactor: 8,
   k: 5.0,
   connectivity: 8,
   minPixels: 12,
   minElongation: 6.0,
   minLength: 10.0
};

// 0 = every frame. Set to a small number for a quick pass.
var LIMIT = 0;

var _log = [];
var _logPath = null;

function flushLog() {
   var text = _log.join("\n") + "\n";
   var candidates = _logPath !== null
      ? [_logPath]
      : [LOG_PATH, File.systemTempDirectory + "/run_detection.log"];
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
}

// The frame loop is long, so flush periodically rather than on every line.
function logAndFlush(line) {
   log(line);
   flushLog();
}

// External volumes formatted as exFAT carry macOS AppleDouble sidecars named
// "._<name>". They are not images and must be skipped.
function isRealXisf(name) {
   return name.length > 5
       && name.indexOf("._") !== 0
       && name.indexOf(".") !== 0
       && name.toLowerCase().lastIndexOf(".xisf") === name.length - 5;
}

function listFrames(dir) {
   var names = [];
   var find = new FileFind;
   if (find.begin(dir + "/*")) {
      do {
         if (!find.isDirectory && isRealXisf(find.name)) {
            names.push(find.name);
         }
      } while (find.next());
   }
   names.sort();
   return names;
}

// PJSR layer: image file -> plain field. This is the boundary described in
// docs/tests.md section 2; everything after it is pure JavaScript.
//
// One open serves both jobs. Detection wants the reduced luminance field; the
// colour measurement wants the full-resolution image. Opening the file costs
// about 800 ms of the ~1.2 s a frame takes, so reading it twice would add most
// of ten minutes to a session.
function withFrame(path, factor, fn) {
   var windows = ImageWindow.open(path);
   if (!windows || windows.length === 0) {
      return null;
   }
   var win = windows[0];
   try {
      var image = win.mainView.image;
      var Y = new Image();
      image.getLuminance(Y);
      Y.resample(1.0 / factor);
      var m = Y.toMatrix();
      var field = { data: m.toArray(), width: Y.width, height: Y.height };
      return fn(field, image);
   } finally {
      win.forceClose();
   }
}

// The same measurement the UI takes, so the evaluation data and what an
// operator sees carry the same numbers.
function attachColours(image, candidates, factor) {
   var sampler = function (x, y, channel) {
      return image.sample(x, y, channel);
   };
   for (var i = 0; i < candidates.length; ++i) {
      var colour = null;
      try {
         colour = measureTrailColour(sampler, candidates[i], factor, factor,
                                     image.width, image.height, null);
      } catch (e) {
         colour = null;
      }
      if (colour !== null) {
         candidates[i].colour = colour;
      }
   }
}

function main() {
   logAndFlush("MeteorComposer detection run");
   logAndFlush("started: " + (new Date()).toISOString());
   logAndFlush("group:   " + GROUP);
   logAndFlush("options: k=" + OPTIONS.k
               + " minPixels=" + OPTIONS.minPixels
               + " minElongation=" + OPTIONS.minElongation
               + " minLength=" + OPTIONS.minLength
               + " backgroundFactor=" + OPTIONS.backgroundFactor
               + " screenFactor=" + SCREEN_FACTOR);

   var frames = listFrames(REGISTERED_DIR);
   logAndFlush("frames:  " + frames.length);
   if (LIMIT > 0 && frames.length > LIMIT) {
      frames = frames.slice(0, LIMIT);
      logAndFlush("limited to " + frames.length);
   }

   var results = [];
   var totalCandidates = 0;
   var framesWithCandidates = 0;
   var t0 = Date.now();

   for (var i = 0; i < frames.length; ++i) {
      var name = frames[i];
      var frameStart = Date.now();
      var found = null;
      try {
         found = withFrame(REGISTERED_DIR + "/" + name, SCREEN_FACTOR,
            function (field, image) {
               var result = detectCandidates(field, OPTIONS, null);
               attachColours(image, result.candidates, SCREEN_FACTOR);
               return { field: field, result: result };
            });
      } catch (e) {
         logAndFlush("  [ERROR] " + name + " => " + e);
      }
      if (found === null) {
         results.push({ file: name, error: "could not open", candidates: [] });
         continue;
      }
      var field = found.field;
      var r = found.result;

      totalCandidates += r.candidates.length;
      if (r.candidates.length > 0) {
         ++framesWithCandidates;
      }
      results.push({
         file: name,
         width: field.width,
         height: field.height,
         median: r.median,
         sigma: r.sigma,
         level: r.level,
         componentCount: r.componentCount,
         // How much of the frame held no data. Recorded so that a frame with a
         // large empty region is identifiable from the results file alone.
         noDataSamples: r.noDataSamples,
         fragmentsMerged: r.fragmentsMerged,
         candidates: r.candidates,
         ms: Date.now() - frameStart
      });

      if (r.candidates.length > 0) {
         logAndFlush("  [" + (i + 1) + "/" + frames.length + "] " + name
                     + "  candidates=" + r.candidates.length
                     + "  (" + (Date.now() - frameStart) + " ms)");
      } else if ((i % 50) === 0) {
         logAndFlush("  [" + (i + 1) + "/" + frames.length + "] ...");
      }

      CoreApplication.processEvents();
   }

   var elapsed = Date.now() - t0;
   logAndFlush("");
   logAndFlush("frames processed:       " + results.length);
   logAndFlush("frames with candidates: " + framesWithCandidates);
   logAndFlush("total candidates:       " + totalCandidates);
   logAndFlush("elapsed:                " + (elapsed / 1000).toFixed(1) + " s"
               + " (" + (elapsed / Math.max(1, results.length)).toFixed(0) + " ms/frame)");

   var payload = {
      generated: (new Date()).toISOString(),
      group: GROUP,
      // A full path, so the screening UI can open the frames without being
      // told where they are a second time. `group` is only a directory name
      // and adopting it as a path opens nothing.
      registeredDir: REGISTERED_DIR,
      coordinateSystem: COORDINATE_SYSTEM,
      screenFactor: SCREEN_FACTOR,
      options: OPTIONS,
      elapsedMs: elapsed,
      frames: results
   };
   try {
      File.writeTextFile(OUTPUT_PATH, JSON.stringify(payload));
      logAndFlush("results written: " + OUTPUT_PATH);
   } catch (e) {
      logAndFlush("[ERROR] failed to write results: " + e);
   }
   flushLog();
}

main();

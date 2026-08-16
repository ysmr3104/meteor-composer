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

var DATA_ROOT = "/Volumes/Extreme SSD/pi_works/meteor-composer-test";
var GROUP = "Light_BIN-1_6024x4024_EXPOSURE-13.00s_FILTER-NoFilter_RGB";
var REGISTERED_DIR = DATA_ROOT + "/registered/" + GROUP;
var OUTPUT_PATH = DATA_ROOT + "/detection_results.json";
var LOG_PATH = DATA_ROOT + "/run_detection.log";

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
function loadField(path, factor) {
   var windows = ImageWindow.open(path);
   if (!windows || windows.length === 0) {
      return null;
   }
   var win = windows[0];
   try {
      var Y = new Image();
      win.mainView.image.getLuminance(Y);
      Y.resample(1.0 / factor);
      var m = Y.toMatrix();
      return { data: m.toArray(), width: Y.width, height: Y.height };
   } finally {
      win.forceClose();
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
      var field = null;
      try {
         field = loadField(REGISTERED_DIR + "/" + name, SCREEN_FACTOR);
      } catch (e) {
         logAndFlush("  [ERROR] " + name + " => " + e);
      }
      if (field === null) {
         results.push({ file: name, error: "could not open", candidates: [] });
         continue;
      }

      var r;
      try {
         r = detectCandidates(field, OPTIONS, null);
      } catch (e2) {
         logAndFlush("  [ERROR] detect " + name + " => " + e2);
         results.push({ file: name, error: "" + e2, candidates: [] });
         continue;
      }

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

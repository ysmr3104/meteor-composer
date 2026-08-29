#engine v8

//============================================================================
// probe_meteor_survives_unaligned.js - Do the real meteors survive?
//
// Detecting before StarAlignment cuts the candidate count on this fixed-tripod
// night from 3.81 per frame to 1.63, and every one of the candidates it
// removes is an artefact of the empty area registration leaves behind
// (edgeContact >= 0.3 goes from 2.00 per frame to 0.00).
//
// That is worthless if it also removes meteors. requirements.md is explicit
// that a missed meteor is gone and the operator has no way to know it was ever
// there, so a fall in recall is the one thing that cannot be traded for
// tidiness.
//
// Three candidates on this night have been judged "meteor" by the operator.
// This checks whether each of them is still found in the same frame before
// alignment, and how close the measured geometry is.
//
// Run:
//   tools/run-remote.sh --pjsr tests/pjsr/probe_meteor_survives_unaligned.js
//============================================================================

#include "../../javascript/detection_core.js"
#include "../../javascript/candidate_ops.js"
#include "../../javascript/trail_colour.js"

var DATA_ROOT = "/Volumes/Extreme SSD/pi_works/mave";
var REGISTERED_DIR = DATA_ROOT
   + "/registered/Light_BIN-1_6064x4040_EXPOSURE-13.00s_FILTER-NoFilter_RGB";
var DEBAYERED_DIR = DATA_ROOT
   + "/debayered/Light_BIN-1_6064x4040_EXPOSURE-13.00s_FILTER-NoFilter_CFA";
var RESULTS_PATH = DATA_ROOT + "/detection_results.json";
var SESSION_PATH = DATA_ROOT + "/meteor_session.json";
var LOG_PATH = DATA_ROOT + "/probe_meteor_survives_unaligned.log";

var SCREEN_FACTOR = 8;
var OPTIONS = {
   backgroundFactor: 8,
   k: 5.0,
   connectivity: 8,
   minPixels: 12,
   minElongation: 6.0,
   minLength: 10.0
};

var _log = [];

function say(text) {
   _log.push(text);
   File.writeTextFile(LOG_PATH, _log.join("\n") + "\n");
   console.writeln(text);
}

function frameNumber(name) {
   var m = name.match(/DSC_(\d+)/);
   return m === null ? null : m[1];
}

function detectIn(path) {
   var windows = ImageWindow.open(path);
   if (!windows || windows.length === 0) {
      return null;
   }
   var win = windows[0];
   try {
      var image = win.mainView.image;
      var Y = new Image();
      image.getLuminance(Y);
      Y.resample(1.0 / SCREEN_FACTOR);
      var field = { data: Y.toMatrix().toArray(), width: Y.width, height: Y.height };
      return detectCandidates(field, OPTIONS, null).candidates;
   } finally {
      win.forceClose();
   }
}

// The registered frame and the frame before alignment are in DIFFERENT
// coordinate systems, so a candidate cannot be matched by position. What is
// preserved is the object itself: its length, its elongation, its pixel count.
// Matching on those, and reporting every candidate in the frame so the match
// can be judged rather than trusted.
function describe(c) {
   return "len=" + c.length.toFixed(1)
        + " elong=" + c.elongation.toFixed(2)
        + " px=" + c.pixelCount
        + " angle=" + c.angle.toFixed(1)
        + " at (" + c.cx.toFixed(0) + "," + c.cy.toFixed(0) + ")";
}

function main() {
   say("probe_meteor_survives_unaligned");
   say("");

   var results = JSON.parse(File.readTextFile(RESULTS_PATH));
   var session = JSON.parse(File.readTextFile(SESSION_PATH));

   var byFile = {};
   for (var i = 0; i < results.frames.length; ++i) {
      byFile[results.frames[i].file] = results.frames[i].candidates || [];
   }

   var deb = [];
   var find = new FileFind;
   if (find.begin(DEBAYERED_DIR + "/*.xisf")) {
      do {
         if (!find.isDirectory && find.name.charAt(0) !== ".") {
            deb.push(find.name);
         }
      } while (find.next());
   }
   var debByNumber = {};
   for (var d = 0; d < deb.length; ++d) {
      var dn = frameNumber(deb[d]);
      if (dn !== null) {
         debByNumber[dn] = deb[d];
      }
   }

   var meteors = [];
   for (var v = 0; v < session.verdicts.length; ++v) {
      if (session.verdicts[v].verdict === "meteor") {
         meteors.push(session.verdicts[v]);
      }
   }
   say("meteors judged by the operator: " + meteors.length);
   say("");

   var survived = 0;
   for (var m = 0; m < meteors.length; ++m) {
      var verdict = meteors[m];
      var num = frameNumber(verdict.file);
      var cands = byFile[verdict.file] || [];
      var target = cands[verdict.indexInFrame];
      say("=== " + verdict.file + "  (candidate " + verdict.indexInFrame + ") ===");
      if (target === undefined) {
         say("  not found in the stored results");
         continue;
      }
      say("  registered:   " + describe(target));

      if (debByNumber[num] === undefined) {
         say("  no frame before alignment for " + num);
         continue;
      }
      var found = detectIn(DEBAYERED_DIR + "/" + debByNumber[num]);
      if (found === null) {
         say("  could not open the frame before alignment");
         continue;
      }
      say("  before alignment: " + found.length + " candidates in this frame");

      // Closest by shape. Length carries the most information and is the least
      // affected by resampling, so it leads.
      var best = null, bestCost = 1e9;
      for (var c = 0; c < found.length; ++c) {
         var cost = Math.abs(found[c].length - target.length) / Math.max(1, target.length)
                  + Math.abs(found[c].pixelCount - target.pixelCount)
                    / Math.max(1, target.pixelCount);
         say("      " + describe(found[c]) + "   shape distance " + cost.toFixed(3));
         if (cost < bestCost) {
            bestCost = cost;
            best = found[c];
         }
      }
      if (best !== null && bestCost < 0.5) {
         say("  MATCHED: " + describe(best) + "  (distance " + bestCost.toFixed(3) + ")");
         ++survived;
      } else {
         say("  NO MATCH within tolerance"
             + (best === null ? "" : " (closest distance " + bestCost.toFixed(3) + ")"));
      }
      say("");
   }

   say("meteors still detected before alignment: " + survived + " / " + meteors.length);
   say("done");
}

main();

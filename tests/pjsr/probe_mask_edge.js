#engine v8

//============================================================================
// probe_mask_edge.js - Does the exclusion mask create the candidate that hugs
// its boundary?
//
// A ground-referenced run over 1045 debayered frames produced 1300 candidates,
// of which 1041 were one "fixed structure": a straight line spanning the whole
// width of the working field (length 757.000 of 758), at y = 394.99 every time,
// in 1041 of the 1045 frames. The mask was `bottom 21%`, which puts its
// boundary at y = 505 * 0.79 = 398.95 - four samples below the line.
//
// Two readings, opposite consequences:
//
//   a) The mask is too shallow and the real horizon sits just above it. Then
//      the answer is advice to the operator: cover the horizon.
//   b) The boundary itself produces it - the background model is computed at
//      1/8 of the field and cannot follow a step, so the samples just above a
//      hard cut come out strongly positive right across the frame. Then the
//      answer is in our code, and every operator who sets a mask deep enough
//      to matter will meet it.
//
// The two are told apart by moving the mask: if the line follows the boundary,
// it is (b).
//
// Run:
//   tools/run-remote.sh --pjsr tests/pjsr/probe_mask_edge.js
//============================================================================

#include "../../javascript/detection_core.js"
#include "../../javascript/candidate_ops.js"
#include "../../javascript/trail_colour.js"
#include "../../javascript/mask_geometry.js"

var DATA_ROOT = "/Volumes/Extreme SSD/pi_works/meteor-composer-test/test-ground";
var FRAMES_DIR = DATA_ROOT
   + "/debayered/Light_BIN-1_6064x4040_EXPOSURE-13.00s_FILTER-NoFilter_CFA";
var LOG_PATH = DATA_ROOT + "/probe_mask_edge.log";
var SCREEN_FACTOR = 8;
var OPTIONS = {
   backgroundFactor: 8, k: 5.0, connectivity: 8,
   minPixels: 12, minElongation: 6.0, minLength: 10.0
};

// Frames spread across the night, so this is not one frame's accident.
var FRAMES = ["DSC_1000_d.xisf", "DSC_1300_d.xisf", "DSC_1600_d.xisf"];
var DEPTHS = [0, 10, 21, 30, 40];

var log = [];
function say(line) {
   log.push(line);
   File.writeTextFile(LOG_PATH, log.join("\n") + "\n");
}

// The project's own reader, copied from MeteorComposer.withFrame. Writing a
// second one is how the first attempt at this probe died: it reached for the
// SpiderMonkey colour-space globals, which do not exist under V8, and the log
// stopped at its header.
function loadField(path, factor) {
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
      return { data: m.toArray(), width: Y.width, height: Y.height };
   } finally {
      win.forceClose();
   }
}

function maskFor(depth, width, height) {
   if (depth <= 0) {
      return null;
   }
   var spec = makeEdgeSpec();
   spec.bottom.percent = depth;
   spec.bottom.angle = 0;
   return buildMask(edgeSpecToRegion(spec, width, height), width, height);
}

say("probe_mask_edge");
say("");

for (var f = 0; f < FRAMES.length; ++f) {
   var path = FRAMES_DIR + "/" + FRAMES[f];
   var field = loadField(path, SCREEN_FACTOR);
   if (field === null) {
      say(FRAMES[f] + ": could not open");
      continue;
   }
   say("=== " + FRAMES[f] + "  field " + field.width + "x" + field.height + " ===");
   for (var d = 0; d < DEPTHS.length; ++d) {
      var depth = DEPTHS[d];
      var boundary = field.height * (1 - depth / 100);
      var mask = maskFor(depth, field.width, field.height);
      var r = detectCandidates(field, OPTIONS, mask);
      // The one that spans the frame. Anything longer than 80% of the width is
      // not a meteor at this focal length.
      var wide = [];
      for (var i = 0; i < r.candidates.length; ++i) {
         if (r.candidates[i].length > 0.8 * field.width) {
            wide.push(r.candidates[i]);
         }
      }
      var note = "  bottom " + depth + "%  boundary y=" + boundary.toFixed(1)
               + "   candidates " + r.candidates.length
               + "   full-width " + wide.length;
      for (var j = 0; j < wide.length && j < 3; ++j) {
         note += "\n      len " + wide[j].length.toFixed(1)
               + "  cy " + wide[j].cy.toFixed(2)
               + "  (boundary - cy = " + (boundary - wide[j].cy).toFixed(2) + ")"
               + "  ang " + wide[j].angle.toFixed(1);
      }
      say(note);
   }
   say("");
}

say("done");

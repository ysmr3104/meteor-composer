#engine v8

//============================================================================
// probe_mid_reference_empty.js - Does a better reference frame rescue
// registered input, or only rescue the frames?
//
// The 31% of this night that StarAlignment could not solve turned out to be a
// consequence of one setting: WBPP used DSC_1870 as the reference, which is
// the END of a run spanning DSC_0870 to DSC_1916. With a reference from the
// middle, all three of the frames that had failed - including the very first
// frame of the night - solve in about six seconds each.
//
// That fixes the frame loss. It does not obviously fix the other half of the
// problem, which is geometric rather than a setting: a frame rotated away from
// the reference overlaps it by less, and what does not overlap is written as
// empty. Halving the worst-case rotation should halve nothing in particular -
// the relationship is not linear - so it has to be measured.
//
// The decision that hangs on this:
//
//   if a mid-sequence reference brings the empty area down near the tracked
//   night's 0.24-0.42%, then registered frames remain a reasonable detection
//   input and the fix is a documentation change about choosing a reference
//
//   if it does not, then detection has to move ahead of registration, because
//   half the candidates on this data are artefacts of the empty area's border
//
// Run:
//   tools/run-remote.sh --pjsr tests/pjsr/probe_mid_reference_empty.js
//============================================================================

var DATA_ROOT = "/Volumes/Extreme SSD/pi_works/mave";
var DEBAYERED_DIR = DATA_ROOT
   + "/debayered/Light_BIN-1_6064x4040_EXPOSURE-13.00s_FILTER-NoFilter_CFA";
var OUT_DIR = DATA_ROOT + "/align_probe";
var LOG_PATH = DATA_ROOT + "/probe_mid_reference_empty.log";

var MID_REFERENCE = DEBAYERED_DIR + "/DSC_1393_d.xisf";

// Across the whole night, so the trend with distance from the reference is
// visible instead of one number that hides it.
var TARGETS = ["DSC_0870_d.xisf", "DSC_1106_d.xisf", "DSC_1393_d.xisf",
               "DSC_1655_d.xisf", "DSC_1916_d.xisf"];

var _log = [];

function say(text) {
   _log.push(text);
   File.writeTextFile(LOG_PATH, _log.join("\n") + "\n");
   console.writeln(text);
}

function configure(SA, reference) {
   SA.referenceImage = reference;
   SA.referenceIsFile = true;
   SA.mode = StarAlignment.RegisterMatch;
   SA.structureLayers = 5;
   SA.noiseLayers = 0;
   SA.hotPixelFilterRadius = 1;
   SA.sensitivity = 0.50;
   SA.peakResponse = 0.50;
   SA.brightThreshold = 3.00;
   SA.maxStarDistortion = 0.60;
   SA.maxStars = 0;
   SA.useTriangles = false;
   SA.matcherTolerance = 0.0500;
   SA.ransacTolerance = 1.9000;
   SA.ransacMaxIterations = 2000;
   SA.distortionCorrection = false;
   SA.intersection = StarAlignment.MosaicOnly;
   SA.restrictToPreviews = false;
   SA.generateDrizzleData = false;
   SA.onError = StarAlignment.Continue;
   SA.outputDirectory = OUT_DIR;
   SA.outputExtension = ".xisf";
   SA.outputPostfix = "_r";
   SA.overwriteExistingFiles = true;
   SA.inputHints = "fits-keywords normalize only-first-image raw cfa "
                 + "use-roworder-keywords signed-is-physical";
}

function emptyFraction(path) {
   var win = ImageWindow.open(path)[0];
   if (!win) {
      return null;
   }
   try {
      var image = win.mainView.image;
      image.selectedChannel = 0;
      var data = image.toMatrix().toArray();
      var W = image.width, H = image.height;
      var visited = 0, empty = 0;
      for (var y = 0; y < H; y += 13) {
         var row = y * W;
         for (var x = 0; x < W; x += 13) {
            ++visited;
            if (!(data[row + x] > 0)) {
               ++empty;
            }
         }
      }
      return empty / visited;
   } finally {
      win.forceClose();
   }
}

function main() {
   say("probe_mid_reference_empty");
   say("reference: " + MID_REFERENCE);
   say("");
   if (!File.directoryExists(OUT_DIR)) {
      File.createDirectory(OUT_DIR, true);
   }

   say("frame              solved   empty%");
   for (var i = 0; i < TARGETS.length; ++i) {
      var target = DEBAYERED_DIR + "/" + TARGETS[i];
      var out = OUT_DIR + "/" + File.extractName(target) + "_r.xisf";
      if (File.exists(out)) {
         File.remove(out);
      }
      var SA = new StarAlignment;
      configure(SA, MID_REFERENCE);
      SA.targets = [[true, true, target]];
      try {
         SA.executeGlobal();
      } catch (e) {
         // onError = Continue means a failure does not throw; this catches
         // only the unexpected kind.
         say("  " + TARGETS[i] + "  threw: " + e);
      }
      if (!File.exists(out)) {
         say("  " + TARGETS[i] + "     no       -");
         continue;
      }
      var f = emptyFraction(out);
      say("  " + TARGETS[i] + "     yes      "
          + (f === null ? "?" : (100 * f).toFixed(2) + "%"));
      File.remove(out);
   }

   say("");
   say("  the tracked night measured 0.24% to 0.42%");
   say("  this night with the END-of-night reference measured 4.3% to 66.2%");
   say("");
   say("done");
}

main();

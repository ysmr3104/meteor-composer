#engine v8

//============================================================================
// probe_align_failed_frames.js - Can a meteor found early in the night be
// composited at all?
//
// Detecting before registration recovers the 327 frames StarAlignment could
// not solve - a third of this night. But composition needs the accepted frame
// aligned to the master, so a meteor found in one of those frames is only
// useful if that ONE frame can be aligned afterwards.
//
// What the WBPP log says about the run that failed:
//
//   SA.referenceImage = ".../DSC_1870_d.xisf"   <- the END of the night
//   SA.useTriangles   = false
//   SA.distortionCorrection = false
//
// The frame range is DSC_0870 to DSC_1916, so the reference sits at one
// extreme and the failures are the frames furthest from it. Over roughly 3.8
// hours the sky turns about 57 degrees, and a rectangle rotated that far
// overlaps its own footprint by about a third - which is exactly the 66% empty
// area measured on the surviving frames.
//
// Three things are worth separating, and only measurement can:
//
//   1. the same parameters, one frame at a time, against the MASTER rather
//      than a single reference frame. The master is an integration, so it is
//      deeper and has more stars to match against
//   2. triangle similarity on. PixInsight offers it as the rotation-robust
//      matcher and the failing run had it off
//   3. a reference in the MIDDLE of the night rather than at its end, which
//      halves the worst-case rotation
//
// If none of them work, "found but not compositable" is a state the design has
// to carry. That is still better than not searching a third of the night, but
// it has to be known before the design is settled, not after.
//
// Run:
//   tools/run-remote.sh --pjsr tests/pjsr/probe_align_failed_frames.js
//============================================================================

var DATA_ROOT = "/Volumes/Extreme SSD/pi_works/meteor-composer-test/test-ground";
var DEBAYERED_DIR = DATA_ROOT
   + "/debayered/Light_BIN-1_6064x4040_EXPOSURE-13.00s_FILTER-NoFilter_CFA";
var MASTER = DATA_ROOT
   + "/master/masterLight_BIN-1_6064x4040_EXPOSURE-13.00s_FILTER-NoFilter_RGB.xisf";
var OUT_DIR = DATA_ROOT + "/align_probe";
var LOG_PATH = DATA_ROOT + "/probe_align_failed_frames.log";

// Spread across the part of the night that failed: the very first frame, one
// in the middle of the failed run, and one at its edge where registration was
// just starting to succeed.
var TARGETS = ["DSC_0870_d.xisf", "DSC_1106_d.xisf", "DSC_1239_d.xisf"];

// The reference used by the run that failed, and one from the middle.
var END_REFERENCE = DEBAYERED_DIR + "/DSC_1870_d.xisf";
var MID_REFERENCE = DEBAYERED_DIR + "/DSC_1393_d.xisf";

var _log = [];

function say(text) {
   _log.push(text);
   File.writeTextFile(LOG_PATH, _log.join("\n") + "\n");
   console.writeln(text);
}

// The parameters WBPP actually used, read off the log of the failing run. The
// point of starting here is to reproduce the failure before changing anything;
// a probe that only tries the new settings cannot tell a fix from a fluke.
function configure(SA, reference) {
   SA.referenceImage = reference;
   SA.referenceIsFile = true;
   SA.mode = StarAlignment.RegisterMatch;
   SA.structureLayers = 5;
   SA.noiseLayers = 0;
   SA.hotPixelFilterRadius = 1;
   SA.noiseReductionFilterRadius = 0;
   SA.minStructureSize = 0;
   SA.sensitivity = 0.50;
   SA.peakResponse = 0.50;
   SA.brightThreshold = 3.00;
   SA.maxStarDistortion = 0.60;
   SA.allowClusteredSources = false;
   SA.maxStars = 0;
   SA.useTriangles = false;
   SA.polygonSides = 5;
   SA.descriptorsPerStar = 20;
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

// Success is the output file existing, not executeGlobal() returning. With
// onError = Continue a failure is reported to the console and the call still
// returns, which is the silent-failure shape this project keeps meeting.
function attempt(label, target, reference, tweak) {
   var name = File.extractName(target);
   var out = OUT_DIR + "/" + name + "_r.xisf";
   if (File.exists(out)) {
      File.remove(out);
   }

   var SA = new StarAlignment;
   configure(SA, reference);
   if (tweak !== null) {
      tweak(SA);
   }
   SA.targets = [[true, true, target]];

   var threw = null;
   var started = Date.now();
   try {
      SA.executeGlobal();
   } catch (e) {
      threw = e.message === undefined ? ("" + e) : e.message;
   }
   var ok = File.exists(out);
   say("    " + label + ": " + (ok ? "SOLVED" : "failed")
       + "  (" + ((Date.now() - started) / 1000).toFixed(1) + " s"
       + (threw === null ? "" : ", threw: " + threw) + ")");
   if (ok) {
      File.remove(out);
   }
   return ok;
}

function main() {
   say("probe_align_failed_frames");
   say("master:        " + MASTER);
   say("end reference: " + END_REFERENCE + "   (used by the failing run)");
   say("mid reference: " + MID_REFERENCE);
   say("");

   if (!File.directoryExists(OUT_DIR)) {
      File.createDirectory(OUT_DIR, true);
   }

   var summary = [];
   for (var i = 0; i < TARGETS.length; ++i) {
      var target = DEBAYERED_DIR + "/" + TARGETS[i];
      say(TARGETS[i] + ":");
      if (!File.exists(target)) {
         say("  missing");
         continue;
      }

      var r = {};
      // 1. Reproduce the failure, one frame at a time.
      r.asRun = attempt("as WBPP ran it (reference = end of night)",
                        target, END_REFERENCE, null);
      // 2. Against the master, which is deeper.
      r.master = attempt("against the master",
                         target, MASTER, null);
      // 3. Triangle similarity, which is the rotation-robust matcher.
      r.triangles = attempt("against the master, useTriangles = true",
                            target, MASTER, function (SA) {
                               SA.useTriangles = true;
                            });
      // 4. A reference in the middle of the night.
      r.midRef = attempt("reference = middle of the night",
                         target, MID_REFERENCE, null);
      summary.push({ name: TARGETS[i], r: r });
      say("");
   }

   say("=== summary ===");
   say("frame            as-run  master  triangles  mid-ref");
   for (var s = 0; s < summary.length; ++s) {
      var e = summary[s];
      say("  " + e.name.substring(0, 12)
          + "   " + (e.r.asRun ? "yes" : "no ")
          + "     " + (e.r.master ? "yes" : "no ")
          + "     " + (e.r.triangles ? "yes" : "no ")
          + "        " + (e.r.midRef ? "yes" : "no "));
   }
   say("");
   say("done");
}

main();

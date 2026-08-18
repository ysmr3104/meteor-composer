#engine v8

//============================================================================
// compare_composites.js - Do the UI and the probe produce the same composite?
//
// Stage 4 has two callers. tests/pjsr/run_composite.js is the probe that every
// measurement in docs/requirements.md 7.1.9 to 7.1.11 was taken with, and
// MeteorComposer.js is what an operator actually uses. They share the pure
// modules but each has its own glue: finding the master, listing the accepted
// meteors, moving pixels in and out of PJSR, writing the result.
//
// That glue is where the two can silently diverge - a different master chosen,
// candidates in a different order, a mask option passed by one and not the
// other - and the symptom would be that the probe's measurements no longer
// describe what the operator gets. Nothing else in the suite would notice: both
// outputs are pictures of the sky with meteors in them.
//
// So the two files are compared directly, per channel. Identical inputs through
// identical arithmetic must give identical output, to the bit: there is no
// randomness anywhere in the path and no floating-point reassociation between
// the two, since both call the same functions in the same order.
//
// Run:
//   tools/run-remote.sh --pjsr tests/pjsr/compare_composites.js
//============================================================================

var DATA_ROOT = "/Volumes/Extreme SSD/pi_works/meteor-composer-test";

// A: what the dialog wrote. B: what the probe wrote, kept aside beforehand.
var A_COMPOSITE = DATA_ROOT + "/meteor_composite.xisf";
var A_MASK = DATA_ROOT + "/meteor_composite_mask.xisf";
var B_COMPOSITE = DATA_ROOT + "/backup_20260818/meteor_composite.xisf";
var B_MASK = DATA_ROOT + "/backup_20260818/meteor_composite_mask.xisf";

var A_LABEL = "UI    (MeteorComposer.js)";
var B_LABEL = "probe (run_composite.js)";

var LOG_PATH = DATA_ROOT + "/compare_composites.log";

var _log = [];
var _logPath = null;

function flushLog() {
   var text = _log.join("\n") + "\n";
   var candidates = _logPath !== null
      ? [_logPath]
      : [LOG_PATH, File.systemTempDirectory + "/compare_composites.log"];
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

function channelToArray(image, channel) {
   image.selectedChannel = channel;
   return image.toMatrix().toArray();
}

// Compare one pair of images channel by channel.
//
// Reported per channel rather than as a total: a difference confined to one
// channel is exactly the kind of defect a summed check hides, and this project
// has already been bitten by that once - a composite with light in R only
// passed a check that added the three channels together.
function compare(nameA, pathA, nameB, pathB) {
   var winA = null, winB = null;
   try {
      winA = ImageWindow.open(pathA)[0];
      winB = ImageWindow.open(pathB)[0];
   } catch (e) {
      log("  [FAIL] could not open: " + e);
      return false;
   }
   if (!winA || !winB) {
      log("  [FAIL] could not open one of them");
      return false;
   }

   var same = true;
   try {
      var a = winA.mainView.image;
      var b = winB.mainView.image;

      log("  " + nameA + "  " + a.width + "x" + a.height
          + " x" + a.numberOfChannels + "ch");
      log("  " + nameB + "  " + b.width + "x" + b.height
          + " x" + b.numberOfChannels + "ch");

      if (a.width !== b.width || a.height !== b.height
          || a.numberOfChannels !== b.numberOfChannels) {
         log("  [FAIL] geometry differs");
         return false;
      }

      var names = ["R", "G", "B"];
      for (var ch = 0; ch < a.numberOfChannels; ++ch) {
         var label = ch < names.length ? names[ch] : ("ch" + ch);
         var arrayA = channelToArray(a, ch);
         var arrayB = channelToArray(b, ch);

         var maxDiff = 0;
         var differing = 0;
         var firstIndex = -1;
         for (var i = 0; i < arrayA.length; ++i) {
            var d = arrayA[i] - arrayB[i];
            if (d !== 0) {
               ++differing;
               if (firstIndex < 0) {
                  firstIndex = i;
               }
               var abs = d < 0 ? -d : d;
               if (abs > maxDiff) {
                  maxDiff = abs;
               }
            }
         }

         var line = "  " + label + "  differing samples " + differing
                  + " of " + arrayA.length
                  + "   largest difference " + maxDiff.toExponential(3);
         if (differing > 0) {
            var x = firstIndex % a.width;
            var y = Math.floor(firstIndex / a.width);
            line += "   first at (" + x + ", " + y + ")";
            same = false;
         }
         log(line);
      }
   } finally {
      if (winA) {
         winA.forceClose();
      }
      if (winB) {
         winB.forceClose();
      }
   }
   return same;
}

function main() {
   log("MeteorComposer: comparing the UI's output with the probe's");
   log("started: " + (new Date()).toISOString());
   log("");
   log("Identical inputs through identical arithmetic must give identical");
   log("output. There is nothing random in the path, and both callers invoke");
   log("the same functions in the same order, so any difference at all is a");
   log("difference in the glue: the master chosen, the candidate order, the");
   log("options passed, or how pixels are moved in and out.");

   var missing = [];
   var paths = [A_COMPOSITE, A_MASK, B_COMPOSITE, B_MASK];
   for (var i = 0; i < paths.length; ++i) {
      if (!File.exists(paths[i])) {
         missing.push(paths[i]);
      }
   }
   if (missing.length > 0) {
      section("Inputs missing");
      for (i = 0; i < missing.length; ++i) {
         log("  " + missing[i]);
      }
      log("");
      log("  Run the composite from the dialog and from run_composite.js, with");
      log("  one of the two results moved aside first.");
      flushLog();
      return;
   }

   section("The composites");
   var compositesMatch = compare(A_LABEL, A_COMPOSITE, B_LABEL, B_COMPOSITE);

   section("The masks");
   var masksMatch = compare(A_LABEL, A_MASK, B_LABEL, B_MASK);

   section("Verdict");
   if (compositesMatch && masksMatch) {
      log("  PASS - the two paths produce the same composite and the same mask,");
      log("  to the bit. Every measurement taken with the probe describes what");
      log("  the dialog produces.");
   } else {
      log("  FAIL - the paths disagree.");
      log("");
      log("  The composite" + (compositesMatch ? " matches" : " DIFFERS")
          + ", the mask" + (masksMatch ? " matches" : " DIFFERS") + ".");
      log("  A difference in the mask alone points at the mask options or the");
      log("  candidate geometry; a difference in the composite alone points at");
      log("  the master or at the write-back.");
   }

   section("Done");
   log("finished: " + (new Date()).toISOString());
   flushLog();
}

main();

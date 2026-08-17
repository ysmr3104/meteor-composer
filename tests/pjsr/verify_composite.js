#engine v8

//============================================================================
// verify_composite.js - Is the composite actually right?
//
// A wrong composite looks like a right one. The mask can be in the wrong
// place, the fit can be against the wrong reference, the residual can carry a
// bias - and the output is still a picture of the sky with meteors in it. So
// the properties that define correctness are checked directly against the
// files that were written:
//
//   1. Outside the mask the composite must equal the master EXACTLY. Any
//      difference there is light that arrived from somewhere it should not
//      have, and it would be sub-frame noise.
//   2. Inside the mask the composite must be brighter, not darker. The stage
//      adds a meteor's light; it does not remove anything.
//   3. The brightest additions must sit where the meteors are, which is a
//      check that the mask is aligned with the trails rather than merely
//      being somewhere plausible.
//
// Also looks at the one frame the plausibility guard rejected, so the
// rejection can be judged rather than assumed correct.
//
// Run:
//   tools/run-remote.sh --pjsr tests/pjsr/verify_composite.js
//============================================================================

var DATA_ROOT = "/Volumes/Extreme SSD/pi_works/meteor-composer-test";
var GROUP = "Light_BIN-1_6024x4024_EXPOSURE-13.00s_FILTER-NoFilter_RGB";
var MASTER_DIR = DATA_ROOT + "/master";
var REGISTERED_DIR = DATA_ROOT + "/registered/" + GROUP;
var COMPOSITE_PATH = DATA_ROOT + "/meteor_composite.xisf";
var MASK_PATH = DATA_ROOT + "/meteor_composite_mask.xisf";
var REJECTED_FRAME = "pct-2026-08-12_005413_ILCE-7M3_DSC04908_d_r.xisf";
var LOG_PATH = DATA_ROOT + "/verify_composite.log";

var _log = [];
var _logPath = null;

function flushLog() {
   var text = _log.join("\n") + "\n";
   var candidates = _logPath !== null
      ? [_logPath]
      : [LOG_PATH, File.systemTempDirectory + "/verify_composite.log"];
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

function isRealXisf(name) {
   return name.length > 5
       && name.indexOf("._") !== 0
       && name.indexOf(".") !== 0
       && name.toLowerCase().lastIndexOf(".xisf") === name.length - 5;
}

function findMaster() {
   var plain = null, autocrop = null;
   var find = new FileFind;
   if (find.begin(MASTER_DIR + "/*")) {
      do {
         if (find.isDirectory || !isRealXisf(find.name)) {
            continue;
         }
         if (find.name.indexOf("autocrop") >= 0) {
            autocrop = MASTER_DIR + "/" + find.name;
         } else if (plain === null) {
            plain = MASTER_DIR + "/" + find.name;
         }
      } while (find.next());
   }
   return plain !== null ? plain : autocrop;
}

function channelToArray(image, channel) {
   image.selectedChannel = channel;
   return image.toMatrix().toArray();
}

function main() {
   log("MeteorComposer composite verification");
   log("started: " + (new Date()).toISOString());

   var masterPath = findMaster();
   if (masterPath === null || !File.exists(COMPOSITE_PATH) || !File.exists(MASK_PATH)) {
      log("[FAIL] inputs missing - run run_composite.js first");
      return;
   }

   var masterWin = ImageWindow.open(masterPath)[0];
   var compWin = ImageWindow.open(COMPOSITE_PATH)[0];
   var maskWin = ImageWindow.open(MASK_PATH)[0];

   try {
      var master = masterWin.mainView.image;
      var comp = compWin.mainView.image;
      var maskImage = maskWin.mainView.image;

      section("Geometry");
      log("  master:    " + master.width + "x" + master.height
          + " x" + master.numberOfChannels + "ch");
      log("  composite: " + comp.width + "x" + comp.height
          + " x" + comp.numberOfChannels + "ch");
      log("  mask:      " + maskImage.width + "x" + maskImage.height
          + " x" + maskImage.numberOfChannels + "ch");

      if (comp.width !== master.width || comp.height !== master.height
          || comp.numberOfChannels !== master.numberOfChannels) {
         log("  [FAIL] the composite does not match the master's geometry");
         return;
      }

      var mask = channelToArray(maskImage, 0);
      var n = mask.length;

      section("1. Outside the mask, the composite must equal the master");

      var maxOutside = 0;
      var outsideCount = 0;
      var changedOutside = 0;
      var maxInside = 0;
      var minInside = 0;
      var insideCount = 0;
      var darkenedInside = 0;
      var addedTotal = 0;
      var brightestValue = -1;
      var brightestIndex = -1;

      // Per channel, not just totalled.
      //
      // The first version of this check summed the added light across all
      // three channels. That passed on a composite where R had received
      // everything and G and B exactly nothing: R's contribution alone made
      // the total positive. A check that aggregates the very axis a bug lives
      // on cannot see the bug.
      var addedPerChannel = [];
      var peakPerChannel = [];

      for (var ch = 0; ch < master.numberOfChannels; ++ch) {
         addedPerChannel.push(0);
         peakPerChannel.push(0);
         var m = channelToArray(master, ch);
         var c = channelToArray(comp, ch);

         for (var i = 0; i < n; ++i) {
            var diff = c[i] - m[i];
            if (mask[i] <= 0) {
               if (ch === 0) {
                  ++outsideCount;
               }
               var a = diff < 0 ? -diff : diff;
               if (a > maxOutside) {
                  maxOutside = a;
               }
               if (a > 1e-7) {
                  ++changedOutside;
               }
            } else {
               if (ch === 0) {
                  ++insideCount;
               }
               addedTotal += diff;
               addedPerChannel[ch] += diff;
               if (diff > peakPerChannel[ch]) {
                  peakPerChannel[ch] = diff;
               }
               if (diff > maxInside) {
                  maxInside = diff;
               }
               if (diff < minInside) {
                  minInside = diff;
               }
               if (diff < -1e-6) {
                  ++darkenedInside;
               }
               if (diff > brightestValue) {
                  brightestValue = diff;
                  brightestIndex = i;
               }
            }
         }
      }

      log("  samples outside the mask: " + outsideCount + " per channel");
      log("  largest difference:       " + maxOutside.toExponential(3));
      log("  samples changed by > 1e-7: " + changedOutside);
      if (changedOutside === 0) {
         log("  PASS - the master is reproduced exactly outside the mask.");
      } else {
         log("  FAIL - light arrived where the mask is zero.");
      }

      section("2. Inside the mask, light is added and never removed");
      log("  samples inside the mask:  " + insideCount + " per channel");
      log("  largest addition:         " + maxInside.toFixed(6));
      log("  most negative change:     " + minInside.toFixed(6));
      log("  samples darkened by > 1e-6: " + darkenedInside
          + " of " + (insideCount * master.numberOfChannels));
      log("  mean change inside:       "
          + (addedTotal / (insideCount * master.numberOfChannels)).toExponential(3));
      // Some negative samples are expected and correct: the residual carries
      // the sub's noise, which is symmetric, and clipping it would bias the
      // sky upward. What matters is that the mean is positive - light was
      // added overall - not that every single sample rose.
      if (addedTotal > 0) {
         log("  PASS - the net effect inside the mask is added light.");
      } else {
         log("  FAIL - the mask region did not gain light overall.");
      }

      log("");
      log("  Per channel, which is what a totalled check cannot show:");
      var names = ["R", "G", "B"];
      var emptyChannels = 0;
      for (var pc = 0; pc < addedPerChannel.length; ++pc) {
         var label = pc < names.length ? names[pc] : ("ch" + pc);
         var mean = addedPerChannel[pc] / insideCount;
         log("    " + label + "  mean added " + mean.toExponential(3)
             + "   peak added " + peakPerChannel[pc].toFixed(6));
         if (peakPerChannel[pc] <= 0) {
            ++emptyChannels;
         }
      }
      if (emptyChannels === 0) {
         log("  PASS - every channel received light.");
      } else {
         log("  FAIL - " + emptyChannels + " channel(s) received nothing at all.");
         log("  A channel that gained exactly zero is a write-back that did");
         log("  not happen, not a faint meteor.");
      }

      section("3. Where is the brightest addition?");
      var bx = brightestIndex % master.width;
      var by = Math.floor(brightestIndex / master.width);
      log("  brightest addition " + brightestValue.toFixed(6)
          + " at (" + bx + ", " + by + ")");
      log("  mask value there:  " + mask[brightestIndex].toFixed(3));
      if (mask[brightestIndex] > 0.9) {
         log("  PASS - it sits in the solid core of a mask, which is where a");
         log("  trail should be. A bright addition in the feather would mean");
         log("  the mask is offset from the trail.");
      } else {
         log("  SUSPECT - the brightest addition is not in a solid core.");
      }

      // --- The rejected frame ---------------------------------------------

      section("4. The frame the plausibility guard rejected");
      log("  " + REJECTED_FRAME);
      log("  reported fit scale was 0.081, outside the 0.2 to 5.0 range.");

      var subWin = null;
      try {
         subWin = ImageWindow.open(REGISTERED_DIR + "/" + REJECTED_FRAME)[0];
      } catch (e) {
         log("  could not open it: " + e);
      }
      if (subWin) {
         try {
            var sub = subWin.mainView.image;
            log("  size: " + sub.width + "x" + sub.height);
            for (var ch2 = 0; ch2 < Math.min(3, sub.numberOfChannels); ++ch2) {
               sub.selectedChannel = ch2;
               master.selectedChannel = ch2;
               log("  channel " + ch2
                   + "   sub median "    + sub.median().toExponential(3)
                   + "   MAD " + sub.MAD().toExponential(3)
                   + "   |   master median " + master.median().toExponential(3)
                   + "   MAD " + master.MAD().toExponential(3));
            }
            log("");
            log("  A fit scale near zero means the sub's structure does not");
            log("  track the master's. Compare the medians and MADs above: if");
            log("  the sub is simply much fainter the scale would be small but");
            log("  the correlation intact, whereas a sub that is bright and");
            log("  structureless - cloud, twilight, dew - gives a slope near");
            log("  zero regardless of level. Whichever it is, compositing it");
            log("  against this master would not have produced a correct");
            log("  result, which is what the guard is for.");
         } finally {
            subWin.forceClose();
         }
      }
   } finally {
      masterWin.forceClose();
      compWin.forceClose();
      maskWin.forceClose();
   }

   section("Done");
   log("finished: " + (new Date()).toISOString());
   flushLog();
}

main();

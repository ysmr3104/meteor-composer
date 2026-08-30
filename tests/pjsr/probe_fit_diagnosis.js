#engine v8

//============================================================================
// probe_fit_diagnosis.js - Does the message match what the data is doing?
//
// Two real failures need one message to tell them apart.
//
//   A forum user got "is this the right master?" on EVERY frame. The cause was
//   a master that had not been debayered while the frames had.
//
//   This night got it on ONE frame, DSC04908, at fit scale 0.097. The master
//   was right: 30 other frames of the same night composited at scale 1.0 to
//   1.29.
//
// A first attempt said "the frame is 10.3 times dimmer than the master". That
// is measurably false - probe_frame_levels measured DSC04908's median at 0.974
// of the master's - and it would have sent the operator looking at exposures.
// The slope is not a brightness ratio; it is how much of the master's detail
// the frame carries.
//
// So the diagnosis needs both numbers, and this checks the shipped code
// against real frames: fitOnGrid and fitIsPlausible as the composite calls
// them, on frames whose right answer is already known from the composite's own
// log.
//
//   DSC04904, DSC04908  refused by the composite
//   DSC04944, DSC04972  accepted, scale near 1.0
//   DSC05542            accepted, the last frame of the night
//
// And one suspicion to settle at the same time. A registered frame carries a
// wedge of NO DATA where the rotation moved it off the reference, and the
// master - an integration of the whole night - has data there. Those pixels
// enter the fit as (master = sky, sub = 0), which drags the slope towards
// zero. The frames the composite refused are the FIRST of the night, which is
// where that wedge is largest. If excluding them restores the slope, the
// rejection was never about the master at all, and the message is not the
// only thing that needs fixing.
//
// Run:
//   tools/run-remote.sh --pjsr tests/pjsr/probe_fit_diagnosis.js
//============================================================================

#include "../../javascript/trail_mask.js"
#include "../../javascript/composition.js"

var DATA_ROOT = "/Volumes/Extreme SSD/pi_works/meteor-composer-test/test-sky";
var GROUP = "Light_BIN-1_6024x4024_EXPOSURE-13.00s_FILTER-NoFilter_RGB";
var REGISTERED_DIR = DATA_ROOT + "/registered/" + GROUP;
var MASTER_PATH = DATA_ROOT
   + "/master/masterLight_BIN-1_6024x4024_EXPOSURE-13.00s_FILTER-NoFilter_RGB.xisf";
var LOG_PATH = DATA_ROOT + "/probe_fit_diagnosis.log";

var WANTED = ["DSC04904", "DSC04908", "DSC04944", "DSC04972", "DSC05542"];

var _log = [];

function say(text) {
   _log.push(text);
   File.writeTextFile(LOG_PATH, _log.join("\n") + "\n");
   console.writeln(text);
}

function channelToArray(image, channel) {
   image.selectedChannel = channel;
   return image.toMatrix().toArray();
}

function main() {
   say("probe_fit_diagnosis");
   say("master: " + MASTER_PATH);
   say("");

   var masterWindow = ImageWindow.open(MASTER_PATH)[0];
   if (!masterWindow) {
      say("FAILED: could not open the master");
      return;
   }
   var W, H, channels, masterChannels;
   try {
      var masterImage = masterWindow.mainView.image;
      W = masterImage.width;
      H = masterImage.height;
      channels = masterImage.numberOfChannels;
      say("master: " + W + "x" + H + ", " + channels + " channels"
          + ", cfaType='" + masterWindow.cfaType + "'");
      masterChannels = [];
      for (var ch = 0; ch < channels; ++ch) {
         masterChannels.push(channelToArray(masterImage, ch));
      }
   } finally {
      masterWindow.forceClose();
   }
   say("");

   // No corridor: the fit skips masked pixels, and with no trails supplied
   // every pixel takes part. The composite excludes a few thousand pixels
   // around each trail out of 24 million, which does not move the fit.
   var noMask = new Float32Array(W * H);

   var all = [];
   var find = new FileFind;
   if (find.begin(REGISTERED_DIR + "/*.xisf")) {
      do {
         if (!find.isDirectory) {
            all.push(find.name);
         }
      } while (find.next());
   }
   all.sort();

   for (var w = 0; w < WANTED.length; ++w) {
      var name = null;
      for (var a = 0; a < all.length; ++a) {
         if (all[a].indexOf(WANTED[w]) >= 0) {
            name = all[a];
            break;
         }
      }
      if (name === null) {
         say(WANTED[w] + ": not found");
         continue;
      }

      var subWindow = ImageWindow.open(REGISTERED_DIR + "/" + name)[0];
      if (!subWindow) {
         say(name + ": could not open");
         continue;
      }
      try {
         var subImage = subWindow.mainView.image;
         say(WANTED[w] + "  (" + subImage.numberOfChannels + " channels"
             + ", cfaType='" + subWindow.cfaType + "')");
         for (var c = 0; c < Math.min(channels, subImage.numberOfChannels); ++c) {
            var sub = channelToArray(subImage, c);
            var fit = fitOnGrid(masterChannels[c], sub, noMask, W, H, null);
            var check = fitIsPlausible(fit, null);
            say("  ch" + c
                + "  scale=" + fit.scale.toFixed(4)
                + "  level=" + fit.levelRatio.toFixed(4)
                + "  agree=" + (levelExplainsScale(fit.scale, fit.levelRatio)
                                ? "yes" : "no")
                + "  ->  " + (check.ok ? "accepted" : check.code));
            if (!check.ok) {
               say("        " + check.reason);
            }

            // The same fit with the no-data pixels excluded, and a count of
            // how many there were. A mask marks them, so this is the fit the
            // composite would compute if it treated no data as no data.
            var noData = new Float32Array(W * H);
            var zeros = 0, zerosInSub = 0, zerosInMaster = 0;
            for (var i = 0; i < noData.length; ++i) {
               var mz = !(masterChannels[c][i] > 0);
               var sz = !(sub[i] > 0);
               if (mz) { ++zerosInMaster; }
               if (sz) { ++zerosInSub; }
               if (mz || sz) {
                  noData[i] = 1;
                  ++zeros;
               }
            }
            var trimmed = fitOnGrid(masterChannels[c], sub, noData, W, H, null);
            say("        no data: " + (100 * zeros / noData.length).toFixed(2)
                + "% (master " + (100 * zerosInMaster / noData.length).toFixed(2)
                + "%, frame " + (100 * zerosInSub / noData.length).toFixed(2)
                + "%)");
            say("        excluding it: scale=" + trimmed.scale.toFixed(4)
                + "  level=" + trimmed.levelRatio.toFixed(4)
                + "  n=" + trimmed.samples
                + "  ->  " + (fitIsPlausible(trimmed, null).ok
                              ? "accepted" : "still refused"));
         }
      } finally {
         subWindow.forceClose();
      }
      say("");
   }

   say("done");
}

main();

#engine v8

//============================================================================
// verify_mismatch_fixtures.js - Do the broken masters break in the way meant?
//
// make_mismatched_master.js builds three masters, one per rejection message.
// Handing them over untested would mean handing over three guesses: a master
// built to test "level" could land in "structure" instead, and whoever runs it
// would conclude the message was wrong when the fixture was.
//
// So each is fitted against one real frame with the shipped code, and the code
// it produces is compared with the code it was built for.
//
// Run:
//   tools/run-remote.sh --pjsr tests/pjsr/verify_mismatch_fixtures.js
//============================================================================

#include "../../javascript/trail_mask.js"
#include "../../javascript/composition.js"

var DATA_ROOT = "/Volumes/Extreme SSD/pi_works/meteor-composer-test";
var GROUP = "Light_BIN-1_6024x4024_EXPOSURE-13.00s_FILTER-NoFilter_RGB";
var REGISTERED_DIR = DATA_ROOT + "/registered/" + GROUP;
var BROKEN_DIR = DATA_ROOT + "/master_broken";
var LOG_PATH = DATA_ROOT + "/verify_mismatch_fixtures.log";

// A frame with almost no missing data, so that the nodata branch cannot fire
// and mask whatever is being tested. DSC04972 measured 0.39%.
var FRAME = "DSC04972";

var CASES = [
   { path: DATA_ROOT + "/master/masterLight_BIN-1_6024x4024_"
                     + "EXPOSURE-13.00s_FILTER-NoFilter_RGB.xisf",
     name: "the real master", expect: "accepted" },
   { path: BROKEN_DIR + "/master_dim10.xisf",
     name: "master_dim10",  expect: "level" },
   { path: BROKEN_DIR + "/master_noisy.xisf",
     name: "master_noisy",  expect: "structure" },
   { path: BROKEN_DIR + "/master_mono.xisf",
     name: "master_mono",   expect: "channel count" }
];

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
   say("verify_mismatch_fixtures");
   say("frame: " + FRAME);
   say("");

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

   var frameName = null;
   for (var a = 0; a < all.length; ++a) {
      if (all[a].indexOf(FRAME) >= 0) {
         frameName = all[a];
         break;
      }
   }
   if (frameName === null) {
      say("FAILED: " + FRAME + " not found");
      return;
   }

   var subWindow = ImageWindow.open(REGISTERED_DIR + "/" + frameName)[0];
   if (!subWindow) {
      say("FAILED: could not open " + frameName);
      return;
   }
   var W, H, subChannels;
   try {
      var subImage = subWindow.mainView.image;
      W = subImage.width;
      H = subImage.height;
      subChannels = [];
      for (var sc = 0; sc < subImage.numberOfChannels; ++sc) {
         subChannels.push(channelToArray(subImage, sc));
      }
      say("frame: " + W + "x" + H + ", " + subChannels.length + " channels");
   } finally {
      subWindow.forceClose();
   }
   say("");

   var noMask = new Float32Array(W * H);
   var wrong = 0;

   for (var k = 0; k < CASES.length; ++k) {
      var c = CASES[k];
      say(c.name + "  (expecting " + c.expect + ")");
      if (!File.exists(c.path)) {
         say("  MISSING: " + c.path);
         ++wrong;
         continue;
      }

      var win = ImageWindow.open(c.path)[0];
      if (!win) {
         say("  could not open it");
         ++wrong;
         continue;
      }
      try {
         var image = win.mainView.image;
         if (image.width !== W || image.height !== H) {
            say("  size " + image.width + "x" + image.height
                + " does not match the frame - the size check would fire first");
            ++wrong;
            continue;
         }

         // The channel-count case is settled before any fit, which is the
         // whole point of it: debayering does not change the dimensions, so
         // nothing else catches it.
         if (image.numberOfChannels !== subChannels.length) {
            var got = "channel count";
            say("  " + image.numberOfChannels + " channels against the frame's "
                + subChannels.length + "  ->  " + got);
            if (got !== c.expect) {
               say("  WRONG: expected " + c.expect);
               ++wrong;
            }
            continue;
         }

         var codes = [];
         for (var ch = 0; ch < subChannels.length; ++ch) {
            var master = channelToArray(image, ch);
            var fit = fitOnGrid(master, subChannels[ch], noMask, W, H, null);
            var check = fitIsPlausible(fit, null);
            var code = check.ok ? "accepted" : check.code;
            codes.push(code);
            say("  ch" + ch + "  scale=" + fit.scale.toFixed(4)
                + "  level=" + fit.levelRatio.toFixed(4)
                + "  nodata=" + (100 * fit.noDataFraction).toFixed(2) + "%"
                + "  ->  " + code);
            if (!check.ok) {
               say("        " + check.reason);
            }
         }

         // Channel 0 is the one the composite sees first, so it decides.
         if (codes[0] !== c.expect) {
            say("  WRONG: expected " + c.expect + ", got " + codes[0]);
            ++wrong;
         }
      } finally {
         win.forceClose();
      }
      say("");
   }

   say(wrong === 0 ? "all fixtures behave as intended"
                   : wrong + " fixture(s) do not");
}

main();

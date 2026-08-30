#engine v8

//============================================================================
// probe_frame_levels.js - Are the rejected frames dim, or is the master wrong?
//
// The one frame the composite refused (DSC04908, fit scale 0.097) was reported
// to the operator as "is this the right master?". The master was right: it
// composited 30 other frames of the same night at scale 1.0 to 1.29. So either
// that frame is genuinely dim, or the fit is measuring something else.
//
// Levels settle it. If DSC04908's median is a fraction of the master's while
// DSC04972's matches it, the frame is dim and the message blamed the wrong
// thing. Sampled across the night so that "the early frames" is a claim with
// numbers behind it rather than an impression from three files.
//
// Run:
//   tools/run-remote.sh --pjsr tests/pjsr/probe_frame_levels.js
//============================================================================

var DATA_ROOT = "/Volumes/Extreme SSD/pi_works/meteor-composer-test/test-sky";
var GROUP = "Light_BIN-1_6024x4024_EXPOSURE-13.00s_FILTER-NoFilter_RGB";
var REGISTERED_DIR = DATA_ROOT + "/registered/" + GROUP;
var MASTER_PATH = DATA_ROOT
   + "/master/masterLight_BIN-1_6024x4024_EXPOSURE-13.00s_FILTER-NoFilter_RGB.xisf";
var LOG_PATH = DATA_ROOT + "/probe_frame_levels.log";

// Every nth frame of the night, plus the frames the composite named.
var SAMPLE_EVERY = 40;
var NAMED = ["DSC04904", "DSC04908", "DSC04972", "DSC05542"];

var _log = [];

function say(text) {
   _log.push(text);
   File.writeTextFile(LOG_PATH, _log.join("\n") + "\n");
   console.writeln(text);
}

// Median and MAD per channel, from PixInsight's own statistics rather than a
// hand-rolled pass: they are cached on the view and they are the numbers the
// rest of the script already reasons about.
function levels(view) {
   var out = [];
   var image = view.image;
   for (var ch = 0; ch < image.numberOfChannels; ++ch) {
      image.selectedChannel = ch;
      out.push({ median: image.median(), mad: image.MAD() });
   }
   return out;
}

function report(label, view) {
   var l = levels(view);
   var parts = [];
   for (var i = 0; i < l.length; ++i) {
      parts.push("ch" + i + " median=" + l[i].median.toExponential(4)
                 + " MAD=" + l[i].mad.toExponential(3));
   }
   say("  " + label + "  " + parts.join("  "));
   return l;
}

function main() {
   say("probe_frame_levels");
   say("");

   var masterWindow = ImageWindow.open(MASTER_PATH)[0];
   if (!masterWindow) {
      say("FAILED: could not open the master");
      return;
   }
   var masterLevels;
   try {
      say("master:");
      masterLevels = report("masterLight", masterWindow.mainView);
   } finally {
      masterWindow.forceClose();
   }
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
   say("frames in the directory: " + all.length);

   // Which ones to open: a regular sample plus the named ones, in file order.
   var wanted = {};
   for (var i = 0; i < all.length; i += SAMPLE_EVERY) {
      wanted[all[i]] = true;
   }
   for (var k = 0; k < all.length; ++k) {
      for (var m = 0; m < NAMED.length; ++m) {
         if (all[k].indexOf(NAMED[m]) >= 0) {
            wanted[all[k]] = true;
         }
      }
   }

   var names = [];
   for (var j = 0; j < all.length; ++j) {
      if (wanted[all[j]] === true) {
         names.push(all[j]);
      }
   }
   say("measuring: " + names.length);
   say("");

   for (var f = 0; f < names.length; ++f) {
      var win = ImageWindow.open(REGISTERED_DIR + "/" + names[f])[0];
      if (!win) {
         say("  " + names[f] + ": could not open");
         continue;
      }
      try {
         var l = report(names[f], win.mainView);
         // The ratio is the number the fit is reporting as its scale, near
         // enough: both are "how much of the master is in this frame".
         var ratios = [];
         for (var c = 0; c < Math.min(l.length, masterLevels.length); ++c) {
            ratios.push((l[c].median / masterLevels[c].median).toFixed(4));
         }
         say("      median ratio to master: " + ratios.join(" / "));
      } finally {
         win.forceClose();
      }
   }

   say("");
   say("done");
}

main();

#engine v8

//============================================================================
// probe_registered_vs_not.js - The same frame, detected both ways
//
// A fixed-tripod night measured badly through registration:
//
//   1045 frames in, 718 registered. The 327 failures are not scattered - the
//   first 400 frames of the night solved at a rate of zero, and nothing after
//   DSC_1370 failed. That is distance from the reference frame.
//
//   The frames that did survive are hollow: 4.3% to 66.2% of each one holds no
//   data, mean 36.5%. The tracked night measured 0.24% to 0.42%.
//
//   Half the candidates (1222 of 2466) have edgeContact >= 0.3. On the tracked
//   night that was 3 candidates out of 376.
//
// The obvious suspicion is that the empty area is manufacturing candidates
// along its own border. But "obvious" is how this project has been wrong
// before, so it gets measured, and measured PAIRED: the same frame, the same
// moment, the same sky, detected once as registered and once as the
// unregistered debayered file it came from. The only difference is
// registration.
//
// A second sample covers frames that failed registration altogether. They
// exist only unregistered, and they are a third of the night. If they produce
// ordinary candidate counts, that third is recoverable.
//
// Detection is per-frame arithmetic, so nothing here should need registration.
// What does need it is composition, and cross-frame track matching.
//
// Run:
//   tools/run-remote.sh --pjsr tests/pjsr/probe_registered_vs_not.js
//============================================================================

#include "../../javascript/detection_core.js"

var DATA_ROOT = "/Volumes/Extreme SSD/pi_works/mave";
var REGISTERED_DIR = DATA_ROOT
   + "/registered/Light_BIN-1_6064x4040_EXPOSURE-13.00s_FILTER-NoFilter_RGB";
var DEBAYERED_DIR = DATA_ROOT
   + "/debayered/Light_BIN-1_6064x4040_EXPOSURE-13.00s_FILTER-NoFilter_CFA";
var LOG_PATH = DATA_ROOT + "/probe_registered_vs_not.log";

var SCREEN_FACTOR = 8;

// The parameters the existing run used, so the counts are comparable with the
// 2466 already on disk.
var OPTIONS = {
   backgroundFactor: 8,
   k: 5.0,
   connectivity: 8,
   minPixels: 12,
   minElongation: 6.0,
   minLength: 10.0
};

var PAIRED_SAMPLE = 30;      // frames present in both forms
var UNPAIRED_SAMPLE = 15;    // frames that failed registration

var _log = [];

function say(text) {
   _log.push(text);
   File.writeTextFile(LOG_PATH, _log.join("\n") + "\n");
   console.writeln(text);
}

function listFiles(dir) {
   var out = [];
   var find = new FileFind;
   if (find.begin(dir + "/*.xisf")) {
      do {
         if (!find.isDirectory && find.name.charAt(0) !== ".") {
            out.push(find.name);
         }
      } while (find.next());
   }
   out.sort();
   return out;
}

// DSC_1234_d_r.xisf and DSC_1234_d.xisf both key on 1234.
function frameNumber(name) {
   var m = name.match(/DSC_(\d+)/);
   return m === null ? null : m[1];
}

// Detect on one file and report what came out, plus how much of the frame was
// empty. Empty is measured on the reduced field, which is what detection
// actually sees.
function detectOne(path) {
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

      var empty = 0;
      for (var i = 0; i < field.data.length; ++i) {
         if (!(field.data[i] > 0)) {
            ++empty;
         }
      }

      var result = detectCandidates(field, OPTIONS, null);
      var edgy = 0, longOnes = 0;
      for (var c = 0; c < result.candidates.length; ++c) {
         var cand = result.candidates[c];
         if (cand.edgeContact >= 0.3) {
            ++edgy;
         }
         if (cand.length >= 200) {
            ++longOnes;
         }
      }
      return { count: result.candidates.length,
               edgy: edgy,
               longOnes: longOnes,
               emptyFraction: empty / field.data.length };
   } finally {
      win.forceClose();
   }
}

function main() {
   say("probe_registered_vs_not");
   say("options: k=" + OPTIONS.k + " minPixels=" + OPTIONS.minPixels
       + " minElongation=" + OPTIONS.minElongation
       + " minLength=" + OPTIONS.minLength);
   say("");

   var reg = listFiles(REGISTERED_DIR);
   var deb = listFiles(DEBAYERED_DIR);
   say("registered: " + reg.length + "   debayered: " + deb.length);

   var debByNumber = {};
   for (var d = 0; d < deb.length; ++d) {
      var dn = frameNumber(deb[d]);
      if (dn !== null) {
         debByNumber[dn] = deb[d];
      }
   }
   var regNumbers = {};
   for (var g = 0; g < reg.length; ++g) {
      var gn = frameNumber(reg[g]);
      if (gn !== null) {
         regNumbers[gn] = true;
      }
   }

   // --- paired ---------------------------------------------------------------
   say("");
   say("=== the same frame, both ways ===");
   say("frame      registered                        unregistered");
   say("           cands  edge>=.3  len>=200  empty%  cands  edge>=.3  len>=200  empty%");

   var step = Math.max(1, Math.floor(reg.length / PAIRED_SAMPLE));
   var sumRegCands = 0, sumDebCands = 0, sumRegEdgy = 0, sumDebEdgy = 0, pairs = 0;

   for (var i = 0; i < reg.length; i += step) {
      var num = frameNumber(reg[i]);
      if (num === null || debByNumber[num] === undefined) {
         continue;
      }
      var a = detectOne(REGISTERED_DIR + "/" + reg[i]);
      var b = detectOne(DEBAYERED_DIR + "/" + debByNumber[num]);
      if (a === null || b === null) {
         say("  " + num + ": could not open one of the pair");
         continue;
      }
      ++pairs;
      sumRegCands += a.count; sumDebCands += b.count;
      sumRegEdgy += a.edgy;   sumDebEdgy += b.edgy;
      say("  " + num
          + "     " + a.count + "\t" + a.edgy + "\t" + a.longOnes + "\t"
          + (100 * a.emptyFraction).toFixed(1) + "%"
          + "\t" + b.count + "\t" + b.edgy + "\t" + b.longOnes + "\t"
          + (100 * b.emptyFraction).toFixed(1) + "%");
   }

   say("");
   say("  pairs: " + pairs);
   say("  candidates per frame:  registered " + (sumRegCands / Math.max(1, pairs)).toFixed(2)
       + "   unregistered " + (sumDebCands / Math.max(1, pairs)).toFixed(2));
   say("  edgeContact>=0.3 per frame:  registered " + (sumRegEdgy / Math.max(1, pairs)).toFixed(2)
       + "   unregistered " + (sumDebEdgy / Math.max(1, pairs)).toFixed(2));

   // --- the third of the night registration threw away -----------------------
   say("");
   say("=== frames that failed registration (unregistered only) ===");
   var failed = [];
   for (var k = 0; k < deb.length; ++k) {
      var kn = frameNumber(deb[k]);
      if (kn !== null && regNumbers[kn] !== true) {
         failed.push(deb[k]);
      }
    }
   say("  frames registration could not solve: " + failed.length);
   var fstep = Math.max(1, Math.floor(failed.length / UNPAIRED_SAMPLE));
   var sumFailed = 0, sumFailedEdgy = 0, nFailed = 0;
   for (var f = 0; f < failed.length; f += fstep) {
      var r = detectOne(DEBAYERED_DIR + "/" + failed[f]);
      if (r === null) {
         continue;
      }
      ++nFailed;
      sumFailed += r.count;
      sumFailedEdgy += r.edgy;
      say("  " + frameNumber(failed[f]) + "     " + r.count + "\t" + r.edgy
          + "\t" + r.longOnes + "\t" + (100 * r.emptyFraction).toFixed(1) + "%");
   }
   say("");
   say("  candidates per frame: " + (sumFailed / Math.max(1, nFailed)).toFixed(2)
       + "   edgeContact>=0.3: " + (sumFailedEdgy / Math.max(1, nFailed)).toFixed(2));

   say("");
   say("done");
}

main();

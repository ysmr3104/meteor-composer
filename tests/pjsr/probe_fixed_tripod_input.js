#engine v8

//============================================================================
// probe_fixed_tripod_input.js - Is "registered frames" the right input?
//
// The script takes registered frames. On a tracked night that costs nothing:
// the frames barely move, WBPP is run anyway to build the master, and the
// empty area registration leaves behind measured 0.24% to 0.42% of the frame.
//
// A fixed-tripod night is a different proposition. On the one now in hand -
// Nikon, 13 s, 1045 frames over about 3.8 hours - StarAlignment solved 718 and
// failed on 327 with "Unable to find an initial linear transformation", and
// the failures are not scattered: the first 400 frames of the night solved at
// a rate of zero. Nothing after DSC_1370 failed at all. That is distance from
// the reference frame, not bad luck.
//
// So before tuning anything, two questions have to be answered with numbers:
//
//   1. How much of each surviving frame is empty, and how does that grow with
//      distance from the reference? Half the candidates on this data have
//      edgeContact >= 0.3, against 3 candidates out of 376 on the tracked
//      night, and the empty area is where those come from.
//
//   2. Are the debayered, UNREGISTERED frames usable as detection input? They
//      are the full sensor every time, with no empty area at all, and there
//      are 1045 of them rather than 718. Detection is per-frame arithmetic, so
//      registration is not obviously required for it - only composition and
//      cross-frame track matching need a common coordinate system.
//
// This measures both. It does not decide anything.
//
// Run:
//   tools/run-remote.sh --pjsr tests/pjsr/probe_fixed_tripod_input.js
//============================================================================

var DATA_ROOT = "/Volumes/Extreme SSD/pi_works/mave";
var REGISTERED_DIR = DATA_ROOT
   + "/registered/Light_BIN-1_6064x4040_EXPOSURE-13.00s_FILTER-NoFilter_RGB";
var DEBAYERED_DIR = DATA_ROOT
   + "/debayered/Light_BIN-1_6064x4040_EXPOSURE-13.00s_FILTER-NoFilter_CFA";
var LOG_PATH = DATA_ROOT + "/probe_fixed_tripod_input.log";

// Every nth surviving frame, so the trend across the night is visible rather
// than a single number that hides it.
var SAMPLE_EVERY = 80;

var _log = [];

function say(text) {
   _log.push(text);
   File.writeTextFile(LOG_PATH, _log.join("\n") + "\n");
   console.writeln(text);
}

// The fraction of a frame that holds no data.
//
// Exactly zero, not a threshold: WBPP writes hard zeros outside the registered
// area, and a calibrated sky sits far above that. Sampled on a grid, because
// this is a proportion and 24 million pixels are not needed to measure one.
function emptyFraction(image, stride) {
   var W = image.width, H = image.height;
   var visited = 0, empty = 0;
   image.selectedChannel = 0;
   var data = image.toMatrix().toArray();
   for (var y = 0; y < H; y += stride) {
      var row = y * W;
      for (var x = 0; x < W; x += stride) {
         ++visited;
         if (!(data[row + x] > 0)) {
            ++empty;
         }
      }
   }
   return visited > 0 ? empty / visited : 0;
}

function listFiles(dir, suffix) {
   var out = [];
   var find = new FileFind;
   if (find.begin(dir + "/*" + suffix)) {
      do {
         if (!find.isDirectory && find.name.charAt(0) !== ".") {
            out.push(find.name);
         }
      } while (find.next());
   }
   out.sort();
   return out;
}

function main() {
   say("probe_fixed_tripod_input");
   say("");

   // --- 1. The empty area on the frames that did register -------------------
   var reg = listFiles(REGISTERED_DIR, ".xisf");
   say("registered frames: " + reg.length);
   say("");
   say("frame                     empty%   size          channels");

   var worst = 0, best = 1, total = 0, measured = 0;
   for (var i = 0; i < reg.length; i += SAMPLE_EVERY) {
      var win = ImageWindow.open(REGISTERED_DIR + "/" + reg[i])[0];
      if (!win) {
         say("  " + reg[i] + ": could not open");
         continue;
      }
      try {
         var image = win.mainView.image;
         var f = emptyFraction(image, 13);
         worst = Math.max(worst, f);
         best = Math.min(best, f);
         total += f;
         ++measured;
         say("  " + reg[i].substring(0, 20)
             + "  " + (100 * f).toFixed(2) + "%"
             + "   " + image.width + "x" + image.height
             + "   " + image.numberOfChannels);
      } finally {
         win.forceClose();
      }
   }
   say("");
   say("  empty area: best " + (100 * best).toFixed(2)
       + "%, worst " + (100 * worst).toFixed(2)
       + "%, mean " + (100 * total / Math.max(1, measured)).toFixed(2) + "%");
   say("  for comparison, the tracked night measured 0.24% to 0.42%");
   say("");

   // --- 2. What the unregistered frames actually are ------------------------
   var deb = listFiles(DEBAYERED_DIR, ".xisf");
   say("debayered (unregistered) frames: " + deb.length);
   say("");
   say("frame                     empty%   size          channels  cfaType");

   for (var k = 0; k < deb.length; k += Math.floor(deb.length / 4) || 1) {
      var w2 = ImageWindow.open(DEBAYERED_DIR + "/" + deb[k])[0];
      if (!w2) {
         say("  " + deb[k] + ": could not open");
         continue;
      }
      try {
         var im2 = w2.mainView.image;
         say("  " + deb[k].substring(0, 20)
             + "  " + (100 * emptyFraction(im2, 13)).toFixed(2) + "%"
             + "   " + im2.width + "x" + im2.height
             + "   " + im2.numberOfChannels
             + "        '" + w2.cfaType + "'");
      } finally {
         w2.forceClose();
      }
   }

   say("");
   say("done");
}

main();

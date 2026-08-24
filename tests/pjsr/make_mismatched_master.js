#engine v8

//============================================================================
// make_mismatched_master.js - Masters that are deliberately wrong
//
// The three new rejection messages cannot be exercised on this night's data
// any more: every accepted frame now fits. The one frame that used to be
// refused, DSC04908, is not in the saved session at all - a later screening
// pass replaced it - so there is nothing left to trigger them.
//
// Rather than hunt for data that fails, this builds masters that fail in a
// known way, one per message. Each keeps the pixel dimensions of the real
// master so that the size check cannot fire first and hide the case under
// test.
//
//   master_dim10.xisf    the master times 10, so the frames read as a tenth
//                        of it. Slope and sky level agree, because they do:
//                        this is a real level difference          -> "level"
//
//   master_noisy.xisf    the master times (1 + u), u uniform in [-0.9, 0.9].
//                        The sky level is unchanged and the structure is
//                        buried, which is what an undebayered master does to
//                        a fit                                    -> "structure"
//
//   master_mono.xisf     one channel. What picking an undebayered file
//                        actually gives, and the case the size check cannot
//                        see: debayering does not change the dimensions
//                                              -> "not been debayered"
//
// Multiplicative noise on purpose. Additive noise large enough to bury the
// structure would push a large share of pixels below zero, and those count as
// no data - the run would report "38% of this frame has no data" and test the
// wrong branch.
//
// Deterministic: docs/tests.md rules out Math.random(), so a failure can be
// reproduced. The same seed gives the same master every time.
//
// About 680 MB for the three. They go in a subdirectory so they are easy to
// delete, and nothing else reads that directory.
//
// Run:
//   tools/run-remote.sh --pjsr tests/pjsr/make_mismatched_master.js
//============================================================================

var DATA_ROOT = "/Volumes/Extreme SSD/pi_works/meteor-composer-test";
var MASTER_PATH = DATA_ROOT
   + "/master/masterLight_BIN-1_6024x4024_EXPOSURE-13.00s_FILTER-NoFilter_RGB.xisf";
var OUT_DIR = DATA_ROOT + "/master_broken";
var LOG_PATH = DATA_ROOT + "/make_mismatched_master.log";

var DIM_FACTOR = 10;
var NOISE_AMPLITUDE = 0.9;
var SEED = 20260824;

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

function makeRandom(seed) {
   var state = seed >>> 0;
   return function () {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 4294967296;
   };
}

// Write a plain array into one channel.
//
// Copied from MeteorComposer.js rather than reinvented. The fourth argument of
// Image.apply() is the TARGET channel; firstChannel and lastChannel refer to
// the SOURCE, so passing the target there writes nothing for channels 1 and 2
// and throws nothing either. assign() is not an alternative: it replaces the
// whole image and leaves a one-channel result.
function arrayToChannel(image, channel, data) {
   var channelImage = (new Matrix(data, image.height, image.width)).toImage();
   image.apply(channelImage, ImageOp.Mov, new Point(0, 0), channel);
}

// One image out of a list of channel arrays, saved where it was asked for.
function write(path, channels, W, H, sample, isReal, isColor) {
   var win = new ImageWindow(W, H, channels.length, sample, isReal, isColor,
                             "BrokenMaster");
   win.mainView.beginProcess(UndoFlag.NoSwapFile);
   for (var ch = 0; ch < channels.length; ++ch) {
      arrayToChannel(win.mainView.image, ch, channels[ch]);
   }
   win.mainView.endProcess();
   win.saveAs(path, false, false, false, false);
   win.forceClose();
   say("  wrote " + path);
}

function main() {
   say("make_mismatched_master");
   say("source: " + MASTER_PATH);

   if (!File.directoryExists(OUT_DIR)) {
      File.createDirectory(OUT_DIR, true);
   }

   var win = ImageWindow.open(MASTER_PATH)[0];
   if (!win) {
      say("FAILED: could not open the master");
      return;
   }

   var W, H, channels, sample, isReal, isColor, source;
   try {
      var image = win.mainView.image;
      W = image.width;
      H = image.height;
      channels = image.numberOfChannels;
      sample = image.bitsPerSample;
      isReal = image.isReal;
      isColor = image.isColor;
      say("  " + W + "x" + H + ", " + channels + " channels, "
          + sample + " bits, isColor=" + isColor);
      source = [];
      for (var ch = 0; ch < channels; ++ch) {
         source.push(channelToArray(image, ch));
      }
   } finally {
      win.forceClose();
   }

   var n = W * H;
   var i, c;

   // 1. Ten times brighter. The frames then sit at a tenth of its level, and
   //    the slope agrees with that, because it is true.
   say("master_dim10 (x" + DIM_FACTOR + "):");
   var dim = [];
   for (c = 0; c < channels; ++c) {
      var d = new Float32Array(n);
      for (i = 0; i < n; ++i) {
         d[i] = source[c][i] * DIM_FACTOR;
      }
      dim.push(d);
   }
   write(OUT_DIR + "/master_dim10.xisf", dim, W, H, sample, isReal, isColor);
   dim = null;

   // 2. Same level, buried structure. Every pixel is scaled by its own factor
   //    in [0.1, 1.9], so the mean is preserved and the correlation with the
   //    frames is destroyed.
   say("master_noisy (x(1 +/- " + NOISE_AMPLITUDE + ")):");
   var noisy = [];
   for (c = 0; c < channels; ++c) {
      var rand = makeRandom(SEED + c);
      var y = new Float32Array(n);
      for (i = 0; i < n; ++i) {
         y[i] = source[c][i] * (1 + (2 * rand() - 1) * NOISE_AMPLITUDE);
      }
      noisy.push(y);
   }
   write(OUT_DIR + "/master_noisy.xisf", noisy, W, H, sample, isReal, isColor);
   noisy = null;

   // 3. One channel, which is what an undebayered file is. The mean of the
   //    three rather than a mosaic: the point of this one is the channel
   //    count, and a mosaic would additionally break the structure and make
   //    the test say two things at once.
   say("master_mono (1 channel):");
   var mono = new Float32Array(n);
   for (i = 0; i < n; ++i) {
      var sum = 0;
      for (c = 0; c < channels; ++c) {
         sum += source[c][i];
      }
      mono[i] = sum / channels;
   }
   write(OUT_DIR + "/master_mono.xisf", [mono], W, H, sample, isReal, false);

   say("");
   say("done");
}

main();

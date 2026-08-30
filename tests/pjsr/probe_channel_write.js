#engine v8

//============================================================================
// probe_channel_write.js - How do you write one channel of an Image?
//
// The composite came out with light in R only: G and B received exactly
// nothing. The write-back used
//
//   image.apply(oneChannelImage, ImageOp.Mov, new Point(0,0), 0,
//               new Rect(0,0,W,H), channel, channel)
//
// on the assumption that `channel` selects the source channel and
// firstChannel/lastChannel the target range. Something about that is wrong,
// and the reference documents signatures only:
//
//   Image.apply( Image src[, int op[, Point pos[, int channel[, Rect rect[,
//                int firstChannel[, int lastChannel]]]]]] )
//   Image.assign( Image src[, Rect rect[, int firstChannel[, int lastChannel]]] )
//
// Guessing again would be the same mistake twice, and the failure is silent -
// no exception, just a channel that never changed. So each candidate is tried
// on a tiny image whose channels start at known, distinct values, and what
// lands where is read back.
//
// Run:
//   tools/run-remote.sh --pjsr tests/pjsr/probe_channel_write.js
//============================================================================

var LOG_PATH = "/Volumes/Extreme SSD/pi_works/meteor-composer-test/test-sky/probe_channel_write.log";

var W = 4, H = 3;

var _log = [];
var _logPath = null;

function flushLog() {
   var text = _log.join("\n") + "\n";
   var candidates = _logPath !== null
      ? [_logPath] : [LOG_PATH, File.systemTempDirectory + "/probe_channel_write.log"];
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

// A 3-channel image whose channels are uniformly 0.1, 0.2 and 0.3, so any
// mix-up is obvious from a single sample.
function makeTestImage() {
   var img = new Image(W, H, 3, ColorSpace.RGB);
   for (var c = 0; c < 3; ++c) {
      img.selectedChannel = c;
      img.fill(0.1 * (c + 1));
   }
   img.resetChannelSelection();
   return img;
}

// A 1-channel image filled with `value`.
function makeChannelImage(value) {
   var data = new Float32Array(W * H);
   for (var i = 0; i < data.length; ++i) {
      data[i] = value;
   }
   return (new Matrix(data, H, W)).toImage();
}

function describe(img) {
   var parts = [];
   for (var c = 0; c < img.numberOfChannels; ++c) {
      parts.push(img.sample(0, 0, c).toFixed(3));
   }
   return "[" + parts.join(", ") + "]  " + img.numberOfChannels + "ch";
}

// Try a way of writing 0.9 into channel `target` and report the outcome.
function attempt(label, target, writer) {
   var img = makeTestImage();
   var before = describe(img);
   try {
      writer(img, target, makeChannelImage(0.9));
   } catch (e) {
      log("  [THREW] " + label + "  target=" + target + "  => " + e);
      return;
   }
   var after = describe(img);

   var expected = [0.1, 0.2, 0.3];
   expected[target] = 0.9;
   var correct = img.numberOfChannels === 3;
   if (correct) {
      for (var c = 0; c < 3; ++c) {
         if (Math.abs(img.sample(0, 0, c) - expected[c]) > 1e-5) {
            correct = false;
         }
      }
   }
   log("  " + (correct ? "[OK]  " : "[WRONG]")
       + " " + label + "  target=" + target
       + "  " + before + " -> " + after
       + (correct ? "" : "   expected [" + expected.join(", ") + "]"));
}

function main() {
   log("MeteorComposer channel-write probe");
   log("started: " + (new Date()).toISOString());
   log("");
   log("A 3-channel image starts as [0.1, 0.2, 0.3]. Each candidate writes");
   log("0.9 into one channel; the other two must keep their values and the");
   log("image must stay 3-channel.");

   section("The current, broken call");
   for (var t = 0; t < 3; ++t) {
      attempt("apply(src, Mov, Point, 0, Rect, t, t)", t, function (img, target, src) {
         img.apply(src, ImageOp.Mov, new Point(0, 0), 0,
                   new Rect(0, 0, W, H), target, target);
      });
   }

   section("channel argument as the TARGET instead");
   for (t = 0; t < 3; ++t) {
      attempt("apply(src, Mov, Point, t)", t, function (img, target, src) {
         img.apply(src, ImageOp.Mov, new Point(0, 0), target);
      });
   }

   section("selectedChannel plus apply");
   for (t = 0; t < 3; ++t) {
      attempt("selectedChannel = t; apply(src, Mov)", t, function (img, target, src) {
         img.selectedChannel = target;
         img.apply(src, ImageOp.Mov);
      });
   }

   section("selectedChannel plus assign with a channel range");
   for (t = 0; t < 3; ++t) {
      attempt("assign(src, Rect, t, t)", t, function (img, target, src) {
         img.assign(src, new Rect(0, 0, W, H), target, target);
      });
   }

   section("apply with the source channel named and no rect");
   for (t = 0; t < 3; ++t) {
      attempt("apply(src, Mov, Point, 0, Rect(0,0,W,H), t)", t, function (img, target, src) {
         img.apply(src, ImageOp.Mov, new Point(0, 0), 0, new Rect(0, 0, W, H), target);
      });
   }

   // If none of the per-channel writes behave, building the whole image from
   // one array is the fallback - but the layout of a multi-channel
   // TypedArray constructor is undocumented, so it is probed rather than
   // assumed. Planar means [all R][all G][all B]; interleaved means RGBRGB.
   section("new Image(TypedArray, w, h, 3, RGB): planar or interleaved?");
   try {
      var flat = new Float32Array(W * H * 3);
      var n = W * H;
      var i;
      for (i = 0; i < n; ++i) {
         flat[i] = 0.1;
         flat[n + i] = 0.2;
         flat[2 * n + i] = 0.3;
      }
      var planar = new Image(flat, W, H, 3, ColorSpace.RGB);
      log("  filled planar [0.1 x n][0.2 x n][0.3 x n] -> " + describe(planar));
      log("  If that reads [0.100, 0.200, 0.300] the layout is PLANAR, which");
      log("  is what a per-channel pipeline can build directly.");
   } catch (e2) {
      log("  [THREW] " + e2);
   }

   section("Done");
   log("finished: " + (new Date()).toISOString());
   flushLog();
}

main();

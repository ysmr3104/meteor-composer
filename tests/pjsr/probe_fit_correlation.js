#engine v8

//============================================================================
// probe_fit_correlation.js - What a fit looks like when the master is wrong
//
// A forum user reported "is this the right master?" on every frame of their
// night. The cause turned out to be a master that had not been debayered
// while the frames had. That is a case worth naming in the message rather
// than describing as a fit scale, but naming it requires knowing what it
// measures like - and a threshold picked by reasoning would be a guess.
//
// So this measures three things on real data:
//
//   1. The correlation of a legitimate pair. A single sub is far noisier than
//      a stacked master, so r for a GOOD pair is not 1 and the question is
//      how far below it sits. That number is the whole budget.
//   2. The correlation when the master is a CFA mosaic and the frame is
//      debayered. Synthesised from the master itself, so the only difference
//      between the two runs is the mosaic.
//   3. Whether ImageWindow.cfaType says anything useful. It exists in the
//      reference with no description, so it has to be read off real files.
//
// Run:
//   tools/run-remote.sh --pjsr tests/pjsr/probe_fit_correlation.js
//============================================================================

var DATA_ROOT = "/Volumes/Extreme SSD/pi_works/meteor-composer-test";
var GROUP = "Light_BIN-1_6024x4024_EXPOSURE-13.00s_FILTER-NoFilter_RGB";
var REGISTERED_DIR = DATA_ROOT + "/registered/" + GROUP;
var MASTER_PATH = DATA_ROOT
   + "/master/masterLight_BIN-1_6024x4024_EXPOSURE-13.00s_FILTER-NoFilter_RGB.xisf";
var LOG_PATH = DATA_ROOT + "/probe_fit_correlation.log";

// The stride the composite actually fits on.
var STRIDE = 7;

// How many frames to measure. Each is a ~290 MB read; three is enough to see
// whether the correlation of a good pair is stable.
var FRAMES = 3;

var _log = [];

function say(text) {
   _log.push(text);
   // Written after every line: an unsupported API throws, and a log flushed
   // only at the end would lose everything collected so far.
   File.writeTextFile(LOG_PATH, _log.join("\n") + "\n");
   console.writeln(text);
}

function channelToArray(image, channel) {
   image.selectedChannel = channel;
   return image.toMatrix().toArray();
}

// The fit the composite computes, plus the correlation coefficient.
//
// r = cov / (sd_x * sd_y). It is the part of the same sums the slope already
// needs, with sumYY added, so it costs one accumulation.
function fitWithCorrelation(master, sub, width, height, stride) {
   var n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
   for (var y = 0; y < height; y += stride) {
      var row = y * width;
      for (var x = 0; x < width; x += stride) {
         var a = master[row + x];
         var b = sub[row + x];
         if (!isFinite(a) || !isFinite(b)) {
            continue;
         }
         ++n; sx += a; sy += b; sxx += a * a; syy += b * b; sxy += a * b;
      }
   }
   if (n === 0) {
      return { scale: 1, offset: 0, r: 0, samples: 0 };
   }
   var mx = sx / n, my = sy / n;
   var vx = sxx / n - mx * mx;
   var vy = syy / n - my * my;
   var cv = sxy / n - mx * my;
   var scale = vx > 0 ? cv / vx : 1;
   var r = (vx > 0 && vy > 0) ? cv / Math.sqrt(vx * vy) : 0;
   return { scale: scale, offset: my - scale * mx, r: r, samples: n };
}

// Build a one-channel CFA mosaic from an RGB image, RGGB.
//
// This is the inverse of debayering, so it produces exactly what a master
// integrated from undebayered frames would be: the same sky, sampled one
// colour per pixel. Synthesising it rather than hunting for a real file keeps
// everything else identical between the two measurements.
function mosaicFromRGB(channels, width, height) {
   var out = new Float32Array(width * height);
   for (var y = 0; y < height; ++y) {
      var row = y * width;
      var evenRow = (y % 2) === 0;
      for (var x = 0; x < width; ++x) {
         var i = row + x;
         var evenCol = (x % 2) === 0;
         var ch = evenRow ? (evenCol ? 0 : 1) : (evenCol ? 1 : 2);
         out[i] = channels[ch][i];
      }
   }
   return out;
}

function listFrames(dir, limit) {
   var found = [];
   var find = new FileFind;
   if (find.begin(dir + "/*.xisf")) {
      do {
         if (!find.isDirectory) {
            found.push(find.name);
         }
      } while (find.next());
   }
   found.sort();
   return found.slice(0, limit);
}

function main() {
   say("probe_fit_correlation");
   say("master: " + MASTER_PATH);
   say("");

   var masterWindow = ImageWindow.open(MASTER_PATH)[0];
   if (!masterWindow) {
      say("FAILED: could not open the master");
      return;
   }

   var W, H, channels, masterChannels, mosaic;
   try {
      var masterImage = masterWindow.mainView.image;
      W = masterImage.width;
      H = masterImage.height;
      channels = masterImage.numberOfChannels;
      say("master: " + W + "x" + H + ", " + channels + " channels"
          + ", cfaType='" + masterWindow.cfaType + "'"
          + ", isColor=" + masterImage.isColor);

      masterChannels = [];
      for (var ch = 0; ch < channels; ++ch) {
         masterChannels.push(channelToArray(masterImage, ch));
      }
      mosaic = channels >= 3 ? mosaicFromRGB(masterChannels, W, H) : null;
   } finally {
      masterWindow.forceClose();
   }
   say("");

   var frames = listFrames(REGISTERED_DIR, FRAMES);
   say("frames: " + frames.length);
   say("");

   for (var k = 0; k < frames.length; ++k) {
      var path = REGISTERED_DIR + "/" + frames[k];
      var subWindow = ImageWindow.open(path)[0];
      if (!subWindow) {
         say(frames[k] + ": could not open");
         continue;
      }
      try {
         var subImage = subWindow.mainView.image;
         say(frames[k] + ": " + subImage.width + "x" + subImage.height
             + ", " + subImage.numberOfChannels + " channels"
             + ", cfaType='" + subWindow.cfaType + "'");
         if (subImage.width !== W || subImage.height !== H) {
            say("  size mismatch, skipped");
            continue;
         }

         for (var c = 0; c < Math.min(channels, subImage.numberOfChannels); ++c) {
            var sub = channelToArray(subImage, c);

            // 1. The legitimate pair: master channel c against sub channel c.
            var good = fitWithCorrelation(masterChannels[c], sub, W, H, STRIDE);
            say("  ch" + c + " master vs sub      scale=" + good.scale.toFixed(4)
                + "  r=" + good.r.toFixed(6)
                + "  n=" + good.samples);

            // 2. The reported failure: a CFA master against a debayered frame.
            if (mosaic !== null) {
               var bad = fitWithCorrelation(mosaic, sub, W, H, STRIDE);
               say("  ch" + c + " CFA mosaic vs sub  scale=" + bad.scale.toFixed(4)
                   + "  r=" + bad.r.toFixed(6)
                   + "  n=" + bad.samples);
            }
         }

         // 3. The stride matters. An even stride samples one Bayer position
         //    only, which makes a mosaic look like a clean mono image and
         //    hides the very mismatch this is trying to name.
         if (mosaic !== null) {
            var sub0 = channelToArray(subImage, 0);
            var even = fitWithCorrelation(mosaic, sub0, W, H, 8);
            say("  ch0 CFA mosaic vs sub, stride 8 (even)  scale="
                + even.scale.toFixed(4) + "  r=" + even.r.toFixed(6));
         }
      } finally {
         subWindow.forceClose();
      }
      say("");
   }

   say("done");
}

main();

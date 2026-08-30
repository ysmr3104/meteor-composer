#engine v8

//============================================================================
// probe_colour.js - Is colour usable to separate meteors from everything else?
//
// docs/requirements.md 6.1 lists colour as a discriminator - meteors white to
// blue-green, satellites white, aircraft with red/green navigation lights -
// but nothing has ever measured it on this data, and the detector throws
// colour away: it runs on getLuminance() output.
//
// The operator screening the 2026-08-12 session reported using colour as a
// cue (meteors often look green) and also reported two labelled meteors that
// broke the rule by appearing white - DSC05069/05070 and DSC05542 - with the
// hypothesis that a bright enough trail saturates R and B as well and so
// reads as white. That is a specific, testable claim, and it matters: a
// colour feature that ignores it would misclassify exactly the brightest,
// most obvious meteors.
//
// Questions:
//   1. Do meteors and non-meteors separate on colour at all?
//   2. Does green excess fall as the trail gets brighter - i.e. does the
//      saturation explanation hold?
//   3. Is what is left usable as a feature, or does it overlap too much?
//
// Every candidate already carries a verdict from the screening pass
// (31 meteor, 380 not-meteor, 0 uncertain), so this is measured against real
// labels rather than against a guess.
//
// Output is a JSON row per candidate; the analysis happens in Node
// (tests/eval/analyze_colour.js) so that the reasoning stays testable and
// re-runnable without PixInsight.
//
// Run:
//   tools/run-remote.sh --pjsr tests/pjsr/probe_colour.js
//============================================================================

var DATA_ROOT = "/Volumes/Extreme SSD/pi_works/meteor-composer-test/test-sky";
var GROUP = "Light_BIN-1_6024x4024_EXPOSURE-13.00s_FILTER-NoFilter_RGB";
var REGISTERED_DIR = DATA_ROOT + "/registered/" + GROUP;
var RESULTS_PATH = DATA_ROOT + "/detection_results.json";
var SESSION_PATH = DATA_ROOT + "/meteor_session.json";
var OUTPUT_PATH = DATA_ROOT + "/colour_samples.json";
var LOG_PATH = DATA_ROOT + "/probe_colour.log";

var SCREEN_FACTOR = 8;

// Points sampled along each trail. The trails run from about 10 to 200
// samples long, so 60 is dense enough for the short ones without being
// wasteful on the long ones.
var SAMPLES_ALONG = 60;

// At each point the trail is searched for perpendicular to its own axis: the
// endpoints come from a 1/8 field, so at full resolution the axis can be off
// by a few pixels, and a 1-2 px wide trail would be missed entirely by
// sampling the nominal line.
var SEARCH_RADIUS = 6;

// Background is read further out along the same perpendicular, clear of the
// trail and of its immediate halo.
var BACKGROUND_OFFSET = 24;

var _log = [];
var _logPath = null;

function flushLog() {
   var text = _log.join("\n") + "\n";
   var candidates = _logPath !== null
      ? [_logPath]
      : [LOG_PATH, File.systemTempDirectory + "/probe_colour.log"];
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
}

function logAndFlush(line) {
   log(line);
   flushLog();
}

// Centre of detection sample n in full-resolution pixels. Same mapping as
// preview_geometry.sampleCentreToImage: plain multiplication points at the
// corner of the 8x8 block and misses a thin trail by up to 4 px.
function sampleCentreToImage(n, scale) {
   return (n + 0.5) * scale - 0.5;
}

function clamp(v, lo, hi) {
   return v < lo ? lo : (v > hi ? hi : v);
}

// Read one candidate's colour.
//
// Returns per-channel means over the trail with the local background already
// subtracted, plus the peak, plus how close the brightest point came to
// clipping - which is what question 2 turns on.
function measureCandidate(image, candidate) {
   var w = image.width, h = image.height;

   var x0 = sampleCentreToImage(candidate.x0, SCREEN_FACTOR);
   var y0 = sampleCentreToImage(candidate.y0, SCREEN_FACTOR);
   var x1 = sampleCentreToImage(candidate.x1, SCREEN_FACTOR);
   var y1 = sampleCentreToImage(candidate.y1, SCREEN_FACTOR);

   var dx = x1 - x0, dy = y1 - y0;
   var len = Math.sqrt(dx * dx + dy * dy);
   if (len < 1) {
      return null;
   }
   var ux = dx / len, uy = dy / len;
   var px = -uy, py = ux;   // unit perpendicular

   var sumR = 0, sumG = 0, sumB = 0;
   var bgR = 0, bgG = 0, bgB = 0;
   var n = 0;
   var peakLum = -1;
   var peakR = 0, peakG = 0, peakB = 0;
   var maxChannel = 0;

   for (var s = 0; s <= SAMPLES_ALONG; ++s) {
      var f = s / SAMPLES_ALONG;
      var cx = x0 + dx * f;
      var cy = y0 + dy * f;

      // Walk across the trail and keep the brightest point found.
      var bestLum = -1, bestX = -1, bestY = -1;
      for (var r = -SEARCH_RADIUS; r <= SEARCH_RADIUS; ++r) {
         var sx = Math.round(cx + px * r);
         var sy = Math.round(cy + py * r);
         if (sx < 0 || sy < 0 || sx >= w || sy >= h) {
            continue;
         }
         var lum = image.sample(sx, sy, 0) + image.sample(sx, sy, 1)
                 + image.sample(sx, sy, 2);
         if (lum > bestLum) {
            bestLum = lum;
            bestX = sx;
            bestY = sy;
         }
      }
      if (bestX < 0) {
         continue;
      }

      // Background from both sides, averaged, so a gradient across the trail
      // does not bias the result.
      var b1x = clamp(Math.round(cx + px * BACKGROUND_OFFSET), 0, w - 1);
      var b1y = clamp(Math.round(cy + py * BACKGROUND_OFFSET), 0, h - 1);
      var b2x = clamp(Math.round(cx - px * BACKGROUND_OFFSET), 0, w - 1);
      var b2y = clamp(Math.round(cy - py * BACKGROUND_OFFSET), 0, h - 1);

      var tR = image.sample(bestX, bestY, 0);
      var tG = image.sample(bestX, bestY, 1);
      var tB = image.sample(bestX, bestY, 2);

      var kR = (image.sample(b1x, b1y, 0) + image.sample(b2x, b2y, 0)) / 2;
      var kG = (image.sample(b1x, b1y, 1) + image.sample(b2x, b2y, 1)) / 2;
      var kB = (image.sample(b1x, b1y, 2) + image.sample(b2x, b2y, 2)) / 2;

      sumR += tR; sumG += tG; sumB += tB;
      bgR += kR; bgG += kG; bgB += kB;
      ++n;

      if (bestLum > peakLum) {
         peakLum = bestLum;
         peakR = tR - kR;
         peakG = tG - kG;
         peakB = tB - kB;
      }
      var m = Math.max(tR, Math.max(tG, tB));
      if (m > maxChannel) {
         maxChannel = m;
      }
   }

   if (n === 0) {
      return null;
   }

   return {
      n: n,
      // Background-subtracted channel means. Negative values are possible on
      // a faint trail and are left as they are rather than clipped: clipping
      // would hide how noisy the measurement is.
      r: (sumR - bgR) / n,
      g: (sumG - bgG) / n,
      b: (sumB - bgB) / n,
      peakR: peakR, peakG: peakG, peakB: peakB,
      // How close the brightest sample came to clipping. The saturation
      // hypothesis predicts that green excess collapses as this approaches 1.
      maxChannel: maxChannel,
      backgroundLevel: (bgR + bgG + bgB) / (3 * n)
   };
}

function main() {
   logAndFlush("MeteorComposer colour probe");
   logAndFlush("started: " + (new Date()).toISOString());

   var results, session;
   try {
      results = JSON.parse(File.readTextFile(RESULTS_PATH));
   } catch (e) {
      logAndFlush("[FAIL] could not read " + RESULTS_PATH + " => " + e);
      return;
   }
   try {
      session = JSON.parse(File.readTextFile(SESSION_PATH));
   } catch (e) {
      logAndFlush("[FAIL] could not read " + SESSION_PATH + " => " + e);
      return;
   }

   var verdicts = {};
   for (var i = 0; i < session.verdicts.length; ++i) {
      var entry = session.verdicts[i];
      verdicts[entry.file + ":" + entry.indexInFrame] = entry.verdict;
   }
   logAndFlush("verdicts loaded: " + session.verdicts.length);

   var rows = [];
   var framesRead = 0;
   var skipped = 0;
   var t0 = Date.now();

   for (var f = 0; f < results.frames.length; ++f) {
      var frame = results.frames[f];
      var candidates = frame.candidates || [];
      if (candidates.length === 0) {
         continue;
      }

      var windows = null;
      try {
         windows = ImageWindow.open(REGISTERED_DIR + "/" + frame.file);
      } catch (e2) {
         logAndFlush("  [ERROR] open " + frame.file + " => " + e2);
      }
      if (!windows || windows.length === 0) {
         ++skipped;
         continue;
      }
      var win = windows[0];
      try {
         var image = win.mainView.image;
         if (image.numberOfChannels < 3) {
            logAndFlush("  [SKIP] " + frame.file + " is not colour");
            ++skipped;
            continue;
         }
         for (var c = 0; c < candidates.length; ++c) {
            var m = measureCandidate(image, candidates[c]);
            if (m === null) {
               continue;
            }
            m.file = frame.file;
            m.indexInFrame = c;
            m.verdict = verdicts[frame.file + ":" + c] || "unreviewed";
            m.length = candidates[c].length;
            m.elongation = candidates[c].elongation;
            m.pixelCount = candidates[c].pixelCount;
            rows.push(m);
         }
         ++framesRead;
      } finally {
         win.forceClose();
      }

      if ((framesRead % 25) === 0) {
         logAndFlush("  " + framesRead + " frames, " + rows.length + " candidates"
                     + "  (" + ((Date.now() - t0) / 1000).toFixed(0) + " s)");
      }
      CoreApplication.processEvents();
   }

   logAndFlush("");
   logAndFlush("frames read:      " + framesRead + (skipped ? ("  skipped: " + skipped) : ""));
   logAndFlush("candidates measured: " + rows.length);
   logAndFlush("elapsed:          " + ((Date.now() - t0) / 1000).toFixed(1) + " s");

   try {
      File.writeTextFile(OUTPUT_PATH, JSON.stringify({
         generated: (new Date()).toISOString(),
         group: GROUP,
         screenFactor: SCREEN_FACTOR,
         samplesAlong: SAMPLES_ALONG,
         searchRadius: SEARCH_RADIUS,
         backgroundOffset: BACKGROUND_OFFSET,
         rows: rows
      }));
      logAndFlush("written: " + OUTPUT_PATH);
   } catch (e3) {
      logAndFlush("[ERROR] could not write results: " + e3);
   }
   flushLog();
}

main();

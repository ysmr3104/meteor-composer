#engine v8

//============================================================================
// run_composite.js - Stage 3 and Stage 4 end to end on real data
//
// Builds a meteor composite: takes the master light, and adds to it the light
// that the accepted sub-frames have and the master does not, inside a
// feathered mask around each trail.
//
//   light  = sub - fit(master -> sub) - localBackground , clipped at zero
//   result = master + max over frames of ( light * mask )
//
// The arithmetic lives in composition.js and trail_mask.js, both pure
// JavaScript with Small tests. What is here is the part that has to touch
// PJSR: reading frames, moving pixels between Image and plain arrays, and
// writing the output.
//
// This is the first end-to-end exercise of Stages 3 and 4, so it is written
// as a probe rather than as the UI's pipeline: it reports what it did at
// every step and writes intermediate products, because the failure modes -
// a mask in the wrong place, a fit against the wrong master - produce output
// that looks plausible.
//
// Run:
//   tools/run-remote.sh --pjsr tests/pjsr/run_composite.js
//============================================================================

#include "../../javascript/trail_mask.js"
#include "../../javascript/composition.js"

var DATA_ROOT = "/Volumes/Extreme SSD/pi_works/meteor-composer-test";
var GROUP = "Light_BIN-1_6024x4024_EXPOSURE-13.00s_FILTER-NoFilter_RGB";
var REGISTERED_DIR = DATA_ROOT + "/registered/" + GROUP;
var MASTER_DIR = DATA_ROOT + "/master";
var RESULTS_PATH = DATA_ROOT + "/detection_results.json";
var SESSION_PATH = DATA_ROOT + "/meteor_session.json";
var OUTPUT_PATH = DATA_ROOT + "/meteor_composite.xisf";
var MASK_PATH = DATA_ROOT + "/meteor_composite_mask.xisf";
var LOG_PATH = DATA_ROOT + "/run_composite.log";

var SCREEN_FACTOR = 8;

// How many accepted meteors to composite. The full set is the goal, but a
// first run wants to be inspectable, and each frame costs a read of ~290 MB.
// 0 means all of them.
var LIMIT = 0;

// The measured defaults from trail_mask.js. The first run of this probe
// overrode them with a mask that reached 53 px from the axis, six times the
// distance the light was later measured to travel; see
// tests/pjsr/probe_trail_profile.js and docs/requirements.md 7.1.10.
var MASK_OPTIONS = null;

var _log = [];
var _logPath = null;

function flushLog() {
   var text = _log.join("\n") + "\n";
   var candidates = _logPath !== null
      ? [_logPath]
      : [LOG_PATH, File.systemTempDirectory + "/run_composite.log"];
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

// Centre of detection sample n in full-resolution pixels. Multiplying by the
// scale alone points at the corner of the block and misses a thin trail by up
// to half a block; see preview_geometry.js.
// External volumes formatted as exFAT carry macOS AppleDouble sidecars named
// "._<name>". They are not images.
function isRealXisf(name) {
   return name.length > 5
       && name.indexOf("._") !== 0
       && name.indexOf(".") !== 0
       && name.toLowerCase().lastIndexOf(".xisf") === name.length - 5;
}

function sampleCentreToImage(n, scale) {
   return (n + 0.5) * scale - 0.5;
}

// Read one channel of an Image into a plain array. This is the boundary the
// pure modules work behind.
function channelToArray(image, channel) {
   image.selectedChannel = channel;
   var m = image.toMatrix();
   return m.toArray();
}

// Write a plain array back into one channel.
//
// The fourth argument of Image.apply() is the TARGET channel. firstChannel and
// lastChannel refer to the SOURCE image's channels, which is why passing the
// target there did nothing at all for channels 1 and 2: the source is
// one-channel, so asking it for channel 1 selected nothing and the call
// returned without writing and without throwing.
//
// That produced a composite with light in R only, and it is exactly the kind
// of silent no-op that has to be measured rather than reasoned about; see
// tests/pjsr/probe_channel_write.js for the experiment that settled it.
//
// Image.assign() is not an alternative: it replaces the whole image, leaving a
// one-channel result.
function arrayToChannel(image, channel, data) {
   var channelImage = (new Matrix(data, image.height, image.width)).toImage();
   image.apply(channelImage, ImageOp.Mov, new Point(0, 0), channel);
}

function main() {
   log("MeteorComposer composite run");
   log("started: " + (new Date()).toISOString());

   // --- Which frames to composite -----------------------------------------

   section("1. Accepted meteors");

   var results, session;
   try {
      results = JSON.parse(File.readTextFile(RESULTS_PATH));
      session = JSON.parse(File.readTextFile(SESSION_PATH));
   } catch (e) {
      log("[FAIL] could not read the inputs: " + e);
      return;
   }

   var accepted = {};
   var acceptedCount = 0;
   for (var v = 0; v < session.verdicts.length; ++v) {
      if (session.verdicts[v].verdict === "meteor") {
         var key = session.verdicts[v].file;
         if (accepted[key] === undefined) {
            accepted[key] = [];
         }
         accepted[key].push(session.verdicts[v].indexInFrame);
         ++acceptedCount;
      }
   }
   log("  accepted meteors: " + acceptedCount);

   // Candidate geometry, by file and index.
   var candidatesByFile = {};
   for (var f = 0; f < results.frames.length; ++f) {
      candidatesByFile[results.frames[f].file] = results.frames[f].candidates || [];
   }

   var jobs = [];
   for (var file in accepted) {
      var cands = candidatesByFile[file];
      if (!cands) {
         log("  [SKIP] no candidates recorded for " + file);
         continue;
      }
      var trails = [];
      for (var j = 0; j < accepted[file].length; ++j) {
         var c = cands[accepted[file][j]];
         if (!c) {
            continue;
         }
         trails.push({
            x0: sampleCentreToImage(c.x0, SCREEN_FACTOR),
            y0: sampleCentreToImage(c.y0, SCREEN_FACTOR),
            x1: sampleCentreToImage(c.x1, SCREEN_FACTOR),
            y1: sampleCentreToImage(c.y1, SCREEN_FACTOR),
            // minorLength is the trail's measured width, in detection
            // samples; the mask uses it to size its solid core.
            width: (c.minorLength || 0) * SCREEN_FACTOR
         });
      }
      if (trails.length > 0) {
         jobs.push({ file: file, trails: trails });
      }
   }
   jobs.sort(function (a, b) { return a.file < b.file ? -1 : 1; });
   if (LIMIT > 0 && jobs.length > LIMIT) {
      jobs = jobs.slice(0, LIMIT);
      log("  limited to " + jobs.length + " frames");
   }
   log("  frames to composite: " + jobs.length);

   // --- The master ---------------------------------------------------------

   section("2. Master light");

   // Found rather than constructed. The master's name is close to the
   // group's but not derived from it - the group is "Light_BIN-1_..." while
   // the master is "masterLight_BIN-1_..." - and building the string from the
   // group produced a path that simply did not exist. Listing the directory
   // cannot get that wrong.
   //
   // The uncropped master is preferred: an autocropped one has different
   // dimensions from the subs, which would put every mask in the wrong place.
   var masterPath = null;
   var autocropPath = null;
   var find = new FileFind;
   if (find.begin(MASTER_DIR + "/*")) {
      do {
         if (find.isDirectory || !isRealXisf(find.name)) {
            continue;
         }
         if (find.name.indexOf("autocrop") >= 0) {
            autocropPath = MASTER_DIR + "/" + find.name;
         } else if (masterPath === null) {
            masterPath = MASTER_DIR + "/" + find.name;
         }
      } while (find.next());
   }
   if (masterPath === null) {
      masterPath = autocropPath;
   }
   if (masterPath === null) {
      log("[FAIL] no master found in " + MASTER_DIR);
      return;
   }
   log("  using: " + masterPath);
   var masterWindow = ImageWindow.open(masterPath)[0];
   var masterImage = masterWindow.mainView.image;
   var W = masterImage.width;
   var H = masterImage.height;
   var channels = masterImage.numberOfChannels;
   log("  " + W + "x" + H + " x" + channels + "ch");

   // The composite is built in this copy: the master itself must not be
   // modified in place.
   var output = new Image(masterImage);

   // The master is read once and never written to, and every frame is fitted
   // against this pristine copy. The light each frame contributes goes into a
   // separate accumulator and is applied at the end.
   //
   // Compositing into the master as it went - which is what this did first -
   // broke every meteor that crossed an exposure boundary: the second frame's
   // mask covers the first frame's trail, the second frame has no meteor
   // there, so its residual was the first frame's light with a minus sign.
   var masterChannels = [];
   var added = [];
   for (var ch = 0; ch < channels; ++ch) {
      masterChannels.push(channelToArray(masterImage, ch));
      added.push(new Float32Array(W * H));
   }
   log("  master channels read");

   // --- Composite ----------------------------------------------------------

   section("3. Compositing");

   var accumulatedMask = { data: new Float32Array(W * H), width: W, height: H };
   var composed = 0;
   var skipped = 0;
   var t0 = Date.now();

   for (var k = 0; k < jobs.length; ++k) {
      var job = jobs[k];
      var frameStart = Date.now();

      var maskField = renderMask(job.trails, W, H, MASK_OPTIONS);
      var coverage = maskCoverage(maskField);
      // One rectangle per trail: the local sky is measured around each trail,
      // not once for the frame.
      var rects = [];
      for (var ri = 0; ri < job.trails.length; ++ri) {
         rects.push(maskBounds(job.trails[ri], W, H, MASK_OPTIONS));
      }

      var subWindow = null;
      try {
         subWindow = ImageWindow.open(REGISTERED_DIR + "/" + job.file)[0];
      } catch (e2) {
         log("  [ERROR] open " + job.file + " => " + e2);
      }
      if (!subWindow) {
         ++skipped;
         continue;
      }

      try {
         var subImage = subWindow.mainView.image;
         if (subImage.width !== W || subImage.height !== H) {
            // A cropped master against uncropped subs would put every mask in
            // the wrong place, and the result would look like a mask bug
            // rather than a mismatch.
            log("  [SKIP] " + job.file + " is " + subImage.width + "x" + subImage.height
                + ", master is " + W + "x" + H
                + " - use the uncropped master, or crop the subs to match");
            ++skipped;
            continue;
         }

         var subChannels = [];
         for (var c2 = 0; c2 < channels; ++c2) {
            subChannels.push(channelToArray(subImage, c2));
         }

         var outcome = composeFrame(masterChannels, subChannels, maskField.data,
                                    W, H, rects, added, null);
         if (!outcome.written) {
            log("  [SKIP] " + job.file + " channel " + outcome.channel
                + ": " + outcome.reason);
            ++skipped;
            continue;
         }

         var report = [];
         for (var c3 = 0; c3 < channels; ++c3) {
            var trailReport = outcome.trails[0][c3];
            report.push("ch" + c3 + " scale=" + outcome.fits[c3].scale.toFixed(3)
                        + " bg=" + trailReport.background.level.toExponential(2)
                        + " peak=" + trailReport.peak.toFixed(4));
         }

         for (var m = 0; m < maskField.data.length; ++m) {
            if (maskField.data[m] > accumulatedMask.data[m]) {
               accumulatedMask.data[m] = maskField.data[m];
            }
         }

         ++composed;
         log("  [" + (k + 1) + "/" + jobs.length + "] " + job.file
             + "  trails=" + job.trails.length
             + "  mask=" + (coverage.fraction * 100).toFixed(3) + "%"
             + "  " + report.join("  ")
             + "  (" + (Date.now() - frameStart) + " ms)");
      } finally {
         subWindow.forceClose();
      }
      CoreApplication.processEvents();
   }

   log("");
   log("  composited: " + composed + "   skipped: " + skipped);
   log("  elapsed:    " + ((Date.now() - t0) / 1000).toFixed(1) + " s");

   // --- Write --------------------------------------------------------------

   section("4. Output");

   var totalCoverage = maskCoverage(accumulatedMask);
   log("  combined mask covers " + (totalCoverage.fraction * 100).toFixed(3)
       + "% of the frame (" + totalCoverage.touched + " pixels, "
       + totalCoverage.solid + " solid)");

   try {
      for (var c4 = 0; c4 < channels; ++c4) {
         arrayToChannel(output, c4, applyAdded(masterChannels[c4], added[c4]));
      }
      var outWindow = new ImageWindow(W, H, channels,
                                      masterImage.bitsPerSample,
                                      masterImage.isReal,
                                      masterImage.isColor,
                                      "MeteorComposite");
      outWindow.mainView.beginProcess(UndoFlag.NoSwapFile);
      outWindow.mainView.image.assign(output);
      outWindow.mainView.endProcess();
      outWindow.saveAs(OUTPUT_PATH, false, false, false, false);
      outWindow.forceClose();
      log("  written: " + OUTPUT_PATH);
   } catch (e3) {
      log("  [ERROR] could not write the composite: " + e3);
   }

   // The mask is written too. requirements.md 7.2 allows stopping at Stage 3
   // and handing the mask to the user, and when a composite looks wrong the
   // mask is the first thing to look at.
   try {
      var maskWindow = new ImageWindow(W, H, 1, 32, true, false, "MeteorMask");
      maskWindow.mainView.beginProcess(UndoFlag.NoSwapFile);
      // Matrix.toImage() already yields a one-channel float image, so there
      // is no need to construct one and copy into it.
      var maskImage = (new Matrix(accumulatedMask.data, H, W)).toImage();
      maskWindow.mainView.image.assign(maskImage);
      maskWindow.mainView.endProcess();
      maskWindow.saveAs(MASK_PATH, false, false, false, false);
      maskWindow.forceClose();
      log("  written: " + MASK_PATH);
   } catch (e4) {
      log("  [ERROR] could not write the mask: " + e4);
   }

   masterWindow.forceClose();

   section("Done");
   log("finished: " + (new Date()).toISOString());
   flushLog();
}

main();

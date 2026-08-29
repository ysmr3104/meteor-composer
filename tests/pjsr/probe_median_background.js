#engine v8

//============================================================================
// probe_median_background.js - A background built from frames that were never
// aligned
//
// requirements 3.4 leaves one thing undecided. A ground-referenced composite
// is drawn onto one of the frames, and one frame carries one frame's worth of
// noise. Stacking a few dozen of them WITHOUT aligning anything would keep the
// landscape sharp - the tripod did not move - divide the noise by root N, and
// drop the meteors and satellites out of it, because a median drops whatever
// is in fewer than half the frames. The cost is that the stars smear: they are
// the only thing in the picture that does move.
//
// That trade is an aesthetic judgement and belongs to the operator. What has
// to be settled here is whether it works at all, and what it costs:
//
//   1. Does ImageIntegration accept unregistered frames and return a median?
//      Nothing in it checks for alignment, but that is a reading of the
//      documentation, not a measurement.
//   2. How long does it take, and does it fit in memory? These are 6064x4040
//      RGB float32 frames - 294 MB each - and a composite is built after an
//      operator has already spent an evening screening.
//   3. Does the result sit at the same sky level as a single frame? The
//      composite fits every frame against its background (7.3.1), so a stack
//      at a different level would be reported as not matching.
//   4. How much noise actually comes out, against the root-N ideal?
//   5. How far do the stars move across the window? Reported in seconds and
//      degrees so the number can be turned into a decision.
//
// The stack itself is written out. The last question - whether it looks right
// - cannot be answered here.
//
// Data provided by mave (NIKON ZR, 24mm F4, ISO1250, 13 s x 1045).
//
// Run:
//   tools/run-remote.sh --pjsr tests/pjsr/probe_median_background.js
//============================================================================

var DATA_ROOT = "/Volumes/Extreme SSD/pi_works/mave";
var DEBAYERED_DIR = DATA_ROOT
   + "/debayered/Light_BIN-1_6064x4040_EXPOSURE-13.00s_FILTER-NoFilter_CFA";
var LOG_PATH = DATA_ROOT + "/probe_median_background.log";
var OUT_DIR = DATA_ROOT + "/median_background";

// Windows to try. 1 is the frame on its own, which is the baseline every other
// row is measured against.
var COUNTS = [1, 5, 15, 31];

// The frame at the centre of the window. A judged meteor, so the stack that
// removes it can be looked at afterwards next to the frame that has it.
var CENTRE = "DSC_1865_d.xisf";

//----------------------------------------------------------------------------

var log = [];

function say(line) {
   log.push(line);
   // Written every time. A probe that collects everything and writes at the
   // end loses the lot when an unsupported call throws, and that has happened.
   File.writeTextFile(LOG_PATH, log.join("\n") + "\n");
}

function listFrames(dir) {
   var found = new FileFind;
   var names = [];
   if (found.begin(dir + "/*.xisf")) {
      do {
         var name = found.name;
         if (name.indexOf("._") !== 0 && name.indexOf(".") !== 0) {
            names.push(name);
         }
      } while (found.next());
   }
   names.sort();
   return names;
}

// Only assign what this build actually has. ImageIntegration has gained and
// lost properties across versions and a missing one throws on assignment,
// which would end the probe rather than the setting.
function setIf(obj, name, value) {
   if (name in obj) {
      obj[name] = value;
      return true;
   }
   say("    (no such property: " + name + ")");
   return false;
}

function keywordValue(window, name) {
   var kw = window.keywords;
   for (var i = 0; i < kw.length; ++i) {
      if (kw[i].name === name) {
         return kw[i].value.trim().replace(/^'|'$/g, "").trim();
      }
   }
   return null;
}

// "2026-08-12T00:54:13.123" -> seconds. Enough to subtract two of them within
// one night; not a general date parser and not pretending to be.
function secondsOfDay(stamp) {
   if (stamp === null) {
      return null;
   }
   var m = /T(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stamp);
   if (m === null) {
      return null;
   }
   return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

function statsOf(image) {
   return { median: image.median(), mad: image.MAD(),
            width: image.width, height: image.height,
            channels: image.numberOfChannels };
}

//----------------------------------------------------------------------------

say("probe_median_background");
say("frames: " + DEBAYERED_DIR);
say("");

var names = listFrames(DEBAYERED_DIR);
say("found " + names.length + " frames");

var centreIndex = names.indexOf(CENTRE);
if (centreIndex < 0) {
   say("ERROR: " + CENTRE + " is not in that directory");
   throw new Error("centre frame missing");
}
say("centre: " + CENTRE + " at index " + centreIndex);

if (!File.directoryExists(OUT_DIR)) {
   File.createDirectory(OUT_DIR, true);
}

var baseline = null;

for (var c = 0; c < COUNTS.length; ++c) {
   var count = COUNTS[c];
   say("");
   say("=== " + count + " frame" + (count === 1 ? "" : "s") + " ===");

   // Consecutive and centred, not spread across the night. Spreading would put
   // the stars in dashes across 63 degrees; consecutive keeps one short trail.
   var half = Math.floor((count - 1) / 2);
   var from = Math.max(0, Math.min(centreIndex - half, names.length - count));
   var window = names.slice(from, from + count);
   say("window: " + window[0] + " .. " + window[window.length - 1]);

   var startedAt = Date.now();
   var resultWindow = null;
   var resultPath = OUT_DIR + "/median_" + count + ".xisf";

   if (count === 1) {
      resultWindow = ImageWindow.open(DEBAYERED_DIR + "/" + window[0])[0];
   } else {
      var II = new ImageIntegration;
      var images = [];
      for (var i = 0; i < window.length; ++i) {
         images.push([true, DEBAYERED_DIR + "/" + window[i], "", ""]);
      }
      II.images = images;
      setIf(II, "combination", ImageIntegration.Median);
      // Nothing is scaled to anything. The frames are minutes apart from one
      // camera at one exposure, and the composite fits each frame against this
      // result afterwards anyway.
      setIf(II, "normalization", ImageIntegration.NoNormalization);
      setIf(II, "rejection", ImageIntegration.NoRejection);
      setIf(II, "rejectionNormalization",
            ImageIntegration.NoRejectionNormalization);
      setIf(II, "weightMode", ImageIntegration.DontCare);
      setIf(II, "generateRejectionMaps", false);
      setIf(II, "generateDrizzleData", false);
      setIf(II, "generate64BitResult", false);
      setIf(II, "subtractPedestals", false);
      setIf(II, "evaluateSNR", false);
      setIf(II, "autoMemorySize", true);
      setIf(II, "autoMemoryLimit", 0.75);

      var ok = false;
      try {
         ok = II.executeGlobal();
      } catch (e) {
         say("  executeGlobal threw: " + e);
      }
      say("  executeGlobal: " + ok);
      if (!ok) {
         continue;
      }
      resultWindow = ImageWindow.windowById(II.integrationImageId);
   }

   if (!resultWindow || resultWindow.isNull) {
      say("  ERROR: no result window");
      continue;
   }

   var elapsed = Date.now() - startedAt;
   var stats = statsOf(resultWindow.mainView.image);
   say("  " + stats.width + "x" + stats.height + "x" + stats.channels
       + "   " + (elapsed / 1000).toFixed(1) + " s");
   say("  median " + stats.median.toFixed(6)
       + "   MAD " + stats.mad.toFixed(6));

   if (baseline === null) {
      baseline = stats;
   } else {
      var levelRatio = stats.median / baseline.median;
      var noiseRatio = stats.mad / baseline.mad;
      say("  sky level  " + levelRatio.toFixed(4) + " x one frame"
          + "   (the composite's fit wants this near 1)");
      say("  noise      " + noiseRatio.toFixed(4) + " x one frame"
          + "   (root-N ideal is " + (1 / Math.sqrt(count)).toFixed(4) + ")");
      var sameSize = stats.width === baseline.width
                  && stats.height === baseline.height
                  && stats.channels === baseline.channels;
      say("  geometry matches a frame: " + sameSize
          + "   (the composite requires it)");
   }

   // How far the sky turned across the window, from the frames themselves.
   if (count > 1) {
      var firstWindow = ImageWindow.open(DEBAYERED_DIR + "/" + window[0])[0];
      var lastWindow = ImageWindow.open(
         DEBAYERED_DIR + "/" + window[window.length - 1])[0];
      var t0 = secondsOfDay(keywordValue(firstWindow, "DATE-OBS"));
      var t1 = secondsOfDay(keywordValue(lastWindow, "DATE-OBS"));
      firstWindow.forceClose();
      lastWindow.forceClose();
      if (t0 !== null && t1 !== null) {
         var span = t1 - t0;
         if (span < 0) {
            span += 24 * 3600;
         }
         say("  span " + span.toFixed(0) + " s"
             + "   sky turned " + (span * 15 / 3600).toFixed(2) + " deg"
             + "   (this is the star trail the stack draws)");
      } else {
         say("  span: DATE-OBS not readable");
      }
   }

   try {
      resultWindow.saveAs(resultPath, false, false, false, false);
      say("  wrote " + resultPath);
   } catch (e2) {
      say("  could not write it: " + e2);
   }
   resultWindow.forceClose();
}

say("");
say("done");

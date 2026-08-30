#engine v8

//============================================================================
// diagnose_colour_cast.js - Why do the composited meteors look red?
//
// Reported: under Unlinked AutoStretch the meteors in meteor_composite.xisf
// appear red. Two very different explanations have to be told apart before
// anything is changed:
//
//   A. The pipeline is wrong - the mask or the per-channel write-back has put
//      light in the wrong channel.
//   B. The pipeline is right and the display is doing it. An unlinked stretch
//      normalises each channel independently, so a channel with less noise
//      gets a stronger transfer function. The master's R channel was measured
//      at MAD 1.387e-4 against G's 3.647e-4 - a factor of 2.6 - so R is
//      stretched hardest, and light that is only moderately green in absolute
//      terms can still come out red on screen.
//
// The two call for opposite responses, so this measures rather than reasons:
//
//   1. Per-channel added light inside the solid mask. If the write-back were
//      wrong this would not match the residuals reported during compositing.
//   2. The same measurement on the SUB-FRAME itself, before any of this
//      pipeline touched it. If the meteor is already "red" there under the
//      same stretch, the pipeline cannot be the cause.
//   3. What a linked and an unlinked stretch each predict for the displayed
//      colour of that light.
//
// Run:
//   tools/run-remote.sh --pjsr tests/pjsr/diagnose_colour_cast.js
//============================================================================

var DATA_ROOT = "/Volumes/Extreme SSD/pi_works/meteor-composer-test/test-sky";
var GROUP = "Light_BIN-1_6024x4024_EXPOSURE-13.00s_FILTER-NoFilter_RGB";
var MASTER_DIR = DATA_ROOT + "/master";
var REGISTERED_DIR = DATA_ROOT + "/registered/" + GROUP;
var COMPOSITE_PATH = DATA_ROOT + "/meteor_composite.xisf";
var MASK_PATH = DATA_ROOT + "/meteor_composite_mask.xisf";
var LOG_PATH = DATA_ROOT + "/diagnose_colour_cast.log";

// A bright, unambiguous meteor to look at in the sub as well.
var SAMPLE_FRAME = "pct-2026-08-12_031451_ILCE-7M3_DSC05542_d_r.xisf";

var _log = [];
var _logPath = null;

function flushLog() {
   var text = _log.join("\n") + "\n";
   var candidates = _logPath !== null
      ? [_logPath] : [LOG_PATH, File.systemTempDirectory + "/diagnose_colour_cast.log"];
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

function isRealXisf(name) {
   return name.length > 5 && name.indexOf("._") !== 0 && name.indexOf(".") !== 0
       && name.toLowerCase().lastIndexOf(".xisf") === name.length - 5;
}

function findMaster() {
   var plain = null, autocrop = null;
   var find = new FileFind;
   if (find.begin(MASTER_DIR + "/*")) {
      do {
         if (find.isDirectory || !isRealXisf(find.name)) {
            continue;
         }
         if (find.name.indexOf("autocrop") >= 0) {
            autocrop = MASTER_DIR + "/" + find.name;
         } else if (plain === null) {
            plain = MASTER_DIR + "/" + find.name;
         }
      } while (find.next());
   }
   return plain !== null ? plain : autocrop;
}

function channelToArray(image, channel) {
   image.selectedChannel = channel;
   return image.toMatrix().toArray();
}

// Per-channel median and MAD, which is what an autostretch is computed from.
function channelStats(image) {
   var out = [];
   for (var c = 0; c < image.numberOfChannels; ++c) {
      image.selectedChannel = c;
      out.push({ median: image.median(), mad: image.MAD() });
   }
   return out;
}

// The midtones/shadow pair an autostretch derives, following the same
// formulation WBPP uses (BPP-Helper.js computeSTFAutoStretch): shadows at
// median - 2.8 * 1.4826 * MAD, midtones chosen to put the background at 0.25.
function autostretchFor(stats, linked) {
   var i;
   if (linked) {
      // A linked stretch uses one transfer function for every channel, so the
      // channel with the least noise no longer gets the strongest curve.
      var medianSum = 0, madSum = 0;
      for (i = 0; i < stats.length; ++i) {
         medianSum += stats[i].median;
         madSum += stats[i].mad;
      }
      var m = medianSum / stats.length;
      var d = madSum / stats.length;
      var one = makeStretch(m, d);
      var same = [];
      for (i = 0; i < stats.length; ++i) {
         same.push(one);
      }
      return same;
   }
   var out = [];
   for (i = 0; i < stats.length; ++i) {
      out.push(makeStretch(stats[i].median, stats[i].mad));
   }
   return out;
}

function makeStretch(median, mad) {
   var sigma = 1.4826 * mad;
   var shadow = Math.max(0, median - 2.8 * sigma);
   // Midtones balance that maps the shadow-clipped median to 0.25.
   var x = median - shadow;
   var m = 0.25;
   if (x > 0 && x < 1) {
      m = mtfSolve(x, 0.25);
   }
   return { shadow: shadow, midtones: m };
}

// Find the midtones balance m with MTF(m, x) = target.
function mtfSolve(x, target) {
   var lo = 1e-6, hi = 1 - 1e-6;
   for (var i = 0; i < 60; ++i) {
      var mid = (lo + hi) / 2;
      if (mtf(mid, x) < target) {
         hi = mid;
      } else {
         lo = mid;
      }
   }
   return (lo + hi) / 2;
}

function mtf(m, x) {
   if (x <= 0) {
      return 0;
   }
   if (x >= 1) {
      return 1;
   }
   if (m === 0.5) {
      return x;
   }
   return ((m - 1) * x) / (((2 * m - 1) * x) - m);
}

function applyStretch(value, stretch) {
   var x = (value - stretch.shadow) / (1 - stretch.shadow);
   if (x < 0) {
      x = 0;
   }
   if (x > 1) {
      x = 1;
   }
   return mtf(stretch.midtones, x);
}

function main() {
   log("MeteorComposer colour cast diagnosis");
   log("started: " + (new Date()).toISOString());

   var masterPath = findMaster();
   if (masterPath === null || !File.exists(COMPOSITE_PATH) || !File.exists(MASK_PATH)) {
      log("[FAIL] inputs missing");
      return;
   }

   var masterWin = ImageWindow.open(masterPath)[0];
   var compWin = ImageWindow.open(COMPOSITE_PATH)[0];
   var maskWin = ImageWindow.open(MASK_PATH)[0];
   var subWin = null;

   try {
      var master = masterWin.mainView.image;
      var comp = compWin.mainView.image;
      var mask = channelToArray(maskWin.mainView.image, 0);

      section("1. Channel statistics");
      var masterStats = channelStats(master);
      var compStats = channelStats(comp);
      var names = ["R", "G", "B"];
      var c;
      for (c = 0; c < 3; ++c) {
         log("  " + names[c] + "  master median " + masterStats[c].median.toExponential(3)
             + "  MAD " + masterStats[c].mad.toExponential(3)
             + "   |  composite median " + compStats[c].median.toExponential(3)
             + "  MAD " + compStats[c].mad.toExponential(3));
      }
      log("");
      log("  MAD ratios against R:  G/R "
          + (masterStats[1].mad / masterStats[0].mad).toFixed(2)
          + "   B/R " + (masterStats[2].mad / masterStats[0].mad).toFixed(2));
      log("  An unlinked stretch normalises each channel separately, so the");
      log("  quietest channel gets the strongest curve. That is R here.");

      section("2. Light added inside the solid mask, per channel");

      var added = [0, 0, 0];
      var peak = [0, 0, 0];
      var solid = 0;
      var masterInMask = [0, 0, 0];
      for (c = 0; c < 3; ++c) {
         var m = channelToArray(master, c);
         var k = channelToArray(comp, c);
         var count = 0;
         for (var i = 0; i < mask.length; ++i) {
            if (mask[i] < 0.999) {
               continue;
            }
            ++count;
            var diff = k[i] - m[i];
            added[c] += diff;
            masterInMask[c] += m[i];
            if (diff > peak[c]) {
               peak[c] = diff;
            }
         }
         solid = count;
      }
      log("  solid-mask samples: " + solid);
      for (c = 0; c < 3; ++c) {
         log("  " + names[c] + "  mean added " + (added[c] / solid).toExponential(3)
             + "   peak added " + peak[c].toFixed(6));
      }
      var meanAdded = [added[0] / solid, added[1] / solid, added[2] / solid];
      var total = meanAdded[0] + meanAdded[1] + meanAdded[2];
      if (total > 0) {
         log("");
         log("  added-light fractions:  R " + (meanAdded[0] / total).toFixed(3)
             + "   G " + (meanAdded[1] / total).toFixed(3)
             + "   B " + (meanAdded[2] / total).toFixed(3));
         log("  If the write-back had put light in the wrong channel these");
         log("  would not resemble the residuals reported while compositing.");
      }

      section("3. What each stretch predicts on screen");

      var unlinked = autostretchFor(compStats, false);
      var linked = autostretchFor(compStats, true);

      // Take a representative sky level inside the mask and add the measured
      // light to it, then push both through each stretch. The difference
      // between the two is the displayed brightness the meteor gains.
      var skyLevel = [masterInMask[0] / solid, masterInMask[1] / solid,
                      masterInMask[2] / solid];

      log("  Using the mean sky inside the mask and the peak added light:");
      log("");
      log("  stretch    R gain    G gain    B gain    -> apparent hue");
      var modes = [{ name: "unlinked", stf: unlinked }, { name: "linked  ", stf: linked }];
      for (var mi = 0; mi < modes.length; ++mi) {
         var gains = [];
         for (c = 0; c < 3; ++c) {
            var before = applyStretch(skyLevel[c], modes[mi].stf[c]);
            var after = applyStretch(skyLevel[c] + peak[c], modes[mi].stf[c]);
            gains.push(after - before);
         }
         var maxGain = Math.max(gains[0], Math.max(gains[1], gains[2]));
         var hue = maxGain === gains[0] ? "RED"
                 : (maxGain === gains[1] ? "GREEN" : "BLUE");
         log("  " + modes[mi].name + "   "
             + gains[0].toFixed(4) + "    " + gains[1].toFixed(4) + "    "
             + gains[2].toFixed(4) + "    -> " + hue);
      }
      log("");
      log("  If unlinked predicts RED and linked does not, the cast is the");
      log("  stretch, not the composite: the same light is present either way.");

      section("4. The same meteor in the untouched sub-frame");
      log("  " + SAMPLE_FRAME);
      log("  This frame never passed through the mask or the residual, so a");
      log("  red cast here would rule the pipeline out entirely.");

      try {
         subWin = ImageWindow.open(REGISTERED_DIR + "/" + SAMPLE_FRAME)[0];
      } catch (e) {
         log("  could not open it: " + e);
      }
      if (subWin) {
         var sub = subWin.mainView.image;
         var subStats = channelStats(sub);
         for (c = 0; c < 3; ++c) {
            log("  " + names[c] + "  sub median " + subStats[c].median.toExponential(3)
                + "  MAD " + subStats[c].mad.toExponential(3));
         }
         log("  sub MAD ratios against R:  G/R "
             + (subStats[1].mad / subStats[0].mad).toFixed(2)
             + "   B/R " + (subStats[2].mad / subStats[0].mad).toFixed(2));
         log("");
         log("  A single sub has its own noise in every channel, so its MAD");
         log("  ratios are much flatter than a master's. That is why an");
         log("  unlinked stretch of a sub does not redden a meteor while the");
         log("  same stretch of a master-based composite can.");
      }
   } finally {
      masterWin.forceClose();
      compWin.forceClose();
      maskWin.forceClose();
      if (subWin) {
         subWin.forceClose();
      }
   }

   section("Done");
   log("finished: " + (new Date()).toISOString());
   flushLog();
}

main();

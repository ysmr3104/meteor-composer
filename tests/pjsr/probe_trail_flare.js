#engine v8

//============================================================================
// probe_trail_flare.js - Does the light need the same width all along a trail?
//
// probe_trail_profile.js averaged each trail's light over its whole length and
// found it gone by 20 px from the axis. That justified a capsule of constant
// radius, but it cannot see a flare: a meteor that bursts spreads light over a
// short stretch of its path, and averaging over the rest of the trail divides
// that away. A capsule sized by the average would cut exactly the part of the
// meteor an observer cares most about.
//
// So the same measurement, but per position along the trail: the axis is cut
// into bins and each bin gets its own perpendicular profile. What comes out is
// whether one radius fits a whole trail, and if not, how much the widest place
// needs.
//
// If the answer is that the requirement varies, then a constant-radius capsule
// is the wrong shape whatever number is chosen for it, and the mask has to
// follow the light instead of a rule.
//
// Run:
//   tools/run-remote.sh --pjsr tests/pjsr/probe_trail_flare.js
//============================================================================

#include "../../javascript/trail_mask.js"
#include "../../javascript/composition.js"

var DATA_ROOT = "/Volumes/Extreme SSD/pi_works/meteor-composer-test";
var GROUP = "Light_BIN-1_6024x4024_EXPOSURE-13.00s_FILTER-NoFilter_RGB";
var REGISTERED_DIR = DATA_ROOT + "/registered/" + GROUP;
var MASTER_DIR = DATA_ROOT + "/master";
var RESULTS_PATH = DATA_ROOT + "/detection_results.json";
var SESSION_PATH = DATA_ROOT + "/meteor_session.json";
var LOG_PATH = DATA_ROOT + "/probe_trail_flare.log";

var SCREEN_FACTOR = 8;

// How far out to look. Beyond the current mask, so that a flare wider than the
// mask can be seen rather than assumed away.
var PERP_LIMIT = 60;

// Length of each bin along the axis. 20 px is short enough to isolate a flare
// and long enough that a bin still holds ~40 pixels at each distance, so a bin
// mean is stable to about a sixth of the per-pixel noise.
var BIN_LENGTH = 20;

// Also profile past the endpoints, in the same bins.
var AXIAL_MARGIN = 40;

var FAR_FROM = 45;      // bins used as the noise and level reference
var FIT_STRIDE = 7;
var FIT_EXCLUDE_RADIUS = 80;

var _log = [];
var _logPath = null;

function flushLog() {
   var text = _log.join("\n") + "\n";
   var candidates = _logPath !== null
      ? [_logPath]
      : [LOG_PATH, File.systemTempDirectory + "/probe_trail_flare.log"];
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

function pad(s, n) {
   s = String(s);
   while (s.length < n) {
      s = " " + s;
   }
   return s;
}

function isRealXisf(name) {
   return name.length > 5
       && name.indexOf("._") !== 0
       && name.indexOf(".") !== 0
       && name.toLowerCase().lastIndexOf(".xisf") === name.length - 5;
}

function sampleCentreToImage(n, scale) {
   return (n + 0.5) * scale - 0.5;
}

function channelToArray(image, channel) {
   image.selectedChannel = channel;
   return image.toMatrix().toArray();
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

function stridedFit(master, sub, trails, width, height) {
   var x = [], y = [];
   for (var iy = 0; iy < height; iy += FIT_STRIDE) {
      var row = iy * width;
      for (var ix = 0; ix < width; ix += FIT_STRIDE) {
         var near = false;
         for (var t = 0; t < trails.length; ++t) {
            if (distanceToSegment(ix, iy, trails[t].x0, trails[t].y0,
                                  trails[t].x1, trails[t].y1) < FIT_EXCLUDE_RADIUS) {
               near = true;
               break;
            }
         }
         if (near) {
            continue;
         }
         x.push(master[row + ix]);
         y.push(sub[row + ix]);
      }
   }
   return linearFit(x, y);
}

function medianOf(values) {
   if (values.length === 0) {
      return 0;
   }
   var s = values.slice().sort(function (a, b) { return a - b; });
   var mid = s.length >> 1;
   return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function main() {
   log("MeteorComposer per-position trail profile");
   log("started: " + (new Date()).toISOString());
   log("");
   log("For each trail the axis is cut into " + BIN_LENGTH + " px bins, and each");
   log("bin gets its own profile out to " + PERP_LIMIT + " px. `reach` is the");
   log("distance at which that bin's mean light falls below the per-pixel noise.");

   var results, session;
   try {
      results = JSON.parse(File.readTextFile(RESULTS_PATH));
      session = JSON.parse(File.readTextFile(SESSION_PATH));
   } catch (e) {
      log("[FAIL] could not read the inputs: " + e);
      return;
   }

   var candidatesByFile = {};
   for (var f = 0; f < results.frames.length; ++f) {
      candidatesByFile[results.frames[f].file] = results.frames[f].candidates || [];
   }

   var jobs = [];
   var byFile = {};
   for (var v = 0; v < session.verdicts.length; ++v) {
      var verdict = session.verdicts[v];
      if (verdict.verdict !== "meteor") {
         continue;
      }
      var cands = candidatesByFile[verdict.file];
      if (!cands) {
         continue;
      }
      var c = cands[verdict.indexInFrame];
      if (!c) {
         continue;
      }
      if (byFile[verdict.file] === undefined) {
         byFile[verdict.file] = { file: verdict.file, trails: [] };
         jobs.push(byFile[verdict.file]);
      }
      byFile[verdict.file].trails.push({
         x0: sampleCentreToImage(c.x0, SCREEN_FACTOR),
         y0: sampleCentreToImage(c.y0, SCREEN_FACTOR),
         x1: sampleCentreToImage(c.x1, SCREEN_FACTOR),
         y1: sampleCentreToImage(c.y1, SCREEN_FACTOR)
      });
   }
   jobs.sort(function (a, b) { return a.file < b.file ? -1 : 1; });
   log("");
   log("frames: " + jobs.length);

   var masterPath = findMaster();
   if (masterPath === null) {
      log("[FAIL] no master found");
      return;
   }
   var masterWindow = ImageWindow.open(masterPath)[0];
   var masterImage = masterWindow.mainView.image;
   var W = masterImage.width;
   var H = masterImage.height;
   var channels = masterImage.numberOfChannels;
   var masterChannels = [];
   for (var ch = 0; ch < channels; ++ch) {
      masterChannels.push(channelToArray(masterImage, ch));
   }

   var summary = [];
   var t0 = Date.now();

   for (var k = 0; k < jobs.length; ++k) {
      var job = jobs[k];
      var subWindow = null;
      try {
         subWindow = ImageWindow.open(REGISTERED_DIR + "/" + job.file)[0];
      } catch (e2) {
         log("  [ERROR] open " + job.file + " => " + e2);
      }
      if (!subWindow) {
         continue;
      }

      try {
         var subImage = subWindow.mainView.image;
         if (subImage.width !== W || subImage.height !== H) {
            continue;
         }
         var subChannels = [];
         var fits = [];
         for (var c2 = 0; c2 < channels; ++c2) {
            subChannels.push(channelToArray(subImage, c2));
            fits.push(stridedFit(masterChannels[c2], subChannels[c2], job.trails, W, H));
         }

         for (var ti = 0; ti < job.trails.length; ++ti) {
            var trail = job.trails[ti];
            var dx = trail.x1 - trail.x0;
            var dy = trail.y1 - trail.y0;
            var len = Math.sqrt(dx * dx + dy * dy);
            if (!(len > 0)) {
               continue;
            }
            var ux = dx / len;
            var uy = dy / len;

            // Bins run from -AXIAL_MARGIN to len + AXIAL_MARGIN.
            var binCount = Math.ceil((len + 2 * AXIAL_MARGIN) / BIN_LENGTH);
            var sums = [];
            var sqs = [];
            var counts = [];
            var peaks = [];
            var b, d;
            for (b = 0; b < binCount; ++b) {
               sums.push(new Float64Array(PERP_LIMIT + 1));
               sqs.push(new Float64Array(PERP_LIMIT + 1));
               counts.push(new Float64Array(PERP_LIMIT + 1));
               peaks.push(0);
            }

            var reach = PERP_LIMIT + AXIAL_MARGIN + 2;
            var left = Math.max(0, Math.floor(Math.min(trail.x0, trail.x1) - reach));
            var right = Math.min(W - 1, Math.ceil(Math.max(trail.x0, trail.x1) + reach));
            var top = Math.max(0, Math.floor(Math.min(trail.y0, trail.y1) - reach));
            var bottom = Math.min(H - 1, Math.ceil(Math.max(trail.y0, trail.y1) + reach));

            for (var y = top; y <= bottom; ++y) {
               var rowBase = y * W;
               for (var x = left; x <= right; ++x) {
                  var rx = x - trail.x0;
                  var ry = y - trail.y0;
                  var along = rx * ux + ry * uy;
                  var across = Math.abs(rx * uy - ry * ux);
                  if (across > PERP_LIMIT) {
                     continue;
                  }
                  if (along < -AXIAL_MARGIN || along > len + AXIAL_MARGIN) {
                     continue;
                  }
                  var bin = Math.floor((along + AXIAL_MARGIN) / BIN_LENGTH);
                  if (bin < 0 || bin >= binCount) {
                     continue;
                  }
                  var idx = rowBase + x;
                  var value = 0;
                  for (var cc = 0; cc < channels; ++cc) {
                     value += subChannels[cc][idx]
                            - (fits[cc].scale * masterChannels[cc][idx] + fits[cc].offset);
                  }
                  value /= channels;
                  var pb = Math.floor(across);
                  sums[bin][pb] += value;
                  sqs[bin][pb] += value * value;
                  counts[bin][pb] += 1;
                  if (value > peaks[bin]) {
                     peaks[bin] = value;
                  }
               }
            }

            // Noise and level from the far bins of the whole trail together:
            // a single 20 px bin does not hold enough distant pixels to
            // measure noise on its own.
            var farSum = 0, farSq = 0, farN = 0;
            for (b = 0; b < binCount; ++b) {
               for (d = FAR_FROM; d <= PERP_LIMIT; ++d) {
                  farSum += sums[b][d];
                  farSq += sqs[b][d];
                  farN += counts[b][d];
               }
            }
            var level = farN > 0 ? farSum / farN : 0;
            var varr = farN > 0 ? farSq / farN - level * level : 0;
            var sigma = varr > 0 ? Math.sqrt(varr) : 0;

            // Per-bin reach: the outermost distance whose mean still exceeds
            // the per-pixel noise.
            var reaches = [];
            var insideReaches = [];
            for (b = 0; b < binCount; ++b) {
               var r = 0;
               for (d = PERP_LIMIT; d >= 0; --d) {
                  if (counts[b][d] > 0 && sums[b][d] / counts[b][d] - level > sigma) {
                     r = d;
                     break;
                  }
               }
               reaches.push(r);
               var centre = (b + 0.5) * BIN_LENGTH - AXIAL_MARGIN;
               if (centre >= 0 && centre <= len) {
                  insideReaches.push(r);
               }
            }

            // Enclosed energy: how much of the trail's light a mask of radius
            // r would contain.
            //
            // This is the number that decides how far the mask has to reach,
            // and it is the one to trust. The reach figures above ask where the
            // mean crosses the noise, and that question is contaminated: the
            // residual is not zero at a star, because the master and the sub
            // differ slightly in PSF and registration, so a star anywhere in a
            // bin lifts that bin's mean at its own distance. Energy is
            // dominated by the bright core, so the same star contributes
            // almost nothing to it.
            //
            // Only bins inside the trail's own span are counted, which keeps
            // stars beyond the endpoints out of the total as well.
            var enclosed = new Float64Array(PERP_LIMIT + 1);
            for (d = 0; d <= PERP_LIMIT; ++d) {
               var ring = 0;
               for (b = 0; b < binCount; ++b) {
                  var c0 = (b + 0.5) * BIN_LENGTH - AXIAL_MARGIN;
                  if (c0 < 0 || c0 > len) {
                     continue;
                  }
                  ring += sums[b][d] - level * counts[b][d];
               }
               enclosed[d] = (d > 0 ? enclosed[d - 1] : 0) + ring;
            }

            var maxReach = 0, maxBin = -1;
            for (b = 0; b < binCount; ++b) {
               if (reaches[b] > maxReach) {
                  maxReach = reaches[b];
                  maxBin = b;
               }
            }
            var peakOfTrail = 0;
            for (b = 0; b < binCount; ++b) {
               if (peaks[b] > peakOfTrail) {
                  peakOfTrail = peaks[b];
               }
            }

            var name = job.file.replace(/^pct-[0-9_]*ILCE-7M3_/, "").replace(/_d_r\.xisf$/, "");
            summary.push({
               name: name, len: len, peak: peakOfTrail, sigma: sigma,
               median: medianOf(insideReaches), max: maxReach,
               maxAt: maxBin >= 0 ? ((maxBin + 0.5) * BIN_LENGTH - AXIAL_MARGIN) : 0,
               bins: reaches, binPeaks: peaks, binCount: binCount,
               enclosed: enclosed
            });
         }
      } finally {
         subWindow.forceClose();
      }
      CoreApplication.processEvents();
   }

   masterWindow.forceClose();
   log("  elapsed: " + ((Date.now() - t0) / 1000).toFixed(1) + " s");

   // --- Report -------------------------------------------------------------

   section("Reach per trail: typical against widest");
   log("  name       len   peak      sigma     median  widest  at      ratio");
   summary.sort(function (a, b) { return b.peak - a.peak; });
   for (var s = 0; s < summary.length; ++s) {
      var e = summary[s];
      log("  " + pad(e.name, 9)
          + "  " + pad(e.len.toFixed(0), 4)
          + "  " + pad(e.peak.toFixed(5), 8)
          + "  " + pad(e.sigma.toExponential(2), 9)
          + "  " + pad(e.median.toFixed(0), 6)
          + "  " + pad(e.max.toFixed(0), 6)
          + "  " + pad(e.maxAt.toFixed(0), 6)
          + "  " + pad(e.median > 0 ? (e.max / e.median).toFixed(1) : "-", 5));
   }

   section("The brightest trails, bin by bin");
   log("  A flare shows as one bin needing far more radius than its neighbours.");
   for (s = 0; s < Math.min(6, summary.length); ++s) {
      var t = summary[s];
      log("");
      log("  " + t.name + "   length " + t.len.toFixed(0)
          + " px   peak " + t.peak.toFixed(4));
      var pos = [], rch = [], pk = [];
      for (var bb = 0; bb < t.binCount; ++bb) {
         pos.push(pad(((bb + 0.5) * BIN_LENGTH - AXIAL_MARGIN).toFixed(0), 5));
         rch.push(pad(t.bins[bb].toFixed(0), 5));
         pk.push(pad(t.binPeaks[bb] > 0 ? t.binPeaks[bb].toFixed(3) : "0", 5));
      }
      log("    along axis :" + pos.join(""));
      log("    reach (px) :" + rch.join(""));
      log("    bin peak   :" + pk.join(""));
   }

   section("Enclosed energy: what fraction of the light a radius contains");
   log("");
   log("  This is the figure to size the mask by. 100% is everything within "
       + PERP_LIMIT + " px");
   log("  of the axis, over the trail's own span only.");
   log("");
   var RADII = [2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30];
   var headerRow = "  name       peak     ";
   var ri;
   for (ri = 0; ri < RADII.length; ++ri) {
      headerRow += pad(RADII[ri] + "px", 6);
   }
   log(headerRow);
   var curves = [];
   for (ri = 0; ri < RADII.length; ++ri) {
      curves.push([]);
   }
   for (s = 0; s < summary.length; ++s) {
      var en = summary[s].enclosed;
      var total = en[PERP_LIMIT];
      var row = "  " + pad(summary[s].name, 9) + "  " + pad(summary[s].peak.toFixed(5), 7) + " ";
      for (ri = 0; ri < RADII.length; ++ri) {
         var frac = total > 0 ? en[RADII[ri]] / total : 0;
         row += pad((frac * 100).toFixed(0) + "%", 6);
         if (total > 0) {
            curves[ri].push(frac);
         }
      }
      log(row);
   }
   log("");
   var medianRow = "  MEDIAN            ";
   var worstRow = "  WORST             ";
   for (ri = 0; ri < RADII.length; ++ri) {
      medianRow += pad((medianOf(curves[ri]) * 100).toFixed(0) + "%", 6);
      worstRow += pad((Math.min.apply(null, curves[ri]) * 100).toFixed(0) + "%", 6);
   }
   log(medianRow);
   log(worstRow);
   log("");
   log("  WORST is the trail that loses the most at that radius. A mask sized");
   log("  on the median would clip that one, and it is the bright ones that");
   log("  spread furthest - which is to say the ones worth keeping.");

   section("Summary");
   var medians = [], maxes = [], ratios = [];
   for (s = 0; s < summary.length; ++s) {
      medians.push(summary[s].median);
      maxes.push(summary[s].max);
      if (summary[s].median > 0) {
         ratios.push(summary[s].max / summary[s].median);
      }
   }
   log("  trails:                        " + summary.length);
   log("  median of the per-bin medians: " + medianOf(medians).toFixed(1) + " px");
   log("  median of the per-trail maxima:" + medianOf(maxes).toFixed(1) + " px");
   log("  largest single requirement:    "
       + (maxes.length ? Math.max.apply(null, maxes) : 0) + " px");
   log("  median widest/typical ratio:   " + medianOf(ratios).toFixed(1) + "x");
   log("");
   log("  If the ratio is near 1 the trail is uniform and one radius fits it,");
   log("  so the mask can simply be narrowed to the measured value. If it is");
   log("  well above 1, no constant radius is right: a value that covers the");
   log("  widest place wastes area everywhere else, and one that fits the rest");
   log("  cuts the widest place - which is the flare, the part of a meteor");
   log("  worth keeping.");

   section("Done");
   log("finished: " + (new Date()).toISOString());
   flushLog();
}

main();

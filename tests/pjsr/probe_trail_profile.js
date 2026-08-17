#engine v8

//============================================================================
// probe_trail_profile.js - How far does a meteor's light actually reach?
//
// The mask is currently sized by rule: coreScale times the measured half-width,
// plus a fixed feather. The composited meteors sit in visibly altered patches,
// which says the rule is generous, but "make it smaller" is a guess until the
// light itself is measured. So this measures the profile of the residual
//
//   residual = sub - fit(master -> sub)
//
// as a function of distance from the trail's axis, and beyond its endpoints
// along the axis. Where that profile sinks into the noise is where the mask can
// stop: past that point the mask is copying sub-frame noise into a master built
// from hundreds of frames, and buying nothing.
//
// Three numbers come out of each trail:
//
//   sigma   - the residual's noise level, taken far from the trail. This is
//             what gets added to the master everywhere the mask is open and
//             the meteor is not, so it sets the cost of an oversized mask.
//   offset  - the residual's mean far from the trail. A global linear fit
//             cannot follow a local difference in sky level between sub and
//             master, and whatever it leaves behind is painted into the result
//             in the shape of the mask. If this is negative, the mask darkens
//             the sky - which is what "the surroundings drop dark" would be.
//   reach   - the distance at which the profile falls below sigma.
//
// The endpoints are measured separately because they are not the same
// question: they are where the trail dropped below the DETECTION threshold,
// not where it stopped emitting, so the light continues past them.
//
// Run:
//   tools/run-remote.sh --pjsr tests/pjsr/probe_trail_profile.js
//============================================================================

#include "../../javascript/trail_mask.js"
#include "../../javascript/composition.js"

var DATA_ROOT = "/Volumes/Extreme SSD/pi_works/meteor-composer-test";
var GROUP = "Light_BIN-1_6024x4024_EXPOSURE-13.00s_FILTER-NoFilter_RGB";
var REGISTERED_DIR = DATA_ROOT + "/registered/" + GROUP;
var MASTER_DIR = DATA_ROOT + "/master";
var RESULTS_PATH = DATA_ROOT + "/detection_results.json";
var SESSION_PATH = DATA_ROOT + "/meteor_session.json";
var LOG_PATH = DATA_ROOT + "/probe_trail_profile.log";

var SCREEN_FACTOR = 8;

// How far out to profile, perpendicular to the axis and past the endpoints.
// Comfortably beyond the current mask's reach (8 * 2.5 + 32 at minimum), so
// that the far bins really are outside any trail light and can serve as the
// noise reference.
var PERP_LIMIT = 120;
var AXIAL_LIMIT = 120;

// Perpendicular half-width of the corridor used for the axial profile. Narrow,
// because past the endpoint we are asking about light on the axis, not around
// it.
var AXIAL_CORRIDOR = 6;

// Bins used as the noise and offset reference: far enough out that no trail
// light can be there.
var FAR_FROM = 90;

// Fit the master to the sub on a strided grid rather than every pixel. 24
// million samples are not needed to determine two coefficients, and every
// frame costs a 290 MB read already.
var FIT_STRIDE = 7;

// Exclusion radius around each trail when sampling for the fit. The trail must
// not take part in the fit that is used to remove it.
var FIT_EXCLUDE_RADIUS = 150;

var LIMIT = 0;   // 0 = every accepted meteor

var _log = [];
var _logPath = null;

function flushLog() {
   var text = _log.join("\n") + "\n";
   var candidates = _logPath !== null
      ? [_logPath]
      : [LOG_PATH, File.systemTempDirectory + "/probe_trail_profile.log"];
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

// Least-squares fit of master to sub on a strided grid, skipping anything near
// a trail.
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

// Accumulator for one profile: sum, sum of squares and count per integer bin.
// The squares are kept so that the noise can be measured per pixel. The
// scatter of the bin means would understate it by the square root of the
// samples per bin, which is a factor of about thirty here.
function newProfile(limit) {
   return { sum: new Float64Array(limit + 1),
            sumsq: new Float64Array(limit + 1),
            count: new Float64Array(limit + 1),
            limit: limit };
}

function profileMean(p, bin) {
   return p.count[bin] > 0 ? p.sum[bin] / p.count[bin] : 0;
}

// Per-pixel mean and standard deviation of the bins from `from` outwards.
// The mean is the local level error the fit left behind; the deviation is the
// noise the mask would copy into the master.
function farStatistics(p, from) {
   var sum = 0, sumsq = 0, n = 0;
   var b;
   for (b = from; b <= p.limit; ++b) {
      sum += p.sum[b];
      sumsq += p.sumsq[b];
      n += p.count[b];
   }
   var mean = n > 0 ? sum / n : 0;
   var variance = n > 0 ? sumsq / n - mean * mean : 0;
   return { mean: mean, sigma: variance > 0 ? Math.sqrt(variance) : 0, samples: n };
}

// Where the profile last stands above `level`, walking inwards from the far
// end so that a single noisy bin near the trail does not decide it.
function reachAbove(p, level) {
   for (var b = p.limit; b >= 0; --b) {
      if (profileMean(p, b) > level) {
         return b;
      }
   }
   return 0;
}

function main() {
   log("MeteorComposer trail light profile");
   log("started: " + (new Date()).toISOString());
   log("");
   log("Every value below is the residual sub - fit(master -> sub), averaged");
   log("over the three channels, in normalised [0,1] units.");

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
      var trail = {
         x0: sampleCentreToImage(c.x0, SCREEN_FACTOR),
         y0: sampleCentreToImage(c.y0, SCREEN_FACTOR),
         x1: sampleCentreToImage(c.x1, SCREEN_FACTOR),
         y1: sampleCentreToImage(c.y1, SCREEN_FACTOR),
         width: (c.minorLength || 0) * SCREEN_FACTOR
      };
      if (byFile[verdict.file] === undefined) {
         byFile[verdict.file] = { file: verdict.file, trails: [] };
         jobs.push(byFile[verdict.file]);
      }
      byFile[verdict.file].trails.push(trail);
   }
   jobs.sort(function (a, b) { return a.file < b.file ? -1 : 1; });
   if (LIMIT > 0 && jobs.length > LIMIT) {
      jobs = jobs.slice(0, LIMIT);
   }
   log("frames to profile: " + jobs.length);

   var masterPath = findMaster();
   if (masterPath === null) {
      log("[FAIL] no master found in " + MASTER_DIR);
      return;
   }
   log("master: " + masterPath);

   var masterWindow = ImageWindow.open(masterPath)[0];
   var masterImage = masterWindow.mainView.image;
   var W = masterImage.width;
   var H = masterImage.height;
   var channels = masterImage.numberOfChannels;
   var masterChannels = [];
   for (var ch = 0; ch < channels; ++ch) {
      masterChannels.push(channelToArray(masterImage, ch));
   }
   log("master read: " + W + "x" + H + " x" + channels + "ch");

   var perpReach1 = [];
   var perpReachHalf = [];
   var axialReach1 = [];
   var offsets = [];
   var sigmas = [];
   var peaks = [];
   var coreFwhm = [];

   var aggregatePerp = newProfile(PERP_LIMIT);
   var aggregateAxial = newProfile(AXIAL_LIMIT);

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
            log("  [SKIP] " + job.file + " geometry mismatch");
            continue;
         }

         // Residual for each channel, kept only inside the region of interest.
         var fits = [];
         var subChannels = [];
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

            var perp = newProfile(PERP_LIMIT);
            var axial = newProfile(AXIAL_LIMIT);

            var reach = PERP_LIMIT + AXIAL_LIMIT;
            var left = Math.max(0, Math.floor(Math.min(trail.x0, trail.x1) - reach));
            var right = Math.min(W - 1, Math.ceil(Math.max(trail.x0, trail.x1) + reach));
            var top = Math.max(0, Math.floor(Math.min(trail.y0, trail.y1) - reach));
            var bottom = Math.min(H - 1, Math.ceil(Math.max(trail.y0, trail.y1) + reach));

            var peak = 0;

            for (var y = top; y <= bottom; ++y) {
               var rowBase = y * W;
               for (var x = left; x <= right; ++x) {
                  // Axial and perpendicular coordinates relative to the trail.
                  var rx = x - trail.x0;
                  var ry = y - trail.y0;
                  var along = rx * ux + ry * uy;
                  var across = Math.abs(rx * uy - ry * ux);

                  var value = 0;
                  var idx = rowBase + x;
                  for (var cc = 0; cc < channels; ++cc) {
                     value += subChannels[cc][idx]
                            - (fits[cc].scale * masterChannels[cc][idx] + fits[cc].offset);
                  }
                  value /= channels;

                  if (along >= 0 && along <= len) {
                     if (across <= PERP_LIMIT) {
                        var pb = Math.floor(across);
                        perp.sum[pb] += value;
                        perp.sumsq[pb] += value * value;
                        perp.count[pb] += 1;
                        aggregatePerp.sum[pb] += value;
                        aggregatePerp.sumsq[pb] += value * value;
                        aggregatePerp.count[pb] += 1;
                        if (value > peak) {
                           peak = value;
                        }
                     }
                  } else if (across <= AXIAL_CORRIDOR) {
                     var over = along < 0 ? -along : along - len;
                     if (over <= AXIAL_LIMIT) {
                        var ab = Math.floor(over);
                        axial.sum[ab] += value;
                        axial.sumsq[ab] += value * value;
                        axial.count[ab] += 1;
                        aggregateAxial.sum[ab] += value;
                        aggregateAxial.sumsq[ab] += value * value;
                        aggregateAxial.count[ab] += 1;
                     }
                  }
               }
            }

            // Noise and local offset, from far out where no trail light is.
            var far = farStatistics(perp, FAR_FROM);
            var offset = far.mean;
            var sigma = far.sigma;

            var levelOne = offset + sigma;
            var levelHalf = offset + sigma / 2;
            var r1 = reachAbove(perp, levelOne);
            var rHalf = reachAbove(perp, levelHalf);
            var a1 = reachAbove(axial, levelOne);

            // Half-maximum width of the core, as a description of the trail
            // itself rather than of the mask.
            var half = reachAbove(perp, offset + (peak - offset) / 2);

            perpReach1.push(r1);
            perpReachHalf.push(rHalf);
            axialReach1.push(a1);
            offsets.push(offset);
            sigmas.push(sigma);
            peaks.push(peak);
            coreFwhm.push(half);

            log("  [" + (k + 1) + "/" + jobs.length + "] " + job.file
                + "  len=" + len.toFixed(0)
                + "  peak=" + peak.toFixed(5)
                + "  sigma=" + sigma.toExponential(2)
                + "  offset=" + offset.toExponential(2)
                + "  half-max=" + half + "px"
                + "  reach(1s)=" + r1 + "px"
                + "  reach(.5s)=" + rHalf + "px"
                + "  axial(1s)=" + a1 + "px");
         }

         subChannels = null;
      } finally {
         subWindow.forceClose();
      }
      CoreApplication.processEvents();
   }

   masterWindow.forceClose();

   log("");
   log("  elapsed: " + ((Date.now() - t0) / 1000).toFixed(1) + " s");

   // --- Aggregate ----------------------------------------------------------

   section("Perpendicular profile, all trails together");
   log("  distance   mean residual    x sigma");
   var aggFar = farStatistics(aggregatePerp, FAR_FROM);
   var aggSigma = medianOf(sigmas);
   var bins = [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 60, 80, 100, 120];
   for (var bi = 0; bi < bins.length; ++bi) {
      var bb = bins[bi];
      if (bb > PERP_LIMIT) {
         continue;
      }
      var mean = profileMean(aggregatePerp, bb) - aggFar.mean;
      log("  " + pad(bb, 8) + "   " + pad(mean.toExponential(3), 13)
          + "   " + pad(aggSigma > 0 ? (mean / aggSigma).toFixed(2) : "-", 8));
   }

   section("Axial profile past the endpoints, all trails together");
   log("  overshoot  mean residual    x sigma");
   var aggFarAxial = farStatistics(aggregateAxial, FAR_FROM);
   for (var bj = 0; bj < bins.length; ++bj) {
      var bc = bins[bj];
      if (bc > AXIAL_LIMIT) {
         continue;
      }
      var meanA = profileMean(aggregateAxial, bc) - aggFarAxial.mean;
      log("  " + pad(bc, 8) + "   " + pad(meanA.toExponential(3), 13)
          + "   " + pad(aggSigma > 0 ? (meanA / aggSigma).toFixed(2) : "-", 8));
   }

   section("Summary");
   log("  trails profiled:            " + peaks.length);
   log("  median half-max radius:     " + medianOf(coreFwhm).toFixed(1) + " px");
   log("  median reach at 1 sigma:    " + medianOf(perpReach1).toFixed(1) + " px");
   log("  median reach at 0.5 sigma:  " + medianOf(perpReachHalf).toFixed(1) + " px");
   log("  median axial reach at 1 s:  " + medianOf(axialReach1).toFixed(1) + " px");
   log("  median residual sigma:      " + medianOf(sigmas).toExponential(3));
   log("  median local offset:        " + medianOf(offsets).toExponential(3));
   log("  most negative local offset: " + minOf(offsets).toExponential(3));
   log("  most positive local offset: " + maxOf(offsets).toExponential(3));
   log("");
   log("  The reach figures are where the trail's light sinks into the noise.");
   log("  A mask wider than that adds noise and nothing else. The offset");
   log("  figures are the level error a global fit leaves behind: whatever");
   log("  sign they have, the mask paints them into the result in its own");
   log("  shape, and that is a mask-shaped patch of altered sky whatever the");
   log("  mask's size.");

   section("Done");
   log("finished: " + (new Date()).toISOString());
   flushLog();
}

function medianOf(values) {
   if (values.length === 0) {
      return 0;
   }
   var s = values.slice().sort(function (a, b) { return a - b; });
   var mid = s.length >> 1;
   return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function minOf(values) {
   var m = Infinity;
   for (var i = 0; i < values.length; ++i) {
      if (values[i] < m) {
         m = values[i];
      }
   }
   return values.length ? m : 0;
}

function maxOf(values) {
   var m = -Infinity;
   for (var i = 0; i < values.length; ++i) {
      if (values[i] > m) {
         m = values[i];
      }
   }
   return values.length ? m : 0;
}

main();

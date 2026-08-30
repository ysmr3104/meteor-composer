//============================================================================
// evaluate.js - Score a detection run against the ground truth
//
// Run: node tests/eval/evaluate.js [results.json] [ground_truth.json]
//
// This is EVALUATION, not a test (docs/tests.md section 5). It reports metrics
// and compares them with a baseline; it does not assert correctness of the
// code. Detection thresholds cannot be verified by unit tests.
//
// Scoring rules, from docs/tests.md 5-3-1:
//   - Recall over the labelled meteors is the hard gate.
//   - Detections on unlabelled frames are NOT false positives. The labels come
//     from visual inspection and are known to have misses, so those are
//     reported as "needs review" only.
//============================================================================

var fs = require("fs");
var path = require("path");

var DEFAULT_RESULTS = "/Volumes/Extreme SSD/pi_works/meteor-composer-test/test-sky/detection_results.json";
var DEFAULT_GT = path.join(__dirname, "ground_truth.json");
var BASELINE_PATH = path.join(__dirname, "baseline.json");

// The reason given for accepting a lower recall, or null if none was.
//
// Required to be non-empty: the point of the flag is the reason, not the
// permission. "--accept-regression" on its own is refused.
function acceptedRegressionReason() {
   var args = process.argv.slice(2);
   for (var i = 0; i < args.length; ++i) {
      if (args[i] === "--accept-regression") {
         console.error("--accept-regression needs a reason: "
                       + "--accept-regression=\"why this is not a defect\"");
         process.exit(2);
      }
      if (args[i].indexOf("--accept-regression=") === 0) {
         var reason = args[i].slice("--accept-regression=".length).trim();
         if (reason.length === 0) {
            console.error("--accept-regression needs a reason, not an empty one.");
            process.exit(2);
         }
         return reason;
      }
   }
   return null;
}

// Flags must not be mistaken for positional paths.
function positionalArgs() {
   return process.argv.slice(2).filter(function (a) { return a.indexOf("-") !== 0; });
}

function main() {
   var positional = positionalArgs();
   var resultsPath = positional[0] || DEFAULT_RESULTS;
   var gtPath = positional[1] || DEFAULT_GT;

   if (!fs.existsSync(resultsPath)) {
      console.error("results not found: " + resultsPath);
      process.exit(2);
   }
   var results = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
   var gt = JSON.parse(fs.readFileSync(gtPath, "utf8"));

   // A cancelled detection produces a perfectly ordinary-looking results file
   // holding only the frames it got to. Scored as though it were complete, the
   // recall it reports is really a measure of how far the run got - and it
   // would look like a regression in the detector.
   if (results.cancelled) {
      console.error("");
      console.error("*** This detection was CANCELLED: "
                    + results.frames.length + " of "
                    + (results.framesRequested || "?") + " frames were examined.");
      console.error("*** Recall below is not comparable with a complete run.");
      console.error("");
   }

   var labelled = {};
   gt.meteors.forEach(function (m) { labelled[m.file] = m; });
   var uncertain = {};
   (gt.uncertain || []).forEach(function (m) { uncertain[m.file] = m; });

   // Labels come from two places and they do not mean the same thing.
   //
   //   visual    - found by eye in the JPGs, without seeing the detector's
   //               output. Independent of the detector, so recall over these
   //               measures detection ability. This is the hard gate.
   //   screening - found by working through the detector's own candidate list
   //               in the UI. Recall over these is 100% by construction: every
   //               one of them was, by definition, detected. Useful as a
   //               regression net - losing one is a real regression - but it
   //               measures nothing about detection ability.
   //
   // Reporting a single combined recall would quietly turn the gate into a
   // tautology, which is exactly the failure docs/tests.md 5-2 warns about.
   var visualFiles = {};
   var screeningFiles = {};
   gt.meteors.forEach(function (m) {
      // Labels written before provenance was recorded are visual: the
      // screening UI did not exist yet.
      if (m.labelled_by === "screening") {
         screeningFiles[m.file] = m;
      } else {
         visualFiles[m.file] = m;
      }
   });

   // Candidates the screening pass judged not-a-meteor, keyed per candidate.
   // Entries written before the UI recorded indexInFrame have no index; those
   // are ignored here rather than being taken to cover a whole frame.
   var judgedNegative = {};
   (gt.known_false_positives || []).forEach(function (m) {
      if (m.indexInFrame !== undefined) {
         judgedNegative[m.file + ":" + m.indexInFrame] = true;
      }
   });

   var detected = [];
   var missed = [];
   var needsReview = [];
   var errors = [];
   var candidateTotal = 0;
   var framesProcessed = 0;

   results.frames.forEach(function (f) {
      if (f.error) {
         errors.push(f);
         return;
      }
      ++framesProcessed;
      var n = f.candidates ? f.candidates.length : 0;
      candidateTotal += n;

      if (labelled[f.file]) {
         if (n > 0) {
            detected.push({ file: f.file, candidates: f.candidates });
         } else {
            missed.push({ file: f.file, sigma: f.sigma, componentCount: f.componentCount });
         }
         return;
      }
      if (uncertain[f.file]) {
         return;
      }

      // "Needs review" means nobody has looked at it yet. Once the screening
      // pass has judged a candidate not-a-meteor it is reviewed, and counting
      // it here would report work as outstanding that is already done. The
      // match is per candidate, not per frame: a frame can hold both a
      // judged candidate and a new one.
      var outstanding = [];
      for (var i = 0; i < n; ++i) {
         if (!judgedNegative[f.file + ":" + i]) {
            outstanding.push(f.candidates[i]);
         }
      }
      if (outstanding.length > 0) {
         needsReview.push({ file: f.file, candidates: outstanding });
      }
   });

   var recall = gt.meteors.length > 0 ? detected.length / gt.meteors.length : 0;

   function tally(set) {
      var found = 0, total = 0, missedFiles = [];
      for (var file in set) {
         ++total;
         var hit = false;
         for (var i = 0; i < detected.length; ++i) {
            if (detected[i].file === file) {
               hit = true;
               break;
            }
         }
         if (hit) {
            ++found;
         } else {
            missedFiles.push(file);
         }
      }
      return { found: found, total: total, missed: missedFiles,
               rate: total > 0 ? found / total : 0 };
   }

   var visual = tally(visualFiles);
   var screening = tally(screeningFiles);

   console.log("=========================================================");
   console.log(" MeteorComposer detection evaluation");
   console.log("=========================================================");
   console.log("session:          " + gt.session);
   console.log("results:          " + resultsPath);
   console.log("generated:        " + results.generated);
   console.log("options:          " + JSON.stringify(results.options));
   console.log("");
   console.log("frames processed: " + framesProcessed
               + (errors.length ? ("  (errors: " + errors.length + ")") : ""));
   console.log("elapsed:          " + (results.elapsedMs / 1000).toFixed(1) + " s"
               + "  (" + (results.elapsedMs / Math.max(1, framesProcessed)).toFixed(0) + " ms/frame)");
   console.log("");
   console.log("--- HARD GATE: detector-independent labels -----------");
   console.log("visual recall:    " + visual.found + " / " + visual.total
               + "  (" + (visual.rate * 100).toFixed(1) + "%)");
   console.log("  These were found by eye without seeing the detector's");
   console.log("  output, so this number measures detection ability.");
   if (visual.missed.length > 0) {
      console.log("  MISSED:");
      visual.missed.forEach(function (f) {
         console.log("    - " + f);
      });
   }
   console.log("");
   console.log("--- REGRESSION NET: labels from the screening UI -----");
   console.log("screening recall: " + screening.found + " / " + screening.total
               + "  (" + (screening.rate * 100).toFixed(1) + "%)");
   console.log("  100% by construction - every one of these was picked out of");
   console.log("  the detector's own candidate list. It measures nothing about");
   console.log("  detection ability; it only catches losing one later.");
   if (screening.missed.length > 0) {
      console.log("  REGRESSION - these were detected once and are not now:");
      screening.missed.forEach(function (f) {
         console.log("    - " + f);
      });
   }
   console.log("");
   console.log("combined:         " + detected.length + " / " + gt.meteors.length
               + "  (" + (recall * 100).toFixed(1) + "%)"
               + "   <- do not quote this as recall");
   if (missed.length > 0) {
      console.log("MISSED (all labels):");
      missed.forEach(function (m) {
         console.log("  - " + m.file + "   sigma=" + fmt(m.sigma)
                     + " components=" + m.componentCount);
      });
   }
   console.log("");
   console.log("--- REPORT ONLY -------------------------------------");
   console.log("total candidates: " + candidateTotal);
   console.log("known false pos:  " + (gt.known_false_positives || []).length
               + "   (judged not-a-meteor in the screening UI)");
   console.log("needs review:     " + needsReview.length + " frames"
               + "   (candidates nobody has judged yet; NOT false positives)");

   if (detected.length > 0) {
      console.log("");
      console.log("--- Detected meteors --------------------------------");
      detected.forEach(function (d) {
         var best = d.candidates.slice().sort(function (a, b) { return b.length - a.length; })[0];
         console.log("  " + d.file);
         console.log("      n=" + d.candidates.length
                     + " len=" + fmt(best.length)
                     + " angle=" + fmt(best.angle)
                     + " elong=" + fmt(best.elongation)
                     + " px=" + best.pixelCount);
      });
   }

   if (needsReview.length > 0) {
      console.log("");
      console.log("--- Needs review (top 20 by trail length) -----------");
      var flat = [];
      needsReview.forEach(function (r) {
         r.candidates.forEach(function (c) {
            flat.push({ file: r.file, c: c });
         });
      });
      flat.sort(function (a, b) { return b.c.length - a.c.length; });
      flat.slice(0, 20).forEach(function (item) {
         console.log("  " + item.file
                     + "  len=" + fmt(item.c.length)
                     + " angle=" + fmt(item.c.angle)
                     + " elong=" + fmt(item.c.elongation)
                     + " px=" + item.c.pixelCount);
      });
   }

   var summary = {
      generated: results.generated,
      options: results.options,
      framesProcessed: framesProcessed,
      labelledMeteors: gt.meteors.length,
      detected: detected.length,
      recall: recall,
      visualLabels: visual.total,
      visualDetected: visual.found,
      visualRecall: visual.rate,
      screeningLabels: screening.total,
      screeningDetected: screening.found,
      screeningRecall: screening.rate,
      knownFalsePositives: (gt.known_false_positives || []).length,
      totalCandidates: candidateTotal,
      needsReviewFrames: needsReview.length,
      msPerFrame: results.elapsedMs / Math.max(1, framesProcessed),
      // Which labels are not being detected. Carried in the baseline so that an
      // accepted regression names the frame it gave up, rather than only the
      // count.
      missedFiles: visual.missed.concat(screening.missed)
   };

   compareBaseline(summary);
}

function compareBaseline(summary) {
   console.log("");
   console.log("--- Baseline ----------------------------------------");
   if (!fs.existsSync(BASELINE_PATH)) {
      console.log("no baseline yet. To record this run as the baseline:");
      console.log("  node tests/eval/evaluate.js --save-baseline");
      if (process.argv.indexOf("--save-baseline") >= 0) {
         fs.writeFileSync(BASELINE_PATH, JSON.stringify(summary, null, 2) + "\n");
         console.log("baseline written: " + BASELINE_PATH);
      }
      return;
   }
   var base = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
   console.log("baseline recall:  " + base.detected + " / " + base.labelledMeteors);
   console.log("current recall:   " + summary.detected + " / " + summary.labelledMeteors);

   if (summary.detected < base.detected) {
      // A dropped recall fails, and --save-baseline cannot quietly lower the
      // bar: the exit is above the write. That guard stays.
      //
      // But a regression is not always a defect. It happened once for a real
      // reason: a frame's candidate had only ever been found because the robust
      // statistics were corrupted by the exact zeros that registration leaves
      // outside the frame, so its threshold was 2.6 times lower than the sky
      // warranted. Fixing that lost the candidate. Nothing about the detector
      // got worse; an accident stopped happening.
      //
      // So there is a way to accept one, and it costs something to use: a
      // reason, written into the baseline where the next reader will find it.
      // Without that the file would say 30 and nobody would know why.
      var accepted = acceptedRegressionReason();
      if (accepted === null) {
         console.log("");
         console.log("*** REGRESSION: recall dropped from " + base.detected
                     + " to " + summary.detected + ". This is an immediate NG.");
         console.log("    A tolerance band does not make this acceptable.");
         console.log("");
         console.log("    If this is deliberate and understood, record why:");
         console.log("      node tests/eval/evaluate.js --accept-regression=\"...\"");
         process.exit(1);
      }
      console.log("");
      console.log("*** REGRESSION ACCEPTED: recall " + base.detected + " -> "
                  + summary.detected);
      console.log("    reason: " + accepted);
      summary.acceptedRegression = {
         from: base.detected,
         to: summary.detected,
         reason: accepted,
         at: summary.generated,
         lostLabels: summary.missedFiles || []
      };
      fs.writeFileSync(BASELINE_PATH, JSON.stringify(summary, null, 2) + "\n");
      console.log("baseline updated, with the reason recorded in it.");
      return;
   }
   if (summary.detected > base.detected) {
      console.log("");
      console.log("IMPROVED: recall rose from " + base.detected + " to " + summary.detected + ".");
      console.log("Update the baseline once the new detections are confirmed:");
      console.log("  node tests/eval/evaluate.js --save-baseline");
      if (process.argv.indexOf("--save-baseline") >= 0) {
         fs.writeFileSync(BASELINE_PATH, JSON.stringify(summary, null, 2) + "\n");
         console.log("baseline updated.");
      }
      return;
   }
   console.log("recall unchanged.");
   if (process.argv.indexOf("--save-baseline") >= 0) {
      fs.writeFileSync(BASELINE_PATH, JSON.stringify(summary, null, 2) + "\n");
      console.log("baseline updated.");
   }
}

function fmt(v) {
   if (v === undefined || v === null) {
      return "?";
   }
   if (!isFinite(v)) {
      return "inf";
   }
   return (typeof v === "number") ? v.toFixed(1) : ("" + v);
}

main();

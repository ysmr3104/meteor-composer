//============================================================================
// test_session_model.js - Small tests for the screening session state
//
// Run: node tests/ut/test_session_model.js
//
// The rules under test are the ones that decide whether the evaluation is
// honest: what the ground-truth mode is allowed to show, how `uncertain` is
// kept separate, and whether saved verdicts survive a rerun. Those are policy
// from docs/tests.md 5-2 and 5-4, so they get asserted rather than trusted to
// dialog code.
//============================================================================

var model = require("../../javascript/session_model.js");
var ops = require("../../javascript/candidate_ops.js");

var passed = 0;
var failed = 0;
var failures = [];

function ok(condition, message) {
   if (condition) {
      ++passed;
   } else {
      ++failed;
      failures.push(message);
      console.log("  FAIL: " + message);
   }
}

function close(actual, expected, tolerance, message) {
   var diff = Math.abs(actual - expected);
   ok(diff <= tolerance,
      message + " (expected " + expected + ", got " + actual + ", diff " + diff + ")");
}

function suite(name, fn) {
   console.log("\n=== " + name + " ===");
   fn();
}

var V = model.VERDICT;
var M = model.MODE;

// A candidate in detection samples.
function cand(x0, y0, x1, y1, extra) {
   var dx = x1 - x0, dy = y1 - y0;
   var c = {
      cx: (x0 + x1) / 2, cy: (y0 + y1) / 2,
      x0: x0, y0: y0, x1: x1, y1: y1,
      length: Math.sqrt(dx * dx + dy * dy),
      angle: 0,
      elongation: 20,
      pixelCount: 50,
      bbox: {
         left: Math.min(x0, x1), top: Math.min(y0, y1),
         right: Math.max(x0, x1), bottom: Math.max(y0, y1),
         width: Math.abs(dx) + 1, height: Math.abs(dy) + 1
      }
   };
   if (extra) {
      for (var k in extra) {
         c[k] = extra[k];
      }
   }
   return c;
}

// A detection_results.json-shaped payload.
function results(frames) {
   return {
      group: "TestGroup",
      screenFactor: 8,
      options: { k: 5.0 },
      frames: frames
   };
}

function frame(file, candidates) {
   return { file: file, width: 753, height: 503, candidates: candidates };
}

//----------------------------------------------------------------------------

suite("buildRows: one row per candidate, flat", function () {
   var r = results([
      frame("a.xisf", [cand(0, 0, 10, 0), cand(20, 20, 30, 20)]),
      frame("b.xisf", []),
      frame("c.xisf", [cand(5, 5, 15, 5)])
   ]);
   var rows = model.buildRows(r);

   ok(rows.length === 3, "three candidates across three frames");
   ok(rows[0].file === "a.xisf" && rows[1].file === "a.xisf",
      "both candidates of a frame appear as separate rows");
   ok(rows[2].file === "c.xisf", "empty frames contribute no rows");

   // frameIndex is the position in the frame list, which is capture order.
   // The empty frame still occupies index 1, so c.xisf is 2.
   ok(rows[2].frameIndex === 2, "frameIndex counts frames, not rows");
   ok(rows[0].indexInFrame === 0 && rows[1].indexInFrame === 1,
      "indexInFrame distinguishes candidates within a frame");

   ok(rows[0].id === 0 && rows[1].id === 1 && rows[2].id === 2, "ids are sequential");
   ok(rows[0].verdict === V.UNREVIEWED, "rows start unreviewed");
});

suite("verdicts", function () {
   var s = model.createSession(results([frame("a.xisf", [cand(0, 0, 10, 0)])]));
   ok(model.setVerdict(s, 0, V.METEOR), "setting a verdict succeeds");
   ok(s.rows[0].verdict === V.METEOR, "the verdict is stored");
   ok(!model.setVerdict(s, 99, V.METEOR), "an unknown id fails rather than throwing");

   var threw = false;
   try {
      model.setVerdict(s, 0, "probably");
   } catch (e) {
      threw = true;
   }
   ok(threw, "an unknown verdict is rejected");

   // Four states, not two. A checkbox cannot carry `uncertain`, which
   // docs/tests.md 5-4 requires be excluded from the denominator.
   ok(model.VERDICT_ORDER.length === 4, "there are exactly four verdicts");
   ok(model.isValidVerdict(V.UNCERTAIN), "uncertain is a first-class verdict");
});

suite("summarize", function () {
   var s = model.createSession(results([
      frame("a.xisf", [cand(0, 0, 10, 0), cand(1, 1, 11, 1)]),
      frame("b.xisf", [cand(2, 2, 12, 2), cand(3, 3, 13, 3)])
   ]));
   model.setVerdict(s, 0, V.METEOR);
   model.setVerdict(s, 1, V.NOT_METEOR);
   model.setVerdict(s, 2, V.UNCERTAIN);

   var sum = model.summarize(s);
   ok(sum.total === 4, "total counts every candidate");
   ok(sum.counts[V.METEOR] === 1, "one meteor");
   ok(sum.counts[V.NOT_METEOR] === 1, "one not-meteor");
   ok(sum.counts[V.UNCERTAIN] === 1, "one uncertain");
   ok(sum.counts[V.UNREVIEWED] === 1, "one still unreviewed");

   // `uncertain` counts as reviewed for the work queue even though the
   // evaluation drops it: the operator has looked at it and moved on.
   ok(sum.reviewed === 3, "uncertain counts as reviewed for progress");
});

suite("navigation", function () {
   var s = model.createSession(results([
      frame("a.xisf", [cand(0, 0, 10, 0), cand(1, 1, 11, 1), cand(2, 2, 12, 2)])
   ]));
   var rows = s.rows;

   ok(model.nextUnreviewed(rows, 0) === 0, "finds the first unreviewed");
   model.setVerdict(s, 0, V.METEOR);
   ok(model.nextUnreviewed(rows, 0) === 1, "skips a judged row");
   model.setVerdict(s, 1, V.UNCERTAIN);
   model.setVerdict(s, 2, V.NOT_METEOR);
   ok(model.nextUnreviewed(rows, 0) === -1, "returns -1 when everything is judged");

   // Stepping stops at the ends rather than wrapping: wrapping would send the
   // operator back to the top without them noticing.
   ok(model.step(rows, 0, -1) === 0, "stepping back from the first stays put");
   ok(model.step(rows, 2, 1) === 2, "stepping past the last stays put");
   ok(model.step(rows, 1, 1) === 2, "stepping forward advances");
   ok(model.step([], 0, 1) === -1, "an empty list yields -1");
});

suite("filtering: screening mode narrows, ground-truth mode never does", function () {
   var s = model.createSession(results([
      frame("a.xisf", [cand(0, 0, 10, 0), cand(1, 1, 11, 1)])
   ]), M.SCREENING);
   s.rows[0].persistent = true;

   var filtered = model.filterRows(s, { hidePersistent: true });
   ok(filtered.length === 1, "screening mode can hide persistent tracks");
   ok(filtered[0].id === 1, "the non-persistent row survives");

   ok(model.filterRows(s, null).length === 2, "no filter shows everything");

   var byVerdict = model.filterRows(s, { verdicts: [V.UNREVIEWED] });
   ok(byVerdict.length === 2, "filtering by verdict works in screening mode");

   // docs/tests.md 5-2: building the ground truth only from what the
   // operational settings surfaced makes recall a tautology, so the
   // ground-truth mode ignores filters entirely rather than trusting the UI
   // not to pass one.
   var gt = model.createSession(results([
      frame("a.xisf", [cand(0, 0, 10, 0), cand(1, 1, 11, 1)])
   ]), M.GROUND_TRUTH);
   gt.rows[0].persistent = true;
   ok(model.filterRows(gt, { hidePersistent: true }).length === 2,
      "ground-truth mode shows every candidate even when a filter is passed");
   ok(!model.modeAllowsFiltering(M.GROUND_TRUTH), "ground-truth mode reports no filtering");
   ok(!model.modeShowsScores(M.GROUND_TRUTH), "ground-truth mode reports no scores");
   ok(model.defaultSortKey(M.GROUND_TRUTH) === "frameIndex",
      "ground-truth mode defaults to capture order, not score order");
   ok(model.defaultSortKey(M.SCREENING) === "score",
      "screening mode defaults to score order");
});

suite("sorting", function () {
   var s = model.createSession(results([
      frame("a.xisf", [cand(0, 0, 30, 0)]),
      frame("b.xisf", [cand(0, 0, 10, 0)]),
      frame("c.xisf", [cand(0, 0, 20, 0)])
   ]), M.SCREENING);

   var byLength = model.sortRows(s, s.rows, "length", true);
   close(byLength[0].candidate.length, 10, 1e-9, "shortest first ascending");
   close(byLength[2].candidate.length, 30, 1e-9, "longest last ascending");

   var desc = model.sortRows(s, s.rows, "length", false);
   close(desc[0].candidate.length, 30, 1e-9, "longest first descending");

   // Sorting must not mutate the session's own order.
   ok(s.rows[0].file === "a.xisf", "sortRows leaves the session order alone");

   // Ties fall back to id so repeated sorts are stable.
   var tied = model.createSession(results([
      frame("a.xisf", [cand(0, 0, 10, 0), cand(0, 0, 10, 0), cand(0, 0, 10, 0)])
   ]), M.SCREENING);
   var t = model.sortRows(tied, tied.rows, "length", true);
   ok(t[0].id === 0 && t[1].id === 1 && t[2].id === 2, "ties keep id order");

   // Asking for score order in ground-truth mode must not produce score
   // order; it falls back rather than throwing, so a caller cannot
   // reintroduce the ordering nudge by accident.
   var gt = model.createSession(results([
      frame("z.xisf", [cand(0, 0, 10, 0)]),
      frame("a.xisf", [cand(0, 0, 30, 0)])
   ]), M.GROUND_TRUTH);
   gt.rows[0].score = 99;
   gt.rows[1].score = 1;
   var gtSorted = model.sortRows(gt, gt.rows, "score", true);
   ok(gtSorted[0].file === "z.xisf",
      "ground-truth mode ignores a score sort and stays in capture order");
});

suite("applyTracks", function () {
   var c1 = cand(0, 0, 10, 0);
   var c2 = cand(1, 1, 11, 1);
   var c3 = cand(2, 2, 12, 2);
   var r = results([
      frame("a.xisf", [c1]),
      frame("b.xisf", [c2]),
      frame("c.xisf", [c3])
   ]);
   var s = model.createSession(r);

   var tracks = ops.matchAcrossFrames([
      { file: "a.xisf", candidates: [c1] },
      { file: "b.xisf", candidates: [c2] },
      { file: "c.xisf", candidates: [c3] }
   ], null);

   model.applyTracks(s.rows, tracks);

   // These three sit on a smoothly moving path across three consecutive
   // frames, which is the satellite signature: longer than the two frames a
   // meteor can straddle (docs/requirements.md 6.1).
   ok(s.rows[0].trackLength === 3, "track length is carried onto the row");
   ok(s.rows[0].persistent, "a three-frame track is marked persistent");
   ok(s.rows[0].trackId === s.rows[2].trackId, "members share a track id");

   // An isolated candidate is a one-frame track and must not be flagged.
   var lone = cand(500, 400, 510, 400);
   var s2 = model.createSession(results([frame("x.xisf", [lone])]));
   model.applyTracks(s2.rows, ops.matchAcrossFrames(
      [{ file: "x.xisf", candidates: [lone] }], null));
   ok(s2.rows[0].trackLength === 1, "a lone candidate is a one-frame track");
   ok(!s2.rows[0].persistent, "a one-frame track is not persistent");

   // matchAcrossFrames numbers frames by their position in the array it is
   // given. If the caller drops empty frames, those numbers no longer line up
   // with results.frames. Matching on candidate identity has to survive that,
   // otherwise track flags would land on the wrong rows.
   var e1 = cand(0, 0, 10, 0);
   var e2 = cand(1, 1, 11, 1);
   var e3 = cand(2, 2, 12, 2);
   var withGaps = model.createSession(results([
      frame("p.xisf", []),
      frame("q.xisf", [e1]),
      frame("r.xisf", [e2]),
      frame("s.xisf", []),
      frame("t.xisf", [e3])
   ]));
   // Only the non-empty frames are handed to the matcher, so its indices are
   // 0/1/2 while the rows sit at frame indices 1/2/4.
   model.applyTracks(withGaps.rows, ops.matchAcrossFrames([
      { file: "q.xisf", candidates: [e1] },
      { file: "r.xisf", candidates: [e2] },
      { file: "t.xisf", candidates: [e3] }
   ], null));
   ok(withGaps.rows.length === 3, "empty frames contribute no rows");
   ok(withGaps.rows[0].trackLength === 3,
      "track data lands correctly despite mismatched frame numbering");
   ok(withGaps.rows[0].file === "q.xisf" && withGaps.rows[2].file === "t.xisf",
      "the rows it landed on are the right ones");
});

suite("session JSON round trip", function () {
   var r = results([
      frame("a.xisf", [cand(0, 0, 10, 0), cand(1, 1, 11, 1)]),
      frame("b.xisf", [cand(2, 2, 12, 2)])
   ]);
   var s = model.createSession(r, M.SCREENING);
   model.setVerdict(s, 0, V.METEOR);
   model.setVerdict(s, 2, V.UNCERTAIN);

   var saved = JSON.parse(JSON.stringify(model.toSessionJSON(s)));
   ok(saved.verdicts.length === 2, "only judged rows are stored");
   ok(saved.mode === M.SCREENING, "the mode is recorded");

   // Restore onto a fresh session built from the same detection results.
   var s2 = model.createSession(r, M.SCREENING);
   var out = model.applySessionJSON(s2, saved);
   ok(out.restored === 2, "both verdicts are restored");
   ok(out.orphans.length === 0, "nothing is orphaned on an identical rerun");
   ok(s2.rows[0].verdict === V.METEOR, "the meteor verdict came back");
   ok(s2.rows[2].verdict === V.UNCERTAIN, "the uncertain verdict came back");
   ok(s2.rows[1].verdict === V.UNREVIEWED, "untouched rows stay unreviewed");

   // Verdicts are keyed by file and position, not by row id, so a rerun that
   // finds a different number of candidates in an earlier frame does not
   // shift everything. Here the first frame loses a candidate.
   var shifted = model.createSession(results([
      frame("a.xisf", [cand(0, 0, 10, 0)]),
      frame("b.xisf", [cand(2, 2, 12, 2)])
   ]), M.SCREENING);
   var out2 = model.applySessionJSON(shifted, saved);
   ok(shifted.rows[1].verdict === V.UNCERTAIN,
      "b.xisf keeps its verdict even though ids shifted");
   ok(out2.restored === 2, "both still land");

   // A verdict whose candidate no longer exists is reported, not dropped
   // silently: that count is how the operator learns how much work no longer
   // applies after a parameter change.
   var narrower = model.createSession(results([frame("a.xisf", [cand(0, 0, 10, 0)])]),
                                      M.SCREENING);
   var out3 = model.applySessionJSON(narrower, saved);
   ok(out3.restored === 1, "one verdict still applies");
   ok(out3.orphans.length === 1, "the vanished candidate is reported as an orphan");
   ok(out3.orphans[0].file === "b.xisf", "the orphan names its frame");

   // Corrupt entries are treated as orphans rather than throwing.
   var out4 = model.applySessionJSON(model.createSession(r),
                                     { verdicts: [{ file: "a.xisf", indexInFrame: 0,
                                                    verdict: "nonsense" }] });
   ok(out4.orphans.length === 1, "an invalid verdict is orphaned, not applied");

   ok(model.applySessionJSON(model.createSession(r), null).restored === 0,
      "a null payload restores nothing and does not throw");
});

suite("ground truth export", function () {
   var s = model.createSession(results([
      frame("a.xisf", [cand(10, 20, 12, 21), cand(30, 30, 40, 30)]),
      frame("b.xisf", [cand(5, 5, 15, 5)]),
      frame("c.xisf", [cand(7, 7, 17, 7)])
   ]), M.GROUND_TRUTH);

   model.setVerdict(s, 0, V.METEOR);
   model.setVerdict(s, 1, V.NOT_METEOR);
   model.setVerdict(s, 2, V.UNCERTAIN);
   // row 3 stays unreviewed

   var gt = model.toGroundTruth(s, { session: "test", frameCount: 3 }, 8, 8);

   ok(gt.meteors.length === 1, "one meteor");
   ok(gt.known_false_positives.length === 1, "one known false positive");
   ok(gt.uncertain.length === 1, "one uncertain");
   ok(gt.registered_group === "TestGroup", "the group is carried through");
   ok(gt.frame_count === 3, "the frame count comes from the metadata");

   // Unreviewed rows appear nowhere: an unexamined candidate is not evidence
   // of anything.
   var allFiles = [];
   ["meteors", "known_false_positives", "uncertain"].forEach(function (k) {
      gt[k].forEach(function (e) { allFiles.push(e.file); });
   });
   ok(allFiles.indexOf("c.xisf") === -1, "unreviewed candidates are not exported");

   // Coordinates are full-resolution and use the centre mapping, so they can
   // be compared against a detection run directly. Sample 10 at scale 8 is
   // pixel 83.5.
   var m = gt.meteors[0];
   ok(m.file === "a.xisf", "the meteor names its frame");
   close(m.x0, 83.5, 1e-9, "x0 is the sample centre in full-resolution pixels");
   close(m.y0, 163.5, 1e-9, "y0 is the sample centre in full-resolution pixels");
   close(m.x1, 99.5, 1e-9, "x1 is the sample centre in full-resolution pixels");
   close(m.y1, 171.5, 1e-9, "y1 is the sample centre in full-resolution pixels");

   // The scale is explicit, so detection coordinates can be kept.
   var raw = model.toGroundTruth(s, {}, 1, 1);
   close(raw.meteors[0].x0, 10, 1e-9, "scale 1 keeps detection coordinates");

   // indexInFrame disambiguates two judged candidates in one frame, which the
   // hand-made 2026-08-12 file could not express.
   var s2 = model.createSession(results([
      frame("a.xisf", [cand(10, 20, 12, 21), cand(30, 30, 40, 30)])
   ]), M.GROUND_TRUTH);
   model.setVerdict(s2, 0, V.METEOR);
   model.setVerdict(s2, 1, V.METEOR);
   var gt2 = model.toGroundTruth(s2, {}, 8, 8);
   ok(gt2.meteors.length === 2, "two meteors in one frame are both exported");
   ok(gt2.meteors[0].indexInFrame !== gt2.meteors[1].indexInFrame,
      "they are distinguishable by indexInFrame");

   // evaluate.js keys on `file`; the shape must stay compatible.
   ok(gt.meteors[0].file !== undefined, "entries carry `file` for evaluate.js");
   ok(Array.isArray(gt.uncertain), "uncertain is an array for evaluate.js");
});

//----------------------------------------------------------------------------

console.log("\n============================================");
console.log("passed: " + passed + "  failed: " + failed);
if (failed > 0) {
   console.log("\nFailures:");
   failures.forEach(function (f) {
      console.log("  - " + f);
   });
   process.exit(1);
}
console.log("OK");

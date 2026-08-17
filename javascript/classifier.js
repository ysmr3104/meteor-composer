//============================================================================
// classifier.js - Scoring candidates as more or less likely to be meteors
//
// Pure JavaScript, no PJSR dependency.
//
// This does NOT decide anything on its own. docs/requirements.md 6.2 settles
// the policy: a human screens everything afterwards, so losing one meteor
// costs more than letting thirty aircraft through. The score exists to put
// the likely ones first and to let an operator who wants a shorter list draw
// a line themselves. Nothing is discarded by default.
//
// The three signals it combines were each measured on the 2026-08-12 session
// before being written here (docs/requirements.md 6.1.0 and 4.6):
//
//   stationary   a track whose centroid does not move at all in registered
//                coordinates is a fixed structure - a star chain, a
//                diffraction spike - not a transient. One such position
//                accounted for 22 of the 411 candidates, all judged
//                not-a-meteor.
//   persistent   a track that moves smoothly across more than a meteor can
//                last is a satellite or an aircraft. The boundary is two
//                frames, not one: a meteor at an exposure boundary is
//                recorded in both.
//   colour       the green fraction of the trail's own light. Measured
//                balanced accuracy 0.801 on its own, better than elongation
//                at 0.540 - but sensitivity only 0.710, so it must never be
//                used as a filter.
//
// Colour is scored by RANK within the session, never against an absolute
// threshold. The not-a-meteor population sat at 0.458 rather than the
// colourless 0.333, which is a property of the camera (a Bayer array has
// twice as many green photosites), so an absolute cut would not survive a
// change of equipment.
//============================================================================

var DEFAULT_SCORE_OPTIONS = {
   // Longest track that could still be a single meteor. See
   // candidate_ops.DEFAULT_MATCH_OPTIONS.maxMeteorFrames for why it is 2.
   maxMeteorFrames: 2,

   // A track counts as fixed when every member sits within this radius of the
   // track's mean position, in samples of the working field. The measured
   // spread of the real example was under 0.1 samples, so this is loose by a
   // wide margin and still nowhere near the several hundred samples a
   // satellite moves between frames.
   stationaryRadius: 3.0,

   // Two frames is not enough to tell "fixed" from "a meteor that straddled
   // an exposure boundary and barely moved". Three is.
   stationaryMinFrames: 3,

   // Multipliers, not vetoes. Even a stationary candidate keeps a non-zero
   // score so that sorting by score never hides it completely.
   stationaryFactor: 0.02,
   persistentFactor: 0.15,

   // How much of the score colour is allowed to move. At 0.7 a candidate in
   // the greenest part of the session scores about three times one in the
   // least green part, which is in line with a feature whose measured
   // accuracy is 0.8 - strong, but not strong enough to decide alone.
   colourWeight: 0.7
};

// --- Track geometry ---------------------------------------------------------

// Summarise each track: how far it wanders, and what that implies.
//
// `tracks` is the output of candidate_ops.matchAcrossFrames.
function analyzeTracks(tracks, options) {
   var opt = mergeClassifierOptions(options);
   var out = [];
   for (var i = 0; i < tracks.length; ++i) {
      var track = tracks[i];
      var members = track.members;

      var sumX = 0, sumY = 0;
      var j;
      for (j = 0; j < members.length; ++j) {
         sumX += members[j].candidate.cx;
         sumY += members[j].candidate.cy;
      }
      var meanX = sumX / members.length;
      var meanY = sumY / members.length;

      var spread = 0;
      for (j = 0; j < members.length; ++j) {
         var dx = members[j].candidate.cx - meanX;
         var dy = members[j].candidate.cy - meanY;
         var d = Math.sqrt(dx * dx + dy * dy);
         if (d > spread) {
            spread = d;
         }
      }

      var stationary = members.length >= opt.stationaryMinFrames
                    && spread <= opt.stationaryRadius;

      out.push({
         id: track.id,
         length: members.length,
         meanX: meanX,
         meanY: meanY,
         spread: spread,
         stationary: stationary,
         // A fixed structure is not a satellite. Reporting it as `persistent`
         // as well would be filtering it for the wrong reason, and the reason
         // is what the operator reads.
         persistent: !stationary && members.length > opt.maxMeteorFrames
      });
   }
   return out;
}

// --- Colour ranking ---------------------------------------------------------

// Green fraction of a candidate's own light, background already removed.
//
// Returns null when the measurement is unusable: on a faint trail the
// background-subtracted total can come out at or below zero, and a ratio
// against that is meaningless rather than merely noisy.
function greenFraction(colour) {
   if (!colour) {
      return null;
   }
   var total = colour.r + colour.g + colour.b;
   if (!(total > 0)) {
      return null;
   }
   return colour.g / total;
}

// Rank of `value` within `sorted`, as a fraction from 0 to 1.
//
// Ranking rather than an absolute threshold is deliberate: what counts as
// "green" depends on the camera, so the only stable comparison is against the
// rest of the same session.
function rankOf(value, sorted) {
   if (sorted.length === 0) {
      return 0.5;
   }
   var lo = 0, hi = sorted.length;
   while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (sorted[mid] < value) {
         lo = mid + 1;
      } else {
         hi = mid;
      }
   }
   // Count how many are strictly below, plus half of the ties, so identical
   // values all get the same rank instead of depending on array order.
   var below = lo;
   var equal = 0;
   while (lo + equal < sorted.length && sorted[lo + equal] === value) {
      ++equal;
   }
   return (below + equal / 2) / sorted.length;
}

// Sorted green fractions across the session, for ranking against.
function colourPopulation(rows) {
   var values = [];
   for (var i = 0; i < rows.length; ++i) {
      var g = greenFraction(rows[i].colour);
      if (g !== null) {
         values.push(g);
      }
   }
   values.sort(function (a, b) { return a - b; });
   return values;
}

// --- Scoring ----------------------------------------------------------------

// Score one candidate from 0 to 1. Higher means more likely to be a meteor.
//
// `row` carries { trackLength, stationary, persistent, colour }. `population`
// is colourPopulation(rows); pass null to score without colour, which is what
// happens before the colour pass has run.
//
// The reasons are part of the output, not a debugging aid. An operator being
// asked to trust an ordering deserves to see why something was pushed down,
// and "stationary across 22 frames" is a statement they can check.
function scoreCandidate(row, population, options) {
   var opt = mergeClassifierOptions(options);
   var score = 1.0;
   var reasons = [];

   if (row.stationary) {
      score *= opt.stationaryFactor;
      reasons.push("stationary across " + row.trackLength
                   + " frames - fixed structure, not a transient");
   } else if (row.persistent) {
      score *= opt.persistentFactor;
      reasons.push("moves across " + row.trackLength
                   + " frames - longer than a meteor can last");
   }

   var g = greenFraction(row.colour);
   if (g !== null && population !== null && population.length > 0) {
      var rank = rankOf(g, population);
      score *= (1 - opt.colourWeight) + opt.colourWeight * rank;
      reasons.push("green fraction " + g.toFixed(3)
                   + " ranks at " + (rank * 100).toFixed(0)
                   + "% of this session");
   }

   return { score: score, reasons: reasons };
}

// Score every row in place and return them. `rows` are session_model rows
// with `stationary` and `colour` already attached.
function scoreAll(rows, options) {
   var population = colourPopulation(rows);
   for (var i = 0; i < rows.length; ++i) {
      var result = scoreCandidate(rows[i], population, options);
      rows[i].score = result.score;
      rows[i].scoreReasons = result.reasons;
   }
   return rows;
}

// --- Presets ----------------------------------------------------------------

// requirements.md 6.2 asks for three presets plus one slider, rather than
// exposing every threshold by default.
//
// These are cutoffs on the score, and every one of them is a suggestion: the
// candidates below the line are still in the list, just sorted to the bottom.
// "loose" is 0 precisely so that the default hides nothing at all.
var PRESETS = {
   loose:    { cutoff: 0.0,  label: "Loose - show everything" },
   standard: { cutoff: 0.1,  label: "Standard - drop fixed structures" },
   strict:   { cutoff: 0.35, label: "Strict - likely meteors only" }
};

function presetNames() {
   return ["loose", "standard", "strict"];
}

// --- Utility ----------------------------------------------------------------

function mergeClassifierOptions(options) {
   var out = {};
   for (var k in DEFAULT_SCORE_OPTIONS) {
      out[k] = DEFAULT_SCORE_OPTIONS[k];
   }
   if (options) {
      for (var j in options) {
         if (options[j] !== undefined) {
            out[j] = options[j];
         }
      }
   }
   return out;
}

// --- Exports ---------------------------------------------------------------

if (typeof module !== "undefined") {
   module.exports = {
      DEFAULT_SCORE_OPTIONS: DEFAULT_SCORE_OPTIONS,
      PRESETS: PRESETS,
      presetNames: presetNames,
      analyzeTracks: analyzeTracks,
      greenFraction: greenFraction,
      rankOf: rankOf,
      colourPopulation: colourPopulation,
      scoreCandidate: scoreCandidate,
      scoreAll: scoreAll
   };
}

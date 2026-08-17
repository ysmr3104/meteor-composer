//============================================================================
// analyze_colour.js - Does colour separate meteors from everything else?
//
// Run: node tests/eval/analyze_colour.js [colour_samples.json]
//
// Reads what tests/pjsr/probe_colour.js measured and answers three questions
// against the screening pass's own labels (31 meteor, 380 not-meteor):
//
//   1. Is there a colour difference at all?
//   2. Does green excess collapse as the trail approaches clipping - i.e.
//      does the operator's saturation explanation for the white meteors hold?
//   3. Would a threshold on colour be usable, or do the two groups overlap?
//
// This is an evaluation, not a test (docs/tests.md 5-1): it reports numbers
// and asserts nothing.
//============================================================================

var fs = require("fs");
var path = require("path");

var DEFAULT_INPUT = "/Volumes/Extreme SSD/pi_works/meteor-composer-test/colour_samples.json";

function fmt(v, digits) {
   if (v === null || v === undefined || isNaN(v)) {
      return "n/a";
   }
   return v.toFixed(digits === undefined ? 3 : digits);
}

function quantile(sorted, q) {
   if (sorted.length === 0) {
      return NaN;
   }
   var pos = (sorted.length - 1) * q;
   var lo = Math.floor(pos);
   var hi = Math.ceil(pos);
   if (lo === hi) {
      return sorted[lo];
   }
   return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function describe(label, values) {
   var s = values.slice().sort(function (a, b) { return a - b; });
   return {
      label: label,
      n: s.length,
      min: s[0],
      p25: quantile(s, 0.25),
      median: quantile(s, 0.5),
      p75: quantile(s, 0.75),
      max: s[s.length - 1]
   };
}

function printStats(rows) {
   console.log("  " + pad("group", 14) + pad("n", 6) + pad("min", 10)
               + pad("p25", 10) + pad("median", 10) + pad("p75", 10) + "max");
   rows.forEach(function (r) {
      console.log("  " + pad(r.label, 14) + pad("" + r.n, 6)
                  + pad(fmt(r.min), 10) + pad(fmt(r.p25), 10)
                  + pad(fmt(r.median), 10) + pad(fmt(r.p75), 10) + fmt(r.max));
   });
}

function pad(s, n) {
   s = "" + s;
   while (s.length < n) {
      s += " ";
   }
   return s;
}

// Green excess: how much of the trail's own light sits in the green channel.
// Normalised by the total so that a faint trail and a bright one are
// comparable - the raw green value mostly measures brightness.
function greenExcess(row) {
   var total = row.r + row.g + row.b;
   if (total <= 0) {
      return NaN;
   }
   return row.g / total;
}

// How well a single threshold on `key` separates the two groups. Reported as
// the best achievable balanced accuracy, which is a generous upper bound: it
// is chosen on the same data it is measured on, so a real classifier would do
// worse. If even this is near chance, the feature is not usable.
function bestSeparation(meteors, others, valueOf) {
   var all = [];
   meteors.forEach(function (r) { all.push(valueOf(r)); });
   others.forEach(function (r) { all.push(valueOf(r)); });
   all = all.filter(function (v) { return !isNaN(v); });
   all.sort(function (a, b) { return a - b; });

   var best = { accuracy: 0, threshold: NaN, direction: null };
   for (var i = 0; i < all.length; ++i) {
      var t = all[i];
      ["above", "below"].forEach(function (dir) {
         var tp = 0, fn = 0, tn = 0, fp = 0;
         meteors.forEach(function (r) {
            var v = valueOf(r);
            if (isNaN(v)) { return; }
            var flagged = dir === "above" ? (v >= t) : (v <= t);
            if (flagged) { ++tp; } else { ++fn; }
         });
         others.forEach(function (r) {
            var v = valueOf(r);
            if (isNaN(v)) { return; }
            var flagged = dir === "above" ? (v >= t) : (v <= t);
            if (flagged) { ++fp; } else { ++tn; }
         });
         var sensitivity = tp + fn > 0 ? tp / (tp + fn) : 0;
         var specificity = tn + fp > 0 ? tn / (tn + fp) : 0;
         var balanced = (sensitivity + specificity) / 2;
         if (balanced > best.accuracy) {
            best = { accuracy: balanced, threshold: t, direction: dir,
                     sensitivity: sensitivity, specificity: specificity };
         }
      });
   }
   return best;
}

function main() {
   var inputPath = process.argv[2] || DEFAULT_INPUT;
   if (!fs.existsSync(inputPath)) {
      console.error("colour samples not found: " + inputPath);
      console.error("run: tools/run-remote.sh --pjsr tests/pjsr/probe_colour.js");
      process.exit(2);
   }
   var data = JSON.parse(fs.readFileSync(inputPath, "utf8"));
   var rows = data.rows;

   var meteors = rows.filter(function (r) { return r.verdict === "meteor"; });
   var others = rows.filter(function (r) { return r.verdict === "not-meteor"; });

   console.log("=========================================================");
   console.log(" Colour analysis");
   console.log("=========================================================");
   console.log("generated:   " + data.generated);
   console.log("candidates:  " + rows.length
               + "   meteor " + meteors.length
               + "   not-meteor " + others.length);
   console.log("");

   console.log("--- 1. Green fraction  g / (r+g+b) ------------------");
   console.log("  A trail with no colour cast sits at 0.333.");
   printStats([
      describe("meteor", meteors.map(greenExcess).filter(function (v) { return !isNaN(v); })),
      describe("not-meteor", others.map(greenExcess).filter(function (v) { return !isNaN(v); }))
   ]);
   console.log("");

   console.log("--- 2. Peak channel value (1.0 = clipped) -----------");
   printStats([
      describe("meteor", meteors.map(function (r) { return r.maxChannel; })),
      describe("not-meteor", others.map(function (r) { return r.maxChannel; }))
   ]);
   console.log("");

   console.log("--- 3. Saturation hypothesis ------------------------");
   console.log("  If bright trails read white because R and B saturate too,");
   console.log("  green fraction should fall as the peak approaches 1.0.");
   console.log("");
   var bands = [[0, 0.25], [0.25, 0.5], [0.5, 0.75], [0.75, 0.95], [0.95, 1.01]];
   console.log("  " + pad("peak band", 16) + pad("meteors", 10) + pad("median g", 12)
               + pad("others", 10) + "median g");
   bands.forEach(function (b) {
      var inBand = function (r) { return r.maxChannel >= b[0] && r.maxChannel < b[1]; };
      var m = meteors.filter(inBand).map(greenExcess).filter(function (v) { return !isNaN(v); });
      var o = others.filter(inBand).map(greenExcess).filter(function (v) { return !isNaN(v); });
      m.sort(function (a, b2) { return a - b2; });
      o.sort(function (a, b2) { return a - b2; });
      console.log("  " + pad(b[0].toFixed(2) + "-" + b[1].toFixed(2), 16)
                  + pad("" + m.length, 10)
                  + pad(m.length ? fmt(quantile(m, 0.5)) : "-", 12)
                  + pad("" + o.length, 10)
                  + (o.length ? fmt(quantile(o, 0.5)) : "-"));
   });
   console.log("");

   console.log("--- 4. Best achievable single threshold -------------");
   console.log("  Balanced accuracy, chosen on this same data, so it is an");
   console.log("  optimistic upper bound. 0.5 is chance.");
   var features = [
      { name: "green fraction", fn: greenExcess },
      { name: "peak channel", fn: function (r) { return r.maxChannel; } },
      { name: "elongation", fn: function (r) { return r.elongation; } },
      { name: "length", fn: function (r) { return r.length; } }
   ];
   features.forEach(function (f) {
      var b = bestSeparation(meteors, others, f.fn);
      console.log("  " + pad(f.name, 18)
                  + "accuracy " + fmt(b.accuracy)
                  + "   (" + b.direction + " " + fmt(b.threshold)
                  + ", sens " + fmt(b.sensitivity)
                  + ", spec " + fmt(b.specificity) + ")");
   });
   console.log("");

   console.log("--- 5. The reported white meteors -------------------");
   ["DSC05069", "DSC05070", "DSC05542", "DSC04908"].forEach(function (tag) {
      rows.forEach(function (r) {
         if (r.file.indexOf(tag) < 0 || r.verdict !== "meteor") {
            return;
         }
         console.log("  " + pad(tag, 10)
                     + "g=" + fmt(greenExcess(r))
                     + "  peak=" + fmt(r.maxChannel)
                     + "  rgb=" + fmt(r.r, 4) + "/" + fmt(r.g, 4) + "/" + fmt(r.b, 4));
      });
   });
   console.log("");
   console.log("  For comparison, the greenest labelled meteors:");
   meteors.slice()
      .filter(function (r) { return !isNaN(greenExcess(r)); })
      .sort(function (a, b) { return greenExcess(b) - greenExcess(a); })
      .slice(0, 5)
      .forEach(function (r) {
         console.log("  " + pad(r.file.slice(-24, -8), 10)
                     + "g=" + fmt(greenExcess(r))
                     + "  peak=" + fmt(r.maxChannel)
                     + "  rgb=" + fmt(r.r, 4) + "/" + fmt(r.g, 4) + "/" + fmt(r.b, 4));
      });
}

main();

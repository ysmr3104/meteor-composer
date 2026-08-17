//============================================================================
// test_composition.js - Small tests for meteor compositing
//
// Run: node tests/ut/test_composition.js
//
// The fixtures are synthetic and constructed so that the right answer is
// known in advance: a master, a sub that is a known linear transform of it,
// and a meteor added at a known place with a known amplitude. Then the
// composite must reproduce the master everywhere outside the mask and the
// master plus the meteor inside it.
//
// docs/requirements.md 7.3 rules out a lighten blend because a single sub is
// far noisier than the master. The test for that is not an opinion: with a
// noisy sub and no meteor at all, the composite must not change the sky.
//============================================================================

var comp = require("../../javascript/composition.js");
var trailMask = require("../../javascript/trail_mask.js");

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

// Deterministic noise. docs/tests.md 3-3: Math.random() is never used, so a
// failure can always be reproduced.
function makeRandom(seed) {
   var state = seed >>> 0;
   return function () {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 4294967296;
   };
}

function makeMaster(n, seed) {
   var rand = makeRandom(seed);
   var data = new Float32Array(n);
   for (var i = 0; i < n; ++i) {
      // A gentle gradient plus faint noise, as a stacked sky looks.
      data[i] = 0.10 + 0.02 * (i / n) + (rand() - 0.5) * 0.0005;
   }
   return data;
}

// A sub-frame: the master through a known linear relationship, plus noise
// that is much larger than the master's.
function makeSub(master, scale, offset, noise, seed) {
   var rand = makeRandom(seed);
   var data = new Float32Array(master.length);
   for (var i = 0; i < master.length; ++i) {
      data[i] = scale * master[i] + offset + (rand() - 0.5) * noise;
   }
   return data;
}

//----------------------------------------------------------------------------

suite("linearFit recovers a known relationship", function () {
   var master = makeMaster(2000, 7);
   var sub = makeSub(master, 1.8, 0.03, 0, 11);
   var fit = comp.linearFit(master, sub);
   close(fit.scale, 1.8, 1e-3, "the scale is recovered");
   close(fit.offset, 0.03, 1e-4, "the offset is recovered");
   ok(fit.samples === 2000, "every sample was used");

   // With noise the fit should still land close: noise raises the variance of
   // the residual, not the slope.
   var noisy = makeSub(master, 1.8, 0.03, 0.01, 13);
   var noisyFit = comp.linearFit(master, noisy);
   close(noisyFit.scale, 1.8, 0.15, "the scale survives noise");

   // Non-finite samples are skipped rather than poisoning the sums. A frame
   // with undefined border pixels is normal after registration.
   var withHoles = new Float32Array(master.length);
   withHoles.set(sub);
   withHoles[0] = NaN;
   withHoles[1] = Infinity;
   var holeFit = comp.linearFit(master, withHoles);
   ok(holeFit.samples === 1998, "non-finite samples are excluded");
   close(holeFit.scale, 1.8, 1e-2, "and the fit is unharmed");

   // Degenerate inputs must not produce NaN.
   var flat = comp.linearFit([0.5, 0.5, 0.5], [0.2, 0.3, 0.4]);
   ok(isFinite(flat.scale) && isFinite(flat.offset),
      "a constant source still yields a finite fit");
   close(flat.scale, 1, 1e-9, "with no slope claimed");
   var none = comp.linearFit([], []);
   ok(none.samples === 0 && none.scale === 1, "empty input is the identity");
});

suite("the fit excludes the trail", function () {
   // If the meteor is inside the fit, the fit absorbs part of it and the
   // residual - which IS the meteor - comes out too small.
   var n = 2000;
   var master = makeMaster(n, 3);
   var sub = makeSub(master, 1.5, 0.01, 0, 5);

   // A bright meteor over a tenth of the frame.
   var mask = new Float32Array(n);
   var i;
   for (i = 900; i < 1100; ++i) {
      mask[i] = 1;
      sub[i] += 0.5;
   }

   var excluded = comp.fitMasterToSub(master, sub, mask, 0);
   var included = comp.linearFit(master, sub);

   close(excluded.scale, 1.5, 1e-3, "excluding the trail recovers the true scale");
   ok(Math.abs(included.scale - 1.5) > Math.abs(excluded.scale - 1.5),
      "including it makes the fit worse");
   ok(excluded.samples === n - 200, "the masked samples were left out");

   // And the consequence: the meteor's amplitude survives.
   var res = comp.residual(master, sub, excluded);
   close(res[1000], 0.5, 1e-3, "the residual carries the meteor's full amplitude");
});

suite("outside the mask the master is untouched", function () {
   // The property that rules out a lighten blend. The sub here is twenty
   // times noisier than the master and contains no meteor at all; the
   // composite must return the master exactly wherever the mask is zero, and
   // must not brighten the sky where the mask is not zero either.
   var n = 4000;
   var master = makeMaster(n, 21);
   var sub = makeSub(master, 1.2, 0.005, 0.01, 23);

   var mask = new Float32Array(n);
   var i;
   for (i = 1000; i < 1200; ++i) {
      mask[i] = 1;
   }

   var result = comp.composeChannel(master, sub, mask, null);

   for (i = 0; i < 900; ++i) {
      close(result.data[i], master[i], 1e-6,
            i === 0 ? "outside the mask the result is the master exactly" : "");
      if (i > 20) {
         break;
      }
   }

   // Inside the mask, with no meteor present, the result is the master plus
   // noise that averages to zero - not the master plus a bias.
   var sum = 0;
   for (i = 1000; i < 1200; ++i) {
      sum += result.data[i] - master[i];
   }
   var meanShift = sum / 200;
   ok(Math.abs(meanShift) < 0.001,
      "with no meteor, the masked sky is not lifted (mean shift "
      + meanShift.toFixed(6) + ")");

   // A lighten blend would have taken the brighter of the two everywhere in
   // the mask, which with this much noise lifts the sky substantially. Show
   // the number that decision avoided.
   var lightenShift = 0;
   for (i = 1000; i < 1200; ++i) {
      lightenShift += Math.max(master[i], sub[i]) - master[i];
   }
   lightenShift /= 200;
   ok(lightenShift > Math.abs(meanShift) * 10,
      "a lighten blend would have lifted it by " + lightenShift.toFixed(6)
      + ", far more than this does");
});

suite("inside the mask the meteor is added at full strength", function () {
   var n = 4000;
   var master = makeMaster(n, 31);
   var sub = makeSub(master, 1.4, 0.02, 0, 37);

   var mask = new Float32Array(n);
   var i;
   for (i = 2000; i < 2100; ++i) {
      mask[i] = 1;
      sub[i] += 0.25;
   }
   // A feathered shoulder, as a real mask has.
   for (i = 1950; i < 2000; ++i) {
      mask[i] = (i - 1950) / 50;
   }

   var result = comp.composeChannel(master, sub, mask, null);

   close(result.data[2050] - master[2050], 0.25, 1e-3,
         "the full amplitude arrives where the mask is solid");
   close(result.data[1975] - master[1975], 0, 1e-3,
         "and nothing arrives in the shoulder where the sub has no meteor");
   close(result.peakAdded, 0.25, 1e-3, "the reported peak matches");
   ok(result.addedEnergy > 0, "energy was added");
   close(result.fit.scale, 1.4, 1e-3, "the fit is still right");
});

suite("the feather is reproduced proportionally", function () {
   // A mask value of 0.5 must add half the meteor, not all of it and not
   // none: that is what makes the edge invisible.
   var n = 1000;
   var master = new Float32Array(n);
   var sub = new Float32Array(n);
   var mask = new Float32Array(n);
   for (var i = 0; i < n; ++i) {
      master[i] = 0.1;
      sub[i] = 0.1;
   }
   // The meteor goes ONLY where the mask is. An earlier version of this
   // fixture put a bright region across 400-600 while masking just four
   // samples of it; the fit then correctly concluded that the sub was
   // brighter overall and absorbed most of the meteor into the offset. That
   // was the fit working, not failing - but it meant the fixture was not
   // testing what it claimed to.
   mask[500] = 1.0;
   mask[501] = 0.5;
   mask[502] = 0.25;
   mask[503] = 0.0;
   for (i = 500; i <= 502; ++i) {
      sub[i] = 0.1 + 0.4;
   }

   var result = comp.composeChannel(master, sub, mask, null);
   close(result.data[500] - 0.1, 0.4, 1e-6, "mask 1.0 adds all of it");
   close(result.data[501] - 0.1, 0.2, 1e-6, "mask 0.5 adds half");
   close(result.data[502] - 0.1, 0.1, 1e-6, "mask 0.25 adds a quarter");
   close(result.data[503] - 0.1, 0.0, 1e-6, "mask 0 adds nothing");
   // And the samples the fit was computed from are untouched.
   close(result.data[100], 0.1, 1e-6, "unmasked sky is exactly the master");
});

suite("negative residuals are not clipped", function () {
   // Clipping would bias the residual upward everywhere the sub is darker
   // than the master, which is half the noise, and that bias times the mask
   // lifts the sky inside every mask.
   var master = new Float32Array([0.2, 0.2, 0.2, 0.2]);
   var sub = new Float32Array([0.1, 0.3, 0.1, 0.3]);
   var fit = { scale: 1, offset: 0, samples: 4 };
   var res = comp.residual(master, sub, fit);
   // Float32 carries about seven decimal digits, so the tolerance has to
   // allow for that rather than assert double precision.
   close(res[0], -0.1, 1e-6, "a darker sample gives a negative residual");
   close(res[1], 0.1, 1e-6, "a brighter one gives a positive residual");

   var sum = 0;
   for (var i = 0; i < res.length; ++i) {
      sum += res[i];
   }
   close(sum, 0, 1e-6, "so symmetric noise cancels rather than accumulating");
});

suite("fitIsPlausible", function () {
   ok(comp.fitIsPlausible({ scale: 1.4, offset: 0.01, samples: 5000 }, null).ok,
      "a sensible fit passes");

   // A scale nowhere near 1 means the two frames are not comparable - the
   // wrong master, another filter, another session. Compositing anyway gives
   // a result that looks plausible and is wrong.
   var wild = comp.fitIsPlausible({ scale: 47, offset: 0, samples: 5000 }, null);
   ok(!wild.ok, "an absurd scale is rejected");
   ok(wild.reason.indexOf("right master") >= 0, "and says what to check");

   ok(!comp.fitIsPlausible({ scale: 0.01, offset: 0, samples: 5000 }, null).ok,
      "a near-zero scale is rejected too");

   // Too few samples outside the mask: the mask covers almost everything, so
   // there is nothing left to fit against.
   var thin = comp.fitIsPlausible({ scale: 1.2, offset: 0, samples: 10 }, null);
   ok(!thin.ok, "too few samples is rejected");
   ok(thin.reason.indexOf("samples") >= 0, "and says so");
});

suite("end to end with a real trail mask", function () {
   // The mask comes from trail_mask rather than being written by hand, so the
   // two modules are exercised together in the shape the pipeline uses.
   var W = 200, H = 120;
   var n = W * H;
   var master = makeMaster(n, 41);
   var sub = makeSub(master, 1.3, 0.004, 0.002, 43);

   var field = trailMask.renderMask(
      [{ x0: 40, y0: 60, x1: 160, y1: 60, width: 3 }], W, H,
      { coreRadius: 4, coreScale: 0, featherWidth: 10, endExtension: 5 });

   // Put a meteor into the sub exactly where the mask is solid.
   var i;
   for (i = 0; i < n; ++i) {
      if (field.data[i] >= 1) {
         sub[i] += 0.3;
      }
   }

   var result = comp.composeChannel(master, sub, field.data, null);
   var check = comp.fitIsPlausible(result.fit, null);
   ok(check.ok, "the fit is plausible: " + (check.reason || "ok"));
   close(result.fit.scale, 1.3, 0.05, "and recovers the sub's scale");

   // On the trail's axis the full amplitude arrives.
   var axis = 60 * W + 100;
   close(result.data[axis] - master[axis], 0.3, 0.01,
         "the meteor arrives at full strength on the axis");

   // Well away from it nothing changed at all.
   var far = 10 * W + 10;
   close(result.data[far], master[far], 1e-6, "and the far sky is untouched");

   // The composite never darkens the master where the meteor is: the whole
   // point is adding light.
   var darkened = 0;
   for (i = 0; i < n; ++i) {
      if (field.data[i] >= 1 && result.data[i] < master[i]) {
         ++darkened;
      }
   }
   ok(darkened === 0, "no solid-mask sample was darkened");
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

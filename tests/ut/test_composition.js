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

suite("fitOnGrid excludes the trail and still has plenty of samples", function () {
   // If the meteor is inside the fit, the fit absorbs part of it and the light
   // that is then added - which IS the meteor - comes out too small.
   var W = 200, H = 100;
   var n = W * H;
   var master = makeMaster(n, 3);
   var sub = makeSub(master, 1.5, 0.01, 0, 5);

   var mask = new Float32Array(n);
   var i;
   for (i = 0; i < n; ++i) {
      // A bright meteor down one column band, masked.
      var x = i % W;
      if (x >= 90 && x < 110) {
         mask[i] = 1;
         sub[i] += 0.5;
      }
   }

   var excluded = comp.fitOnGrid(master, sub, mask, W, H, null);
   var included = comp.fitOnGrid(master, sub, new Float32Array(n), W, H, null);

   close(excluded.scale, 1.5, 1e-2, "excluding the trail recovers the true scale");
   ok(Math.abs(included.scale - 1.5) > Math.abs(excluded.scale - 1.5),
      "including it makes the fit worse");
   ok(excluded.samples > 300,
      "a stride of 7 still leaves hundreds of samples here ("
      + excluded.samples + ")");

   // The stride must not change the answer. Two coefficients do not need every
   // pixel, and that is the whole justification for striding.
   var dense = comp.fitOnGrid(master, sub, mask, W, H, { fitStride: 1 });
   close(excluded.scale, dense.scale, 1e-3, "the stride does not move the scale");
   ok(dense.samples > excluded.samples * 20,
      "and the dense fit really did use far more samples");
});

suite("localBackground measures the sky the fit did not match", function () {
   // The fit is global; a patch of sky that sits a little high or low relative
   // to the master leaves a level error behind, and the mask would paint it
   // into the result in its own shape. This finds it in the ring outside the
   // mask, where the composite touches nothing.
   var W = 300, H = 200;
   var n = W * H;
   var master = makeMaster(n, 61);
   var sub = makeSub(master, 1.2, 0.005, 0.0002, 63);

   var rect = { left: 100, top: 80, right: 200, bottom: 120 };
   var mask = new Float32Array(n);
   var x, y, i;
   for (y = rect.top; y <= rect.bottom; ++y) {
      for (x = rect.left; x <= rect.right; ++x) {
         mask[y * W + x] = 1;
      }
   }

   // A known local excess over a generous area around the rectangle, plus a
   // bright meteor inside the mask that must NOT influence the estimate.
   var LOCAL = 0.0012;
   for (y = 40; y < 170; ++y) {
      for (x = 60; x < 250; ++x) {
         sub[y * W + x] += LOCAL;
      }
   }
   for (y = 95; y <= 105; ++y) {
      for (x = 120; x <= 180; ++x) {
         sub[y * W + x] += 0.4;
      }
   }

   // The TRUE relationship, not a fitted one. A fit over a frame where the
   // excess covers 40% of the pixels would absorb much of it into its own
   // offset, and this test is about what localBackground reads off a residual -
   // not about how much of a large excess a global fit leaves behind.
   var fit = { scale: 1.2, offset: 0.005, samples: 100000 };
   var bg = comp.localBackground(master, sub, fit, mask, W, H, rect, null);

   close(bg.level, LOCAL, 3e-4, "the local level is recovered from the ring");
   ok(bg.samples > 500, "from a useful number of samples (" + bg.samples + ")");
   ok(bg.sigma > 0 && bg.sigma < 0.001,
      "and a noise figure comes with it (" + bg.sigma.toExponential(2) + ")");

   // The meteor is inside the mask, so it cannot have contributed. If it had,
   // the level would be pulled towards 0.4 and the meteor would then be
   // subtracted from itself.
   ok(bg.level < LOCAL + 0.01, "the masked meteor did not contribute");
});

suite("light is added, never removed", function () {
   // The property the earlier signed version did not have. An operator expects
   // the meteor to be laid on top of the master: nothing in the frame may come
   // out darker than the master did, anywhere, for any reason.
   var W = 100, H = 60;
   var n = W * H;
   var master = makeMaster(n, 21);
   // A sub that is uniformly DARKER than the fitted master everywhere, and
   // twenty times noisier. There is no meteor in it at all.
   var sub = makeSub(master, 1.2, 0.005, 0.01, 23);

   var mask = new Float32Array(n);
   var rect = { left: 20, top: 20, right: 60, bottom: 40 };
   var x, y, i;
   for (y = rect.top; y <= rect.bottom; ++y) {
      for (x = rect.left; x <= rect.right; ++x) {
         mask[y * W + x] = 1;
      }
   }

   var fit = comp.fitOnGrid(master, sub, mask, W, H, null);
   var added = new Float32Array(n);
   comp.addTrailLight(master, sub, fit, mask, W, rect, { level: 0 }, added);

   var negative = 0;
   var lifted = 0;
   for (i = 0; i < n; ++i) {
      if (added[i] < 0) {
         ++negative;
      }
      if (added[i] > 0) {
         lifted += added[i];
      }
   }
   ok(negative === 0, "no negative light was written anywhere");

   var masked = (rect.right - rect.left + 1) * (rect.bottom - rect.top + 1);
   var meanLift = lifted / masked;

   // Clipping does have a cost, and it is bounded: half of a symmetric noise
   // distribution survives, which lifts the masked sky by sigma/sqrt(2*pi).
   // The test states the bound rather than pretending the cost is zero.
   var subSigma = 0.01 / Math.sqrt(12);   // uniform noise of that width
   var expectedLift = subSigma / Math.sqrt(2 * Math.PI);
   ok(meanLift < expectedLift * 2,
      "the lift stays near sigma/sqrt(2*pi) (" + meanLift.toExponential(2)
      + " against " + expectedLift.toExponential(2) + ")");
});

suite("the feather is reproduced proportionally", function () {
   // A mask value of 0.5 must add half the meteor, not all of it and not
   // none: that is what makes the edge invisible.
   var W = 20, H = 1;
   var n = W * H;
   var master = new Float32Array(n);
   var sub = new Float32Array(n);
   var mask = new Float32Array(n);
   for (var i = 0; i < n; ++i) {
      master[i] = 0.1;
      sub[i] = 0.1;
   }
   mask[10] = 1.0;
   mask[11] = 0.5;
   mask[12] = 0.25;
   mask[13] = 0.0;
   for (i = 10; i <= 12; ++i) {
      sub[i] = 0.1 + 0.4;
   }

   var fit = { scale: 1, offset: 0, samples: 1000 };
   var added = new Float32Array(n);
   comp.addTrailLight(master, sub, fit, mask, W,
                      { left: 0, top: 0, right: W - 1, bottom: 0 },
                      { level: 0 }, added);

   close(added[10], 0.4, 1e-6, "mask 1.0 adds all of it");
   close(added[11], 0.2, 1e-6, "mask 0.5 adds half");
   close(added[12], 0.1, 1e-6, "mask 0.25 adds a quarter");
   close(added[13], 0.0, 1e-9, "mask 0 adds nothing");
   close(added[0], 0.0, 1e-9, "and unmasked sky is untouched");
});

suite("two frames of one meteor do not erase each other", function () {
   // The defect this replaces. The composite used to be accumulated: each
   // frame was composited into the master and the next frame was fitted
   // against the result. A meteor that crossed an exposure boundary appears in
   // two consecutive frames as two adjacent stretches of one path, so the
   // second frame's mask covers the first frame's trail - and the second frame
   // has no meteor there. Its residual was therefore the first frame's light
   // with a minus sign, and with a fit scale of 1.1 that subtracted more than
   // had been added. The trail came out with a black gouge along it.
   //
   // Here the two masks overlap completely, which is the worst case.
   var W = 120, H = 40;
   var n = W * H;
   var master = makeMaster(n, 71);
   var subA = makeSub(master, 1.1, 0.002, 0, 73);
   var subB = makeSub(master, 1.1, 0.002, 0, 79);

   var mask = new Float32Array(n);
   var x, y, i;
   for (y = 18; y <= 22; ++y) {
      for (x = 20; x < 100; ++x) {
         mask[y * W + x] = 1;
      }
   }
   var rect = { left: 20, top: 18, right: 99, bottom: 22 };

   // Frame A carries the first half of the trail, frame B the second half.
   for (y = 19; y <= 21; ++y) {
      for (x = 20; x < 60; ++x) {
         subA[y * W + x] += 0.3;
      }
      for (x = 60; x < 100; ++x) {
         subB[y * W + x] += 0.2;
      }
   }

   var added = new Float32Array(n);
   var fitA = comp.fitOnGrid(master, subA, mask, W, H, null);
   var fitB = comp.fitOnGrid(master, subB, mask, W, H, null);

   // Both frames are fitted against the SAME master and write into the same
   // accumulator, in the order the composite would run them.
   comp.addTrailLight(master, subA, fitA, mask, W, rect, { level: 0 }, added);
   comp.addTrailLight(master, subB, fitB, mask, W, rect, { level: 0 }, added);

   var first = 20 * W + 40;
   var second = 20 * W + 80;
   close(added[first], 0.3, 5e-3, "frame A's light survives frame B");
   close(added[second], 0.2, 5e-3, "and frame B's light is there too");

   var dug = 0;
   for (i = 0; i < n; ++i) {
      if (added[i] < 0) {
         ++dug;
      }
   }
   ok(dug === 0, "and nothing anywhere was dug out");
});

suite("composeFrame writes nothing when a fit is implausible", function () {
   // A frame that does not match the master must leave no trace at all.
   // Writing two channels and rejecting on the third would produce a colour
   // cast that reads as a mask bug.
   var W = 200, H = 150;
   var n = W * H;
   var masterChannels = [makeMaster(n, 81), makeMaster(n, 83), makeMaster(n, 85)];
   var subChannels = [
      makeSub(masterChannels[0], 1.2, 0.001, 0, 91),
      makeSub(masterChannels[1], 1.2, 0.001, 0, 93),
      // The third channel is unrelated to its master: a near-zero slope, which
      // is what the one rejected frame of the real night looked like.
      makeSub(masterChannels[2], 0.02, 0.008, 0, 95)
   ];

   var mask = new Float32Array(n);
   var rect = { left: 80, top: 70, right: 120, bottom: 80 };
   var x, y, ch;
   for (y = rect.top; y <= rect.bottom; ++y) {
      for (x = rect.left; x <= rect.right; ++x) {
         mask[y * W + x] = 1;
      }
   }

   var added = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
   var result = comp.composeFrame(masterChannels, subChannels, mask, W, H,
                                  [rect], added, null);

   ok(!result.written, "the frame was refused");
   ok(result.reason !== null && result.reason.indexOf("scale") >= 0,
      "and the reason names the scale: " + result.reason);
   ok(result.channel === 2, "on the channel that failed");

   var touched = 0;
   for (ch = 0; ch < 3; ++ch) {
      for (var i = 0; i < n; ++i) {
         if (added[ch][i] !== 0) {
            ++touched;
         }
      }
   }
   ok(touched === 0, "and not one sample was written in any channel");
});

suite("end to end with a real trail mask", function () {
   // The mask comes from trail_mask rather than being written by hand, so the
   // two modules are exercised together in the shape the pipeline uses.
   var W = 200, H = 120;
   var n = W * H;
   var master = makeMaster(n, 41);
   var sub = makeSub(master, 1.3, 0.004, 0.002, 43);

   var trail = { x0: 40, y0: 60, x1: 160, y1: 60, width: 3 };
   var field = trailMask.renderMask([trail], W, H, null);
   var rect = trailMask.maskBounds(trail, W, H, null);

   // Put a meteor into the sub exactly where the mask is solid.
   var i;
   for (i = 0; i < n; ++i) {
      if (field.data[i] >= 1) {
         sub[i] += 0.3;
      }
   }

   var added = [new Float32Array(n)];
   var result = comp.composeFrame([master], [sub], field.data, W, H,
                                  [rect], added, null);
   ok(result.written, "the frame was composited: " + (result.reason || "ok"));
   close(result.fits[0].scale, 1.3, 0.05, "and the fit recovers the sub's scale");

   var composite = comp.applyAdded(master, added[0]);

   // On the trail's axis the full amplitude arrives.
   var axis = 60 * W + 100;
   close(composite[axis] - master[axis], 0.3, 0.01,
         "the meteor arrives at full strength on the axis");

   // Well away from it nothing changed at all.
   var far = 10 * W + 10;
   close(composite[far], master[far], 1e-9, "and the far sky is untouched");

   // Nothing anywhere is darker than the master.
   var darkened = 0;
   var outsideChanged = 0;
   for (i = 0; i < n; ++i) {
      if (composite[i] < master[i]) {
         ++darkened;
      }
      if (field.data[i] <= 0 && composite[i] !== master[i]) {
         ++outsideChanged;
      }
   }
   ok(darkened === 0, "no sample anywhere was darkened");
   ok(outsideChanged === 0, "and outside the mask the master is reproduced exactly");

   // Where the mask stops is the whole correction. The light was measured to
   // reach 1 sigma at 5 px from the axis and a tenth of that by 20 px, so the
   // core ends at 5 and nothing at all is added past 20.
   close(field.data[(60 + 3) * W + 100], 1, 1e-9, "the core is solid at 3 px");
   ok(field.data[(60 + 12) * W + 100] > 0 && field.data[(60 + 12) * W + 100] < 1,
      "the feather is partial at 12 px");
   close(field.data[(60 + 21) * W + 100], 0, 1e-9, "and there is no mask at 21 px");
});

suite("local background removal changes what is added", function () {
   // With a local excess present, leaving it in means the mask paints it; the
   // clip at zero makes that a one-sided error, so it can only ever add sky.
   var W = 200, H = 120;
   var n = W * H;
   var master = makeMaster(n, 51);
   var sub = makeSub(master, 1.15, 0.003, 0.0001, 53);

   var trail = { x0: 60, y0: 60, x1: 140, y1: 60, width: 3 };
   var field = trailMask.renderMask([trail], W, H, null);
   var rect = trailMask.maskBounds(trail, W, H, null);

   // A local excess covering the trail and its surroundings, and no meteor.
   var LOCAL = 0.0008;
   var x, y;
   for (y = 20; y < 100; ++y) {
      for (x = 20; x < 180; ++x) {
         sub[y * W + x] += LOCAL;
      }
   }

   var withRemoval = [new Float32Array(n)];
   comp.composeFrame([master], [sub], field.data, W, H, [rect], withRemoval, null);
   var without = [new Float32Array(n)];
   comp.composeFrame([master], [sub], field.data, W, H, [rect], without,
                     { removeLocalBackground: false });

   var sumWith = 0, sumWithout = 0;
   for (var i = 0; i < n; ++i) {
      sumWith += withRemoval[0][i];
      sumWithout += without[0][i];
   }
   ok(sumWithout > sumWith * 3,
      "leaving the local sky in paints far more of it (" + sumWithout.toExponential(2)
      + " against " + sumWith.toExponential(2) + ")");

   // And with it removed, a frame with no meteor adds almost nothing: the
   // remainder is the clipped half of the noise, not a level.
   var meanWith = sumWith / trailMask.maskCoverage(field).touched;
   ok(meanWith < LOCAL / 4,
      "with it removed, next to nothing is added (" + meanWith.toExponential(2) + ")");
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

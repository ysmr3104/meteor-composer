#engine v8
// Render crops around the candidates in question, so they can be looked at
// rather than reasoned about from coordinates.
#include "../../javascript/detection_core.js"
#include "../../javascript/candidate_ops.js"

var DATA = "/Volumes/Extreme SSD/pi_works/meteor-composer-test/test-sky";
var GROUP = "Light_BIN-1_6024x4024_EXPOSURE-13.00s_FILTER-NoFilter_RGB";
var OUT = "/tmp/crops";
var F = 8;

var log = [];
function say(t) { log.push(t); File.writeTextFile("/tmp/probe_crop.txt", log.join("\n") + "\n"); }

if (!File.directoryExists(OUT)) { File.createDirectory(OUT); }

// frame number -> list of [x0,y0,x1,y1] in 1/8 samples, plus a label
var WANT = [
   { n: 5336, boxes: [[54,2,50,13]] },
   { n: 5337, boxes: [[45,98,20,98], [49,14,42,31]] },
   { n: 5338, boxes: [[240,0,242,12]] },
   { n: 5339, boxes: [] },
   { n: 5340, boxes: [] },
   { n: 5341, boxes: [[287,91,298,91]] }
];

var find = new FileFind;
var names = [];
if (find.begin(DATA + "/registered/" + GROUP + "/*.xisf")) {
   do { if (!find.isDirectory) { names.push(find.name); } } while (find.next());
}
names.sort();

function computeSTF(view) {
   var median = view.computeOrFetchProperty("Median");
   var mad = view.computeOrFetchProperty("MAD");
   var c = [], s = [];
   for (var i = 0; i < median.length; ++i) {
      c.push(Math.max(0.00001, median[i]));
      s.push(1.4826 * mad[i]);
   }
   return view.image.computeAutoStretch(c, s, -2.8, 0.25, false);
}

say("crops written to " + OUT);
for (var w = 0; w < WANT.length; ++w) {
   var n = WANT[w].n;
   var file = null;
   for (var i = 0; i < names.length; ++i) {
      if (names[i].indexOf("DSC0" + n) >= 0) { file = names[i]; break; }
   }
   if (file === null) { say(n + ": not found"); continue; }

   var win = ImageWindow.open(DATA + "/registered/" + GROUP + "/" + file)[0];
   try {
      var view = win.mainView;
      var img = new Image(view.image);
      img.applyDisplayFunction(computeSTF(view));
      var bmp = img.render();
      img.free();

      // A wide crop of the left third and the top, where the candidates are.
      var regions = [
         { tag: "topleft", x0: 0, y0: 0, x1: 900, y1: 900 }
      ];
      for (var r = 0; r < regions.length; ++r) {
         var g = regions[r];
         var crop = new Bitmap(bmp, g.x0, g.y0, g.x1, g.y1);
         // Mark the candidates.
         var gr = new Graphics(crop);
         try {
            gr.pen = new Pen(0xFFFF3030, 3);
            for (var b = 0; b < WANT[w].boxes.length; ++b) {
               var q = WANT[w].boxes[b];
               var x0 = (q[0] + 0.5) * F - 0.5 - g.x0;
               var y0 = (q[1] + 0.5) * F - 0.5 - g.y0;
               var x1 = (q[2] + 0.5) * F - 0.5 - g.x0;
               var y1 = (q[3] + 0.5) * F - 0.5 - g.y0;
               var pad = 40;
               gr.drawRect(new Rect(Math.min(x0,x1)-pad, Math.min(y0,y1)-pad,
                                    Math.max(x0,x1)+pad, Math.max(y0,y1)+pad));
            }
         } finally { gr.end(); }
         var scaled = crop.scaledTo(600);
         var path = OUT + "/" + n + "_" + g.tag + ".png";
         scaled.save(path);
         say(n + " " + g.tag + " -> " + path);
      }
   } catch (e) {
      say(n + ": ERROR " + e);
   } finally {
      win.forceClose();
   }
}
say("done");

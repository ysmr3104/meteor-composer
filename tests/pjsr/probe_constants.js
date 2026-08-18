#engine v8

//============================================================================
// probe_constants.js - What does PJSR actually declare in its constant classes?
//
// Run:
//   tools/run-remote.sh --pjsr tests/pjsr/probe_constants.js
//   ssh mbp4ysmr cat /tmp/probe_constants.txt
//
// The output is pasted into MEMBERS in tests/ut/test_module_isolation.js, which
// then checks every constant MeteorComposer.js references against it.
//
// Why this exists. A constant class that does not exist throws, and PJSR
// reports that only in the Process Console, so the dialog silently fails to
// appear - bad, but at least total. A class that DOES exist, referenced with a
// member it does not declare, is worse: the expression is `undefined`,
// `flags | undefined` is `flags`, and the flag quietly does nothing forever.
//
// TextAlignment.VerticalCenter was written in eleven places in this script and
// none of them centred anything. It read as obviously right, and the guard
// meant to catch exactly this asserted that spelling was the correct one, so it
// agreed. The real member is VertCenter. Nothing short of asking PixInsight was
// going to settle it - the reference pages list properties, not enumerators.
//
// So: do not write these lists from memory. Run this.
//============================================================================

#define OUT "/tmp/probe_constants.txt"

var CLASSES = ["TextAlignment", "StdIcon", "StdButton", "StdCursor",
               "FrameStyle", "ColorSpace", "DataType", "BitmapFormat",
               "BitmapInterpolation", "MaskMode", "UndoFlag", "Interpolation"];

var lines = [];

function say(text) {
   lines.push(text);
   File.writeTextFile(OUT, lines.join("\n") + "\n");
   console.writeln(text);
}

say("probe_constants.js");
say("");

for (var i = 0; i < CLASSES.length; ++i) {
   var name = CLASSES[i];
   try {
      // eval, because referencing an absent global directly throws a
      // ReferenceError that cannot be caught per-name any other way here.
      var obj = eval(name);
      if (obj === undefined || obj === null) {
         say(name + ": ABSENT");
         continue;
      }
      var keys = Object.getOwnPropertyNames(obj).filter(function (k) {
         return typeof obj[k] === "number";
      });
      keys.sort();
      say(name + ": " + keys.join(" "));
   } catch (e) {
      say(name + ": ABSENT (" + e + ")");
   }
}

say("");
say("written to " + OUT);

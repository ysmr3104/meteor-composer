//============================================================================
// test_script_syntax.js - MeteorComposer.js parses
//
// Run: node tests/ut/test_script_syntax.js
//
// The only file in the project with no other test, because it is the only one
// that cannot run outside PixInsight. That makes a syntax error in it the
// worst kind: nothing here catches it, and PixInsight reports it in the
// Process Console only - the terminal shows a clean start and a clean exit
// (docs/requirements.md, "実行時の落とし穴").
//
// So this parses it. Not runs it: every line of it touches PJSR. Parsing is
// what is being claimed and it is worth exactly what it says - a file that
// parses can still be wrong, but a file that does not parse is never right.
//
// The PJSR preprocessor is not JavaScript, so its directives are removed
// first. #define substitution is done for real rather than skipped, because
// `#define VERSION "1.2.0"` followed by a bare `VERSION` is a valid program
// only after the substitution.
//============================================================================

var fs = require("fs");
var path = require("path");
var vm = require("vm");

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

function suite(name, fn) {
   console.log("\n=== " + name + " ===");
   fn();
}

var SCRIPT = path.join(__dirname, "..", "..", "javascript", "MeteorComposer.js");

// Returns { source, defines }. Directives are replaced by blank lines rather
// than deleted so that a reported line number still points at the real file.
//
// A directive may be continued with a trailing backslash - #feature-info is,
// and its second line reads as ordinary prose. Dropping the first line and
// keeping the second is how a stripper that ignores continuations reports a
// syntax error in a file that has none.
function preprocess(source) {
   var lines = source.split("\n");
   var defines = {};
   var out = [];
   var continuing = false;
   for (var i = 0; i < lines.length; ++i) {
      var line = lines[i];
      if (continuing) {
         out.push("");
         continuing = /\\\s*$/.test(line);
         continue;
      }
      if (/^\s*#(engine|feature-id|feature-info|include)\b/.test(line)) {
         out.push("");
         continuing = /\\\s*$/.test(line);
         continue;
      }
      var def = /^\s*#define\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+(.*?)\s*$/.exec(line);
      if (def !== null) {
         defines[def[1]] = def[2];
         out.push("");
         continuing = /\\\s*$/.test(line);
         continue;
      }
      out.push(line);
   }
   var text = out.join("\n");
   for (var name in defines) {
      text = text.replace(new RegExp("\\b" + name + "\\b", "g"), defines[name]);
   }
   return { source: text, defines: defines };
}

//----------------------------------------------------------------------------

suite("MeteorComposer.js parses", function () {
   ok(fs.existsSync(SCRIPT), "the script exists");
   var raw = fs.readFileSync(SCRIPT, "utf8");

   // Line 1, not line 2. PixInsight 1.9.4 defaults to the legacy SpiderMonkey
   // runtime, which is not in the arm64 build, and the failure is reported in
   // the Process Console only.
   ok(raw.split("\n")[0].trim() === "#engine v8",
      "`#engine v8` is on line 1");

   var pre = preprocess(raw);
   ok(pre.defines.VERSION !== undefined, "a VERSION is defined");
   ok(/^"\d+\.\d+\.\d+"$/.test(pre.defines.VERSION || ""),
      "and it looks like a version: " + pre.defines.VERSION);

   var error = null;
   try {
      new vm.Script(pre.source, { filename: "MeteorComposer.js" });
   } catch (e) {
      error = e;
   }
   ok(error === null,
      "it parses" + (error === null ? "" : " - " + error.message));
});

suite("every #include names a file that is there", function () {
   var raw = fs.readFileSync(SCRIPT, "utf8");
   var dir = path.dirname(SCRIPT);
   var includes = raw.match(/^#include\s+"([^"]+)"/gm) || [];
   ok(includes.length > 0, "there are includes to check");
   for (var i = 0; i < includes.length; ++i) {
      var name = /"([^"]+)"/.exec(includes[i])[1];
      ok(fs.existsSync(path.join(dir, name)), name + " is present");
   }
});

suite("radio buttons are set as a pair, from one place", function () {
   // Comments are stripped first. The explanation of why this rule exists is
   // written next to the code it governs and quotes the assignment it forbids,
   // which the count would otherwise find. Strings are mangled by this too,
   // and that is fine: nothing being counted here lives in one.
   var raw = fs.readFileSync(SCRIPT, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ");

   // PJSR does not expose how radio buttons are grouped, and on 1.9.4 the
   // grouping is measurably not there: with another Control inside the same
   // GroupBox, clicking `Image` left `Edges` on as well. The dialog then said
   // two mutually exclusive things at once.
   //
   // The fix is that each pair is only ever assigned together, in one method.
   // That is what this pins, because the failure is invisible from here - it
   // needs a mouse - and the assignment that breaks it is one line long.
   var pairs = [
      { name: "mask source", setter: "setMaskSource",
        buttons: ["maskEdgesRadio", "maskFileRadio"] },
      { name: "coordinate system", setter: "setCoordinateSystem",
        buttons: ["skyRadio", "groundRadio"] }
   ];

   for (var p = 0; p < pairs.length; ++p) {
      var pair = pairs[p];
      for (var b = 0; b < pair.buttons.length; ++b) {
         var button = pair.buttons[b];
         var assignments = raw.match(
            new RegExp("\\b" + button + "\\.checked\\s*=", "g")) || [];
         ok(assignments.length === 1,
            button + ".checked is assigned in exactly one place, not "
            + assignments.length + " (" + pair.name + " - " + pair.setter + ")");
      }

      // Both halves in the same method, so neither can be set without the
      // other.
      var body = new RegExp(pair.setter + "\\(mode\\)|" + pair.setter
                            + "\\(system\\)");
      ok(body.test(raw), pair.setter + " exists");
   }

   // The handlers must not read the `checked` they are handed. Without the
   // grouping, clicking the button that is already on turns it OFF, and a
   // handler that only acts on `checked === true` would leave the pair with
   // neither selected. A click on a radio means that radio, whichever way it
   // was moving.
   var handlers = raw.match(/\b(?:maskEdgesRadio|maskFileRadio|skyRadio|groundRadio)\.onCheck\s*=\s*function\s*\(([^)]*)\)/g) || [];
   ok(handlers.length === 4, "all four radio handlers are found (got "
      + handlers.length + ")");
   for (var h = 0; h < handlers.length; ++h) {
      var args = /function\s*\(([^)]*)\)/.exec(handlers[h])[1].trim();
      ok(args === "",
         handlers[h].split(".")[0] + " ignores the `checked` argument"
         + (args === "" ? "" : " (takes `" + args + "`)"));
   }
});

suite("the release package ships every module", function () {
   // build-release.sh keeps its own list of files to put in the zip, and it
   // compares that list with the #include lines before building. That check is
   // right, but it only runs at release time - which is where this was found,
   // with the signing already done and a release half started.
   //
   // The cost of getting it wrong is the worst kind: #include is textual
   // concatenation, so a package missing one module is built without complaint
   // and fails on the user's machine at the first call into it, with the error
   // going only to the Process Console.
   var script = fs.readFileSync(SCRIPT, "utf8");
   var buildPath = path.join(__dirname, "..", "..", "build-release.sh");
   ok(fs.existsSync(buildPath), "build-release.sh is there");
   var build = fs.readFileSync(buildPath, "utf8");

   var included = (script.match(/^#include\s+"([^"]+)"/gm) || [])
      .map(function (line) { return /"([^"]+)"/.exec(line)[1]; })
      .sort();

   var listBlock = /MODULES=\(([\s\S]*?)\)/.exec(build);
   ok(listBlock !== null, "build-release.sh declares MODULES");
   var listed = listBlock[1].split(/\s+/)
      .filter(function (name) { return name.length > 0; })
      .sort();

   ok(included.length > 0, "there are includes to ship");
   ok(included.join(",") === listed.join(","),
      "every #include is in MODULES and nothing else is"
      + (included.join(",") === listed.join(",") ? ""
         : "\n        #include: " + included.join(", ")
         + "\n        MODULES:  " + listed.join(", ")));
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

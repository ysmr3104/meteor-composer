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

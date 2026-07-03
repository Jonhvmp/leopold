// Static contract every reference workflow script must satisfy, checked across all of
// them at once: a pure-literal `meta` with name + description (the runtime requires the
// meta block to be a literal, not computed), and no filesystem/shell/module access from
// the script body (only the injected globals and standard JS built-ins are allowed).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { allWorkflowScripts } from "./workflow-harness.ts";

/** Extract the `export const meta = { … }` object literal text via brace matching that
 *  ignores braces inside string/template literals. */
function extractMetaLiteral(src: string): string {
  const m = src.match(/export\s+const\s+meta\s*=\s*/);
  assert.ok(m, "script must declare `export const meta =`");
  let i = (m.index ?? 0) + m[0].length;
  assert.equal(src[i], "{", "meta must be an object literal (starts with `{`), not a variable or call");
  let depth = 0, quote = "";
  for (; i < src.length; i++) {
    const c = src[i], prev = src[i - 1];
    if (quote) { if (c === quote && prev !== "\\") quote = ""; continue; }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return src.slice((m.index ?? 0) + m[0].length, i + 1); }
  }
  throw new Error("unterminated meta object literal");
}

const scripts = allWorkflowScripts();

test("there are workflow scripts to validate", () => {
  assert.ok(scripts.length >= 4, `expected the shipped workflow scripts (leopold-run, leopold-learn, leopold-triage, plan-tournament), found ${scripts.length}`);
});

for (const file of scripts) {
  const name = path.relative(process.cwd(), file);

  test(`${name}: meta is a pure literal with name + description`, () => {
    const src = fs.readFileSync(file, "utf8");
    const literal = extractMetaLiteral(src);
    // A pure literal evaluates with no free variables. If it referenced an identifier
    // or called a function, this throws — which is exactly the failure we want.
    const meta = Function(`"use strict"; return (${literal});`)() as { name?: unknown; description?: unknown; phases?: unknown };
    assert.equal(typeof meta.name, "string");
    assert.ok((meta.name as string).length > 0);
    assert.equal(typeof meta.description, "string");
    assert.ok((meta.description as string).length > 0);
    if (meta.phases !== undefined) assert.ok(Array.isArray(meta.phases));
  });

  test(`${name}: no filesystem, shell, or module access from the script body`, () => {
    const src = fs.readFileSync(file, "utf8");
    const forbidden: Array<[RegExp, string]> = [
      [/\brequire\s*\(/, "require()"],
      [/^\s*import\s+[\w{*]/m, "import statement"],
      [/\bchild_process\b/, "child_process"],
      [/\bprocess\.(?!env\b)/, "process.* (other than the runtime's own)"],
      [/\bfs\.(readFile|writeFile|existsSync|readdir)/, "node:fs"],
    ];
    for (const [re, label] of forbidden) {
      assert.ok(!re.test(src), `${name} must not use ${label}`);
    }
  });
}

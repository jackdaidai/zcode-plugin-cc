import test from "node:test";
import assert from "node:assert/strict";

import { splitRawArgumentString } from "../plugins/zcode/scripts/lib/args.mjs";

test("splitRawArgumentString keeps Windows path backslashes literal", () => {
  assert.deepEqual(splitRawArgumentString("fix C:\\Users\\me\\notes.md now"), [
    "fix",
    "C:\\Users\\me\\notes.md",
    "now"
  ]);
});

test("splitRawArgumentString honors quoted arguments", () => {
  assert.deepEqual(splitRawArgumentString('review "the auth module" quickly'), [
    "review",
    "the auth module",
    "quickly"
  ]);
  assert.deepEqual(splitRawArgumentString("run 'a b' c"), ["run", "a b", "c"]);
});

test("splitRawArgumentString still supports explicit escapes", () => {
  assert.deepEqual(splitRawArgumentString('say \\"hi\\"'), ["say", '"hi"']);
  assert.deepEqual(splitRawArgumentString("one\\ token"), ["one token"]);
  assert.deepEqual(splitRawArgumentString("double \\\\ slash"), ["double", "\\", "slash"]);
});

test("splitRawArgumentString keeps a trailing backslash literal", () => {
  assert.deepEqual(splitRawArgumentString("trailing\\"), ["trailing\\"]);
});

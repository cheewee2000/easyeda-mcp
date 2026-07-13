import { test } from "node:test";
import assert from "node:assert/strict";
import { deepMerge } from "../eda-tools.mjs";

test("merges nested objects, patch wins on leaves", () => {
  const base = { config: { Physics: { Track: { form: { strokeWidthMin: 0.127, strokeWidthMax: 2.54 } } } }, name: "Custom" };
  const patch = { config: { Physics: { Track: { form: { strokeWidthMin: 0.2 } } } } };
  const out = deepMerge(base, patch);
  assert.equal(out.config.Physics.Track.form.strokeWidthMin, 0.2);
  assert.equal(out.config.Physics.Track.form.strokeWidthMax, 2.54);
  assert.equal(out.name, "Custom");
});

test("arrays are replaced wholesale, not merged", () => {
  const out = deepMerge({ t: { table: [[1], [2, 3]] } }, { t: { table: [[9]] } });
  assert.deepEqual(out.t.table, [[9]]);
});

test("does not mutate inputs", () => {
  const base = { a: { b: 1 } };
  const patch = { a: { c: 2 } };
  deepMerge(base, patch);
  assert.deepEqual(base, { a: { b: 1 } });
  assert.deepEqual(patch, { a: { c: 2 } });
});

test("null and primitives in patch replace objects", () => {
  const out = deepMerge({ a: { b: 1 }, c: 5 }, { a: null, c: { d: 1 } });
  assert.equal(out.a, null);
  assert.deepEqual(out.c, { d: 1 });
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { elapsedTime } from "../surge-deploy/live/timeline.js";

test("timeline distinguishes minutes, hours and subsecond point times", () => {
  assert.equal(elapsedTime(0), "0:00");
  assert.equal(elapsedTime(6.131), "0:06");
  assert.equal(elapsedTime(60), "1:00");
  assert.equal(elapsedTime(3599.9), "59:59");
  assert.equal(elapsedTime(3847.468), "1:04:07");
  assert.equal(elapsedTime(86400), "24:00:00");
});

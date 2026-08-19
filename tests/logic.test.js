import assert from "node:assert/strict";
import test from "node:test";
import { computeReasons, verifyReturn, renderAges, isFast } from "../server/logic.mjs";

const cfg = { freshAt: 6, pruneAt: 5000, setupKey: true };
const e = (header, changed, hash, affirmed = null) => ({ header, changed: String(changed), hash, affirmed });

test("virgin file yields a setup reason and suppresses fresh", () => {
  const entries = [e("What they are doing right now", 0, "aaa"), e("What they have not seen", 0, "bbb")];
  const r = computeReasons({ entries, seedFileHash: "F0", fileHash: "F0", fileBytes: 900, turn: 9, cfg, snoozes: [] });
  assert.deepEqual(r.map(x => x.kind), ["setup"]);
});

test("a fast section older than freshAt yields fresh; affirmation counts as touch", () => {
  const entries = [e("What they are doing right now", 1, "aaa"), e("What they have not seen", 1, "bbb", "8")];
  const r = computeReasons({ entries, seedFileHash: "F0", fileHash: "F1", fileBytes: 900, turn: 10, cfg, snoozes: [] });
  assert.deepEqual(r, [{ kind: "fresh", header: "What they are doing right now", baseline: "aaa" }]);
});

test("prune fires over the limit and respects a snooze", () => {
  const entries = [e("What they are doing right now", 9, "aaa")];
  const over = { entries, seedFileHash: "F0", fileHash: "F1", fileBytes: 5100, turn: 10, cfg };
  assert.deepEqual(computeReasons({ ...over, snoozes: [] }).map(x => x.kind), ["prune"]);
  assert.deepEqual(computeReasons({ ...over, snoozes: [{ expiry: 14, reason: "prune" }] }), []);
});

test("verifyReturn: setup passes on any whole-file change; fresh by hash move or affirm; prune strictly", () => {
  const reasons = [{ kind: "setup", baseline: "F0" },
                   { kind: "fresh", header: "What they have not seen", baseline: "bbb" },
                   { kind: "prune", baseline: 5100 }];
  const entries = [e("What they have not seen", 3, "bbb")];
  const fail = verifyReturn({ reasons, entries, fileHash: "F0", fileBytes: 5100, affirm: [], pruneAt: 5000 });
  assert.equal(fail.pass, false);
  assert.equal(fail.failures.length, 3);
  const ok = verifyReturn({ reasons, entries, fileHash: "F9", fileBytes: 4400,
                            affirm: ["What they have not seen"], pruneAt: 5000 });
  assert.equal(ok.pass, true);
  assert.deepEqual(ok.affirmed, ["What they have not seen"]);
});

test("renderAges annotates headers as tuples", () => {
  const text = "## What they are doing right now\nbody\n";
  const out = renderAges(text, [e("What they are doing right now", 3, "aaa", "7")], 9);
  assert.match(out, /^## What they are doing right now \(changed turn 3, 6 ago; affirmed turn 7\)$/m);
});

test("isFast matches by case-insensitive prefix", () => {
  assert.ok(isFast("Still open — asked, not delivered"));
  assert.ok(!isFast("Their words"));
});

test("freshness boundary: touch exactly freshAt turns old is not due; one turn older is", () => {
  const atBoundary = [e("What they are doing right now", 4, "aaa")];
  assert.deepEqual(
    computeReasons({ entries: atBoundary, seedFileHash: "F0", fileHash: "F1", fileBytes: 900, turn: 10, cfg, snoozes: [] }),
    [],
  );
  const pastBoundary = [e("What they are doing right now", 3, "aaa")];
  assert.deepEqual(
    computeReasons({ entries: pastBoundary, seedFileHash: "F0", fileHash: "F1", fileBytes: 900, turn: 10, cfg, snoozes: [] }).map(x => x.kind),
    ["fresh"],
  );
});

test("prune boundary: fileBytes exactly at pruneAt does not issue; a return at pruneAt fails strict verify", () => {
  const entries = [e("What they are doing right now", 9, "aaa")];
  assert.deepEqual(
    computeReasons({ entries, seedFileHash: "F0", fileHash: "F1", fileBytes: 5000, turn: 10, cfg, snoozes: [] }),
    [],
  );
  const reasons = [{ kind: "prune", baseline: 5100 }];
  const verdict = verifyReturn({ reasons, entries, fileHash: "F1", fileBytes: 5000, affirm: [], pruneAt: 5000 });
  assert.equal(verdict.pass, false);
  assert.match(verdict.failures[0], /still 5000 bytes, limit 5000/);
});

test("a gone fast section counts for fresh, cannot pass by hash-move, and renderAges skips it", () => {
  const goneEntries = [e("Still open — asked, not delivered", 2, "gone")];
  const r = computeReasons({ entries: goneEntries, seedFileHash: "F0", fileHash: "F1", fileBytes: 900, turn: 20, cfg, snoozes: [] });
  assert.deepEqual(r, [{ kind: "fresh", header: "Still open — asked, not delivered", baseline: "gone" }]);

  const failed = verifyReturn({ reasons: r, entries: goneEntries, fileHash: "F1", fileBytes: 900, affirm: [], pruneAt: 5000 });
  assert.equal(failed.pass, false, "a hash of 'gone' can never register as moved");
  const passedByAffirm = verifyReturn({
    reasons: r, entries: goneEntries, fileHash: "F1", fileBytes: 900,
    affirm: ["Still open — asked, not delivered"], pruneAt: 5000,
  });
  assert.equal(passedByAffirm.pass, true);

  const rendered = renderAges("## Still open — asked, not delivered\nbody\n", goneEntries, 20);
  assert.equal(rendered, "## Still open — asked, not delivered\nbody\n");
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../surge-deploy/app.js", import.meta.url), "utf8");
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `${start}: source section must exist`);
  return source.slice(from, to);
}

const context = vm.createContext({});
vm.runInContext([
  section("function normalizePlayerName(", "function inferPlayerGenderFromName("),
  section("const playerTextTagRules = [", "const playerAssetProfiles = ["),
].join("\n"), context);
const { playerTextTags, isHiddenFromRankings, visibleRankingStandings } = vm.runInContext(
  "({ playerTextTags, isHiddenFromRankings, visibleRankingStandings })", context,
);

test("Sungsoo Park uses the national C tag and its matching style", () => {
  for (const name of ["\ubc15\uc131\uc218", " \ubc15\uc131\uc218 (jadeontheriver) "]) {
    const tags = Array.from(playerTextTags({ name }), (tag) => [tag.label, tag.className]);
    assert.deepEqual(tags, [["\uc804\uad6dC\uc870", "player-text-tag--national-c"]]);
    assert.equal(isHiddenFromRankings({ name }), false);
  }
  assert.equal(playerTextTags({ name: "\uac15\uacbd\uad6d" })[0].label, "\uc9c0\uc5edB\uc870");
});

test("ranking hides all three configured names, including account suffixes", () => {
  for (const name of ["\uc870\ubbfc\uc2e0", "\ub4dc\ub2c8\uc26c", "\uc5fc\uc120\uc6c5"]) {
    assert.equal(isHiddenFromRankings({ name }), true);
    assert.equal(isHiddenFromRankings({ name: ` ${name} (account.id) ` }), true);
    assert.equal(isHiddenFromRankings({ name: `${name}2` }), false);
  }
});

test("ranking filtering preserves source players, ratings, matches, and row order", () => {
  const players = Object.freeze([
    Object.freeze({ id: "d", name: "\ub4dc\ub2c8\uc26c", rating: 2201 }),
    Object.freeze({ id: "p", name: "\ubc15\uc131\uc218", rating: 2016 }),
    Object.freeze({ id: "j", name: "\uc870\ubbfc\uc2e0", rating: 1987 }),
    Object.freeze({ id: "s", name: "\uc5fc\uc120\uc6c5 (seonung)", rating: 1737 }),
    Object.freeze({ id: "r", name: "\ub958\ucca0", rating: 1700 }),
  ]);
  const matches = Object.freeze([Object.freeze({ id: "match", teamA: ["d", "s"], teamB: ["p", "j"] })]);
  const state = Object.freeze({ players, matches });
  const before = JSON.stringify(state);
  const visible = visibleRankingStandings(players);
  assert.deepEqual(Array.from(visible, (player) => player.id), ["p", "r"]);
  assert.equal(visible[0], players[1]);
  assert.equal(visible[1], players[4]);
  assert.equal(JSON.stringify(state), before);
});

test("match history still renders games involving hidden ranking players", () => {
  const matches = [
    { id: "older", teamA: ["d", "s"], teamB: ["p", "j"] },
    { id: "newer", teamA: ["p", "r"], teamB: ["d", "s"] },
  ];
  const list = { innerHTML: "", scrollTop: 0 };
  const rendered = [];
  let pageCount;
  const history = vm.createContext({
    state: { matches },
    $: (selector) => selector === "#historyList" ? list : { classList: { toggle() {} } },
    sortedMatches: () => [...matches],
    paginatedItems: (_section, items) => ({ items }),
    renderHistoryItem: (match) => { rendered.push(match); return match.id; },
    shouldPreserveScroll: () => false,
    renderPagination: (_section, count) => { pageCount = count; },
    isHiddenFromRankings,
    visibleRankingStandings,
  });
  vm.runInContext(`${section("function renderHistory(", "function renderPreview(")}\nrenderHistory();`, history);
  assert.deepEqual(rendered, [matches[1], matches[0]]);
  assert.equal(pageCount, 2);
  assert.equal(list.innerHTML, "newerolder");
  assert.equal(matches.length, 2);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../surge-deploy/app.js", import.meta.url), "utf8");
const assetStart = source.indexOf("const playerAssetProfiles = [");
const assetEnd = source.indexOf("function playerName(", assetStart);
assert.ok(assetStart >= 0 && assetEnd > assetStart, "Player asset definitions must exist");
const accountCode = source.slice(source.indexOf("function playerAccountId("), source.indexOf("function playerAccountRole("));
const normalizeCode = source.slice(source.indexOf("function normalizeUsername("), source.indexOf("function normalizeRole("));
const context = vm.createContext({
  state: { users: [] },
  normalizePlayerGender: (gender) => gender,
});
vm.runInContext(`${normalizeCode}\n${accountCode}\n${source.slice(assetStart, assetEnd)}`, context);
const api = vm.runInContext("({ playerCardProfile, playerPhotoUrl, playerCardTier, playerCardArtUrl })", context);
const members = [
  { identity: "sanghyun-lee", account: "sh0620.lee", workday: "sh0620.lee", name: "\uc774\uc0c1\ud604" },
  { identity: "hojin-kim", account: "hojin95", workday: "hojin59.kim", name: "\uae40\ud638\uc9c4" },
  { identity: "minjae-na", account: "minjae", workday: "minjaena.na", name: "\ub098\ubbfc\uc7ac" },
];

async function assertJpeg(relativePath) {
  const bytes = await readFile(new URL(`../surge-deploy/${relativePath}`, import.meta.url));
  assert.ok(bytes.length > 1000, `${relativePath}: image must not be empty`);
  assert.equal(bytes.readUInt16BE(0), 0xffd8, `${relativePath}: JPEG start`);
  assert.equal(bytes.readUInt16BE(bytes.length - 2), 0xffd9, `${relativePath}: JPEG end`);
}

for (const member of members) {
  test(`${member.identity}: login account and Workday identity stay separate`, () => {
    const player = { name: "Renamed player", accountUsername: member.account, gender: "male" };
    const profile = api.playerCardProfile(player);
    assert.equal(profile.identity, member.identity);
    assert.deepEqual(Array.from(profile.accountIds), [member.account]);
    assert.deepEqual(Array.from(profile.workdaySearchIds), [member.workday]);
    assert.equal(api.playerCardProfile({ ...player, accountUsername: ` ${member.account.toUpperCase()} ` }).identity, member.identity);
    assert.equal(api.playerCardProfile({ name: member.name }), null, "Unlinked players must not gain a card through a name match");
  });

  test(`${member.identity}: every tier resolves to its own generated JPEG`, async () => {
    const player = { name: member.name, accountUsername: member.account, gender: "male" };
    assert.equal(api.playerPhotoUrl(player), `./assets/player-photos/${member.identity}.jpg`);
    await assertJpeg(api.playerPhotoUrl(player));
    for (const [rating, tier] of [[1200, "c"], [1300, "b"], [1499, "b"], [1500, "a"], [1699, "a"], [1700, "s"], [2000, "s"]]) {
      const ranked = { ...player, rating };
      const actualTier = api.playerCardTier(ranked);
      assert.equal(actualTier.key, tier);
      const art = api.playerCardArtUrl(ranked, actualTier);
      assert.equal(art, `./assets/player-cards/${member.identity}-${tier}-figure.jpg`);
      await assertJpeg(art);
    }
    const unranked = api.playerCardTier(player);
    assert.equal(unranked.key, "unranked");
    assert.equal(api.playerCardArtUrl(player, unranked), `./assets/player-cards/${member.identity}-c-figure.jpg`);
  });
}

test("new player profile photos are distinct files", async () => {
  const photos = [];
  for (const { identity } of members) {
    photos.push((await readFile(new URL(`../surge-deploy/assets/player-photos/${identity}.jpg`, import.meta.url))).toString("base64"));
  }
  assert.equal(new Set(photos).size, members.length);
});

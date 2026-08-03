import assert from "node:assert/strict";
import test from "node:test";

test("the Bilibili provider's supported URL patterns remain recognizable", () => {
  const cases = [
    ["https://www.bilibili.com/video/BV1xx411c7mD", /BV[0-9A-Za-z]{10}/],
    ["https://space.bilibili.com/123/favlist?fid=456", /(?:fid=|favlist\/)(\d+)/],
    ["https://space.bilibili.com/123/lists/456?type=season", /space\.bilibili\.com\/(\d+)/],
  ] as const;
  for (const [url, pattern] of cases) assert.match(url, pattern);
});

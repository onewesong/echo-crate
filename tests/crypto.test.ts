import assert from "node:assert/strict";
import test from "node:test";
import { decrypt, encrypt } from "../server/crypto.ts";

test("Bilibili session encryption round-trips", () => {
  process.env.ECHOCRATE_SECRET = "a".repeat(64);
  const value = "SESSDATA=secret; bili_jct=csrf";
  const encrypted = encrypt(value);
  assert.notEqual(encrypted, value);
  assert.equal(decrypt(encrypted), value);
});

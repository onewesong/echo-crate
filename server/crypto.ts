import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function keyFromEnv() {
  let raw = process.env.ECHOCRATE_SECRET || process.env.BILIMUSIC_SECRET;
  if (!raw) {
    const dataDir = process.env.DATA_DIR || join(process.cwd(), "data");
    const keyFile = join(dataDir, "session.key");
    mkdirSync(dataDir, { recursive: true });
    if (!existsSync(keyFile)) {
      writeFileSync(keyFile, randomBytes(32).toString("hex"), { mode: 0o600 });
      chmodSync(keyFile, 0o600);
    }
    raw = readFileSync(keyFile, "utf8").trim();
  }
  return /^[a-f0-9]{64}$/i.test(raw)
    ? Buffer.from(raw, "hex")
    : createHash("sha256").update(raw).digest();
}

export function encrypt(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFromEnv(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64url");
}

export function decrypt(value: string) {
  const payload = Buffer.from(value, "base64url");
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const decipher = createDecipheriv("aes-256-gcm", keyFromEnv(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString("utf8");
}

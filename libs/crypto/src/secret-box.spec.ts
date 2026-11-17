import { describe, expect, it } from "vitest";
import { LocalKeyWrapper, SecretBox } from "./secret-box.js";

const box = new SecretBox(new LocalKeyWrapper(LocalKeyWrapper.generateKey()));
const plaintext = Buffer.from('{"cookies":[]}');

describe("SecretBox", () => {
  it("opens what it sealed", async () => {
    const sealed = await box.seal(plaintext, "account-1:storage_state");
    expect(sealed.ciphertext.includes(plaintext)).toBe(false);
    expect((await box.open(sealed, "account-1:storage_state")).toString()).toBe(plaintext.toString());
  });

  it("uses a new data key and nonce every time", async () => {
    const [first, second] = [await box.seal(plaintext, "c"), await box.seal(plaintext, "c")];
    expect(first.wrappedDek.equals(second.wrappedDek)).toBe(false);
    expect(first.nonce.equals(second.nonce)).toBe(false);
  });

  it("refuses a secret moved to another account or kind", async () => {
    const sealed = await box.seal(plaintext, "account-1:storage_state");
    await expect(box.open(sealed, "account-2:storage_state")).rejects.toThrow();
    await expect(box.open(sealed, "account-1:password")).rejects.toThrow();
  });

  it("refuses tampered ciphertext", async () => {
    const sealed = await box.seal(plaintext, "c");
    sealed.ciphertext[0]! ^= 1;
    await expect(box.open(sealed, "c")).rejects.toThrow();
  });

  it("refuses another master key", async () => {
    const sealed = await box.seal(plaintext, "c");
    const other = new SecretBox(new LocalKeyWrapper(LocalKeyWrapper.generateKey()));
    await expect(other.open(sealed, "c")).rejects.toThrow();
  });

  it("refuses a master key of the wrong size", () => {
    expect(() => new LocalKeyWrapper(Buffer.alloc(16).toString("base64"))).toThrow("32 bytes");
  });
});

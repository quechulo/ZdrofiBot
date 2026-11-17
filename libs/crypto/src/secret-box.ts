import crypto from "node:crypto";

const CIPHER = "aes-256-gcm";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Wraps and unwraps data keys. In production this is Cloud KMS, so the master key
 * never leaves Google. `context` is bound to the wrapped key, so a key copied to
 * another row won't unwrap there.
 */
export interface KeyWrapper {
  wrap(dataKey: Buffer, context: string): Promise<Buffer>;
  unwrap(wrapped: Buffer, context: string): Promise<Buffer>;
}

/** Matches the columns of `secret_blobs`. */
export interface SealedSecret {
  /** Ciphertext followed by the GCM tag. */
  ciphertext: Buffer;
  nonce: Buffer;
  wrappedDek: Buffer;
}

function encrypt(key: Buffer, plaintext: Buffer, context: string): { ciphertext: Buffer; nonce: Buffer } {
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv(CIPHER, key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { ciphertext, nonce };
}

function decrypt(key: Buffer, ciphertext: Buffer, nonce: Buffer, context: string): Buffer {
  if (ciphertext.length < TAG_BYTES) throw new Error("Ciphertext is too short");
  const decipher = crypto.createDecipheriv(CIPHER, key, nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - TAG_BYTES));
  return Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - TAG_BYTES)), decipher.final()]);
}

/**
 * For development and tests only: the master key sits in an environment
 * variable. Production uses KMS, added in M6.
 */
export class LocalKeyWrapper implements KeyWrapper {
  private readonly key: Buffer;

  constructor(base64Key: string) {
    const key = Buffer.from(base64Key, "base64");
    if (key.length !== KEY_BYTES) throw new Error(`The local key must be ${KEY_BYTES} bytes, base64-encoded`);
    this.key = key;
  }

  static generateKey(): string {
    return crypto.randomBytes(KEY_BYTES).toString("base64");
  }

  async wrap(dataKey: Buffer, context: string): Promise<Buffer> {
    const { ciphertext, nonce } = encrypt(this.key, dataKey, context);
    return Buffer.concat([nonce, ciphertext]);
  }

  async unwrap(wrapped: Buffer, context: string): Promise<Buffer> {
    return decrypt(this.key, wrapped.subarray(NONCE_BYTES), wrapped.subarray(0, NONCE_BYTES), context);
  }
}

/** Envelope encryption: every secret gets its own data key. */
export class SecretBox {
  constructor(private readonly wrapper: KeyWrapper) {}

  async seal(plaintext: Buffer, context: string): Promise<SealedSecret> {
    const dataKey = crypto.randomBytes(KEY_BYTES);
    try {
      const { ciphertext, nonce } = encrypt(dataKey, plaintext, context);
      return { ciphertext, nonce, wrappedDek: await this.wrapper.wrap(dataKey, context) };
    } finally {
      dataKey.fill(0);
    }
  }

  async open(sealed: SealedSecret, context: string): Promise<Buffer> {
    const dataKey = await this.wrapper.unwrap(sealed.wrappedDek, context);
    try {
      return decrypt(dataKey, sealed.ciphertext, sealed.nonce, context);
    } finally {
      dataKey.fill(0);
    }
  }
}

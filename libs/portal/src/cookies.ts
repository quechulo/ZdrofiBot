export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}

export interface StoredState {
  cookies: StoredCookie[];
  origins: unknown[];
}

export type CookieChange = "added" | "rotated" | "unchanged" | "deleted";

const SESSION_COOKIE = "SULUSESSID";

/** The portal's cookies, kept in Playwright's storageState shape. Never log this. */
export class PortalCookieJar {
  private state: StoredState;

  constructor(
    private readonly host: string,
    state: StoredState = { cookies: [], origins: [] },
  ) {
    this.state = structuredClone(state);
  }

  private matches(cookie: StoredCookie): boolean {
    const bare = cookie.domain.replace(/^\./, "");
    return this.host === bare || this.host.endsWith(`.${bare}`);
  }

  header(): string {
    return this.state.cookies
      .filter((cookie) => this.matches(cookie))
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");
  }

  hasSession(): boolean {
    return this.state.cookies.some((cookie) => cookie.name === SESSION_COOKIE && this.matches(cookie));
  }

  apply(setCookie: string): { name: string; change: CookieChange } {
    const [pair = "", ...attributeParts] = setCookie.split(";");
    const separator = pair.indexOf("=");
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    const attributes = attributeParts.map((part) => part.trim().toLowerCase());
    const maxAge = attributes.find((part) => part.startsWith("max-age="))?.split("=")[1];
    const expires = attributes.find((part) => part.startsWith("expires="))?.slice("expires=".length);
    const expired =
      maxAge === "0" || value === "" || (expires !== undefined && new Date(expires).getTime() <= Date.now());

    const existing = this.state.cookies.find((cookie) => cookie.name === name && this.matches(cookie));
    if (expired) {
      this.state.cookies = this.state.cookies.filter((cookie) => cookie !== existing);
      return { name, change: "deleted" };
    }
    if (!existing) {
      this.state.cookies.push({
        name,
        value,
        domain: this.host,
        path: "/",
        expires: -1,
        httpOnly: attributes.includes("httponly"),
        secure: attributes.includes("secure"),
        sameSite: "Lax",
      });
      return { name, change: "added" };
    }
    const change = existing.value === value ? "unchanged" : "rotated";
    existing.value = value;
    return { name, change };
  }

  toState(): StoredState {
    return structuredClone(this.state);
  }
}

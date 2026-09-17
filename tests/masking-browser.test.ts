import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MASKED,
  UNMASKED,
  adoptSavedMaskingPolicy,
  captureBrowserMaskingIntent,
  reconcileBrowserMaskingChoice,
  writeBrowserMaskingChoice,
} from "~/lib/masking";

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

class CookieJar {
  value: string | undefined;
  writes: string[] = [];

  get cookie() {
    return this.value === undefined ? "" : `masked=${this.value}`;
  }

  set cookie(cookie: string) {
    this.writes.push(cookie);
    if (/^masked=;/.test(cookie) && /max-age=0/i.test(cookie)) {
      this.value = undefined;
      return;
    }
    const match = /^masked=([^;]+)/.exec(cookie);
    if (match !== null) this.value = match[1];
  }

  get lastWrite() {
    return this.writes.at(-1) ?? "";
  }
}

function deferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
let jar: CookieJar;

function installStorage(storage: Storage) {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
}

beforeEach(() => {
  jar = new CookieJar();
  Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
  Object.defineProperty(globalThis, "document", { configurable: true, value: jar });
  installStorage(new MemoryStorage());
});

afterEach(() => {
  for (const [name, descriptor] of [
    ["window", originalWindow],
    ["document", originalDocument],
    ["localStorage", originalStorage],
  ] as const) {
    if (descriptor === undefined) delete (globalThis as Record<string, unknown>)[name];
    else Object.defineProperty(globalThis, name, descriptor);
  }
});

describe("an enhanced masking toggle", () => {
  it("keeps a Show session-scoped when a stale tab learns the fresh fixed policy", () => {
    const written = writeBrowserMaskingChoice(false);
    expect(jar.lastWrite).not.toMatch(/max-age/i);

    reconcileBrowserMaskingChoice(written, {
      masked: false,
      maskingPolicy: "masked",
      maskingResolved: true,
    });

    expect(jar.value).toBe(UNMASKED);
    expect(jar.lastWrite).not.toMatch(/max-age/i);
  });

  it("extends an unchanged choice only after fresh policy confirms as-last-left", () => {
    const written = writeBrowserMaskingChoice(false);

    reconcileBrowserMaskingChoice(written, {
      masked: false,
      maskingPolicy: "as_last_left",
      maskingResolved: true,
    });

    expect(jar.value).toBe(UNMASKED);
    expect(jar.lastWrite).toMatch(/max-age=/i);
  });

  it("fails closed with a session Hide when policy revalidation fails", () => {
    const written = writeBrowserMaskingChoice(false);

    reconcileBrowserMaskingChoice(written, {
      masked: true,
      maskingPolicy: "masked",
      maskingResolved: false,
    });

    expect(jar.value).toBe(MASKED);
    expect(jar.lastWrite).not.toMatch(/max-age/i);
  });

  it("does not overwrite a newer Hide", () => {
    const staleShow = writeBrowserMaskingChoice(false);
    writeBrowserMaskingChoice(true);

    reconcileBrowserMaskingChoice(staleShow, {
      masked: false,
      maskingPolicy: "masked",
      maskingResolved: true,
    });

    expect(jar.value).toBe(MASKED);
    expect(jar.lastWrite).not.toMatch(/max-age/i);
  });

  it("restores Hide when it wins between the ordering check and cookie rewrite", () => {
    const staleShow = writeBrowserMaskingChoice(false);
    const newerIntent = "newer-hide-intent";
    let firstRead = true;
    installStorage({
      getItem() {
        if (firstRead) {
          firstRead = false;
          jar.value = MASKED;
          return staleShow.intent ?? null;
        }
        return newerIntent;
      },
    } as unknown as Storage);

    reconcileBrowserMaskingChoice(staleShow, {
      masked: false,
      maskingPolicy: "as_last_left",
      maskingResolved: true,
    });

    expect(jar.value).toBe(MASKED);
    expect(jar.lastWrite).not.toMatch(/max-age/i);
  });

  it("does not mistake a newer Show after Hide for the older Show", () => {
    const staleShow = writeBrowserMaskingChoice(false);
    writeBrowserMaskingChoice(true);
    writeBrowserMaskingChoice(false);
    const newerWrite = jar.lastWrite;

    reconcileBrowserMaskingChoice(staleShow, {
      masked: false,
      maskingPolicy: "masked",
      maskingResolved: true,
    });

    expect(jar.value).toBe(UNMASKED);
    expect(jar.lastWrite).toBe(newerWrite);
  });

  it("leaves the staged session cookie alone when local storage is unavailable", () => {
    installStorage({
      getItem() {
        throw new Error("storage unavailable");
      },
      setItem() {
        throw new Error("storage unavailable");
      },
      removeItem() {
        throw new Error("storage unavailable");
      },
    } as unknown as Storage);
    const written = writeBrowserMaskingChoice(false);
    const writesBeforeRevalidation = jar.writes.length;

    reconcileBrowserMaskingChoice(written, {
      masked: false,
      maskingPolicy: "masked",
      maskingResolved: true,
    });

    expect(jar.value).toBe(UNMASKED);
    expect(jar.lastWrite).not.toMatch(/max-age/i);
    expect(jar.writes).toHaveLength(writesBeforeRevalidation);
  });

  it("does not reconcile a same-value choice when storage cannot distinguish an ABA", () => {
    installStorage({
      getItem() {
        throw new Error("storage unavailable");
      },
      setItem() {
        throw new Error("storage unavailable");
      },
      removeItem() {
        throw new Error("storage unavailable");
      },
    } as unknown as Storage);
    const staleShow = writeBrowserMaskingChoice(false);
    writeBrowserMaskingChoice(true);
    writeBrowserMaskingChoice(false);
    const writesBeforeRevalidation = jar.writes.length;

    reconcileBrowserMaskingChoice(staleShow, {
      masked: true,
      maskingPolicy: "as_last_left",
      maskingResolved: true,
    });

    expect(jar.value).toBe(UNMASKED);
    expect(jar.lastWrite).not.toMatch(/max-age/i);
    expect(jar.writes).toHaveLength(writesBeforeRevalidation);
  });
});

describe("an enhanced Display policy save", () => {
  it("uses a session bridge and clears it after successful root revalidation", async () => {
    const intent = captureBrowserMaskingIntent();
    const revalidation = deferred();
    const adopting = adoptSavedMaskingPolicy("as_last_left", intent, () => revalidation.promise);

    expect(jar.value).toBe(MASKED);
    expect(jar.lastWrite).not.toMatch(/max-age/i);
    revalidation.resolve();
    await adopting;

    expect(jar.value).toBeUndefined();
  });

  it("keeps the session bridge when root revalidation rejects", async () => {
    const intent = captureBrowserMaskingIntent();
    const revalidation = deferred();
    const adopting = adoptSavedMaskingPolicy("masked", intent, () => revalidation.promise);
    revalidation.reject(new Error("loader failed"));

    await expect(adopting).resolves.toBeUndefined();
    expect(jar.value).toBe(MASKED);
    expect(jar.lastWrite).not.toMatch(/max-age/i);
  });

  it("preserves the cookie when local storage cannot establish an ordering point", async () => {
    jar.cookie = "masked=0; Path=/; SameSite=Lax; Max-Age=31536000";
    installStorage({
      getItem() {
        throw new Error("storage unavailable");
      },
      setItem() {
        throw new Error("storage unavailable");
      },
    } as unknown as Storage);

    await adoptSavedMaskingPolicy("masked", captureBrowserMaskingIntent(), async () => undefined);

    expect(jar.value).toBe(UNMASKED);
    expect(jar.lastWrite).toMatch(/max-age=/i);
  });

  it("does not clear a newer Hide after revalidation", async () => {
    const intent = captureBrowserMaskingIntent();
    const revalidation = deferred();
    const adopting = adoptSavedMaskingPolicy("unmasked", intent, () => revalidation.promise);
    writeBrowserMaskingChoice(true);
    const newerWrite = jar.lastWrite;
    revalidation.resolve();
    await adopting;

    expect(jar.value).toBe(MASKED);
    expect(jar.lastWrite).toBe(newerWrite);
  });

  it("does not clear a newer Show after revalidation", async () => {
    const intent = captureBrowserMaskingIntent();
    const revalidation = deferred();
    const adopting = adoptSavedMaskingPolicy("masked", intent, () => revalidation.promise);
    writeBrowserMaskingChoice(false);
    const newerWrite = jar.lastWrite;
    revalidation.resolve();
    await adopting;

    expect(jar.value).toBe(UNMASKED);
    expect(jar.lastWrite).toBe(newerWrite);
  });

  it("does not clear a newer Show-then-Hide ABA", async () => {
    const intent = captureBrowserMaskingIntent();
    const revalidation = deferred();
    const adopting = adoptSavedMaskingPolicy("unmasked", intent, () => revalidation.promise);
    writeBrowserMaskingChoice(false);
    writeBrowserMaskingChoice(true);
    const newerWrite = jar.lastWrite;
    revalidation.resolve();
    await adopting;

    expect(jar.value).toBe(MASKED);
    expect(jar.lastWrite).toBe(newerWrite);
  });
});

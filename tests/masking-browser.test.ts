/**
 * Browser globals stay deliberately small. Cookie-setter re-entry models separate tabs sharing one
 * non-atomic cookie jar; resetting modules gives every test the isolated tab state real tabs have.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let masking: typeof import("~/lib/masking");
let MASKED: typeof masking.MASKED;
let UNMASKED: typeof masking.UNMASKED;

function writeBrowserMaskingChoice(masked: boolean) {
  return masking.writeBrowserMaskingChoice(masked);
}

function reconcileBrowserMaskingChoice(
  ...args: Parameters<typeof masking.reconcileBrowserMaskingChoice>
) {
  return masking.reconcileBrowserMaskingChoice(...args);
}

function captureBrowserMaskingIntent() {
  return masking.captureBrowserMaskingIntent();
}

function adoptSavedMaskingPolicy(...args: Parameters<typeof masking.adoptSavedMaskingPolicy>) {
  return masking.adoptSavedMaskingPolicy(...args);
}

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

class TrackedEventTarget extends EventTarget {
  readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

  override addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean,
  ) {
    super.addEventListener(type, callback, options);
    if (callback !== null) {
      const listeners = this.listeners.get(type) ?? new Set();
      listeners.add(callback);
      this.listeners.set(type, listeners);
    }
  }

  override removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean,
  ) {
    super.removeEventListener(type, callback, options);
    if (callback !== null) this.listeners.get(type)?.delete(callback);
  }

  listenerCount(type: string) {
    return this.listeners.get(type)?.size ?? 0;
  }
}

class CookieJar extends TrackedEventTarget {
  value: string | undefined;
  writes: string[] = [];
  beforeWrite: (() => void) | undefined;
  afterWrite: (() => void) | undefined;
  nextRead: string | undefined;
  visibilityState: DocumentVisibilityState = "visible";

  get cookie() {
    if (this.nextRead !== undefined) {
      const cookie = this.nextRead;
      this.nextRead = undefined;
      return cookie;
    }
    return this.value === undefined ? "" : `masked=${this.value}`;
  }

  set cookie(cookie: string) {
    const beforeWrite = this.beforeWrite;
    this.beforeWrite = undefined;
    beforeWrite?.();
    this.writes.push(cookie);
    if (/^masked=;/.test(cookie) && /max-age=0/i.test(cookie)) {
      this.value = undefined;
    } else {
      const match = /^masked=([^;]+)/.exec(cookie);
      if (match !== null) this.value = match[1];
    }
    const afterWrite = this.afterWrite;
    this.afterWrite = undefined;
    afterWrite?.();
  }

  get lastWrite() {
    return this.writes.at(-1) ?? "";
  }
}

class ChannelStub extends TrackedEventTarget {
  static instances: ChannelStub[] = [];
  readonly messages: unknown[] = [];
  readonly name: string;
  closed = false;

  constructor(name: string) {
    super();
    this.name = name;
    ChannelStub.instances.push(this);
  }

  postMessage(message: unknown) {
    this.messages.push(message);
  }

  close() {
    this.closed = true;
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
const originalBroadcastChannel = Object.getOwnPropertyDescriptor(globalThis, "BroadcastChannel");
let jar: CookieJar;
let windowTarget: TrackedEventTarget;

function installStorage(storage: Storage) {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
}

beforeEach(async () => {
  vi.resetModules();
  masking = await import("~/lib/masking");
  MASKED = masking.MASKED;
  UNMASKED = masking.UNMASKED;
  jar = new CookieJar();
  windowTarget = new TrackedEventTarget();
  ChannelStub.instances = [];
  Object.defineProperty(globalThis, "window", { configurable: true, value: windowTarget });
  Object.defineProperty(globalThis, "document", { configurable: true, value: jar });
  Object.defineProperty(globalThis, "BroadcastChannel", {
    configurable: true,
    value: ChannelStub,
  });
  installStorage(new MemoryStorage());
});

afterEach(() => {
  for (const [name, descriptor] of [
    ["window", originalWindow],
    ["document", originalDocument],
    ["localStorage", originalStorage],
    ["BroadcastChannel", originalBroadcastChannel],
  ] as const) {
    if (descriptor === undefined) delete (globalThis as Record<string, unknown>)[name];
    else Object.defineProperty(globalThis, name, descriptor);
  }
});

describe("an enhanced masking toggle", () => {
  it("keeps a newer Hide when it completes between an older Show intent and cookie write", () => {
    jar.beforeWrite = () => writeBrowserMaskingChoice(true);

    writeBrowserMaskingChoice(false);

    expect(jar.value).toBe(MASKED);
    expect(jar.lastWrite).not.toMatch(/max-age/i);
  });

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

  it("linearizes a new Hide before an older reconciliation can restore Show", () => {
    const staleShow = writeBrowserMaskingChoice(false);
    jar.afterWrite = () => {
      // The old reconciliation read Show immediately before this tab assigned Hide. Its next
      // operation observes the ordering token; the cookie getter returns that prior read once.
      jar.nextRead = `masked=${UNMASKED}`;
      reconcileBrowserMaskingChoice(staleShow, {
        masked: false,
        maskingPolicy: "as_last_left",
        maskingResolved: true,
      });
    };

    writeBrowserMaskingChoice(true);

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
    const writesBeforeSave = jar.writes.length;
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
    expect(jar.writes).toHaveLength(writesBeforeSave);
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

describe("the browser masking store", () => {
  it("adopts external Hide but keeps external Show behind the local reveal gate", () => {
    jar.value = UNMASKED;
    expect(masking.browserMaskingStore.getSnapshot()).toBe(UNMASKED);
    const subscriber = vi.fn();
    const unsubscribe = masking.browserMaskingStore.subscribe(subscriber);
    const channel = ChannelStub.instances[0]!;

    jar.value = MASKED;
    channel.dispatchEvent(new Event("message"));
    expect(subscriber).toHaveBeenCalledTimes(1);
    expect(masking.browserMaskingStore.getSnapshot()).toBe(MASKED);

    jar.value = UNMASKED;
    channel.dispatchEvent(new Event("message"));
    expect(subscriber).toHaveBeenCalledTimes(1);
    expect(masking.browserMaskingStore.getSnapshot()).toBe(MASKED);
    unsubscribe();
  });

  it("announces a local cookie write to the browser's other tabs", () => {
    const unsubscribe = masking.browserMaskingStore.subscribe(() => undefined);
    const channel = ChannelStub.instances[0]!;

    writeBrowserMaskingChoice(true);
    expect(channel.messages).toEqual(["changed"]);

    // The channel goes with the last subscriber, so a tab drawing no amounts announces nothing.
    unsubscribe();
    writeBrowserMaskingChoice(false);
    expect(channel.messages).toEqual(["changed"]);
  });

  it("starts watchers for the first subscriber and stops them after the last", () => {
    const first = masking.browserMaskingStore.subscribe(() => undefined);
    const second = masking.browserMaskingStore.subscribe(() => undefined);
    const channel = ChannelStub.instances[0]!;

    expect(ChannelStub.instances).toHaveLength(1);
    expect(windowTarget.listenerCount("focus")).toBe(1);
    expect(jar.listenerCount("visibilitychange")).toBe(1);
    expect(channel.listenerCount("message")).toBe(1);
    first();
    expect(windowTarget.listenerCount("focus")).toBe(1);

    second();
    expect(windowTarget.listenerCount("focus")).toBe(0);
    expect(jar.listenerCount("visibilitychange")).toBe(0);
    expect(channel.listenerCount("message")).toBe(0);
    expect(channel.closed).toBe(true);
  });

  it("adopts a Hide on the first snapshot after an interval with no subscribers", () => {
    jar.value = UNMASKED;
    expect(masking.browserMaskingStore.getSnapshot()).toBe(UNMASKED);
    const unsubscribe = masking.browserMaskingStore.subscribe(() => undefined);
    unsubscribe();

    jar.value = MASKED;
    expect(masking.browserMaskingStore.getSnapshot()).toBe(MASKED);
  });

  it("uses focus and visible-state events when BroadcastChannel is unavailable", () => {
    Object.defineProperty(globalThis, "BroadcastChannel", {
      configurable: true,
      value: undefined,
    });
    jar.value = UNMASKED;
    expect(masking.browserMaskingStore.getSnapshot()).toBe(UNMASKED);
    const subscriber = vi.fn();
    const unsubscribe = masking.browserMaskingStore.subscribe(subscriber);

    jar.value = MASKED;
    windowTarget.dispatchEvent(new Event("focus"));
    expect(subscriber).toHaveBeenCalledTimes(1);

    jar.value = UNMASKED;
    masking.publishBrowserMaskingChange();
    jar.value = MASKED;
    jar.visibilityState = "hidden";
    jar.dispatchEvent(new Event("visibilitychange"));
    expect(subscriber).toHaveBeenCalledTimes(2);
    jar.visibilityState = "visible";
    jar.dispatchEvent(new Event("visibilitychange"));
    expect(subscriber).toHaveBeenCalledTimes(3);
    expect(masking.browserMaskingStore.getSnapshot()).toBe(MASKED);
    unsubscribe();
  });
});

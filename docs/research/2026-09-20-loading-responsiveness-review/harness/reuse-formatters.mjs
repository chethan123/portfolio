// Diagnostic A/B only: reuse the exact formatter constructed by partsIn.
const OriginalDateTimeFormat = Intl.DateTimeFormat;
const formatters = new Map();
Intl.DateTimeFormat = new Proxy(OriginalDateTimeFormat, {
  construct(target, args) {
    const [locale, options] = args;
    if (locale !== "en-CA" || options?.hourCycle !== "h23" || options?.weekday !== "short") {
      return Reflect.construct(target, args);
    }
    const key = JSON.stringify(args);
    let formatter = formatters.get(key);
    if (formatter === undefined) {
      formatter = Reflect.construct(target, args);
      formatters.set(key, formatter);
    }
    return formatter;
  },
});

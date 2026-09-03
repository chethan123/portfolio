const [base, path, nStr] = process.argv.slice(2);
const n = Number(nStr);
for (let i = 0; i < 10; i++) await fetch(base + path).then(r => r.text());
const t0 = performance.now();
for (let i = 0; i < n; i++) await fetch(base + path).then(r => r.text());
const ms = (performance.now() - t0) / n;
console.log(`${path.padEnd(12)} ${ms.toFixed(1)} ms/req  (n=${n})`);

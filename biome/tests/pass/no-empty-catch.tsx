try {
  doSomething();
} catch (e) {
  console.error(e);
}

try {
  doSomething();
} catch (e) {
  throw new Error("Failed", { cause: e });
}

try {
  doSomething();
} catch (e) {
  // intentionally ignored: non-critical
  notify(e);
}

try {
  doSomething();
} catch {
  reportError(e);
}

try {
  doSomething();
} catch (e) {
  void e;
}

export function Demo() {
  return <div />;
}

for (const item of items) {
  try {
    doSomething(item);
  } catch {
    continue;
  }
}

while (true) {
  try {
    doSomething();
  } catch {
    break;
  }
}

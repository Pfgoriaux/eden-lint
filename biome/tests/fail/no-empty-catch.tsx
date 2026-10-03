try {
  doSomething();
} catch (e) {
}

try {
  doSomething();
} catch (e) {
  // silently ignore
}

try {
  doSomething();
} catch {
  /* no-op */
}

try {
  doSomething();
} catch (e) {
  // TODO: handle later
  // another comment
}

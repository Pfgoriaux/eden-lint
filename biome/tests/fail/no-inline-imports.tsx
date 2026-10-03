// All of these should trigger errors.

async function loadModule() {
  const m = await import("./lazy-module");
  return m;
}

const loader = async () => {
  const m = await import("./other-module");
  return m;
};

function setup() {
  const pkg = require("some-package");
  return pkg;
}

// Inline type imports should also trigger errors.
const ctx: import("@mariozechner/pi-coding-agent").ExtensionContext = {};
type Foo = import("./types").Bar;
function test(arg: import("./module").Something) {}

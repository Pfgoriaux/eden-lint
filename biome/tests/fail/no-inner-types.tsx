type GlobalType = { id: string };

function badTypeAlias() {
  type LocalType = Parameters<typeof badTypeAlias>;
  return null;
}

function badInterface() {
  interface LocalShape {
    value: string;
  }

  const local: LocalShape = { value: "ok" };
  return local;
}

export function Demo() {
  return <div />;
}

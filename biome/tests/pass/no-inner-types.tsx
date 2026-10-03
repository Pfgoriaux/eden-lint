type EditExecArgs = [unknown, { path?: string }];

interface LocalShape {
  value: string;
}

function ok(execArgs: EditExecArgs): string {
  const [, args] = execArgs;
  return args.path ?? "(missing)";
}

export function Demo() {
  const value: LocalShape = { value: ok([null, {}]) };
  return <div>{value.value}</div>;
}

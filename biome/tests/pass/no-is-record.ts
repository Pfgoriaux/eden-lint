// Updated for the schema-first rules: validate with typebox instead of
// hand-rolled narrowing helpers.
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const PayloadSchema = Type.Object({
  command: Type.String(),
  args: Type.Array(Type.String()),
});
type Payload = Static<typeof PayloadSchema>;

const parsePayload = (value: object): Payload | undefined => {
  return Value.Check(PayloadSchema, value) ? (value as Payload) : undefined;
};

export { parsePayload };

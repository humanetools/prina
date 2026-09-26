/** Field type registry assembly (T1.2) — adding a new type is one register line here */
import { FieldTypeRegistry } from "./registry.js";
import {
  textField,
  numberField,
  booleanField,
  dateField,
  enumField,
  jsonField,
} from "./basic.js";
import { uidField } from "./uid.js";
import { richtextField } from "./richtext.js";
import { mediaField } from "./media.js";
import { relationField } from "./relation.js";
import { componentField, dynamicZoneField } from "./component.js";
import { variantAxisField } from "./variant-axis.js";

export function createFieldTypeRegistry(): FieldTypeRegistry {
  const registry = new FieldTypeRegistry();
  registry.register(textField);
  registry.register(uidField);
  registry.register(numberField);
  registry.register(booleanField);
  registry.register(dateField);
  registry.register(enumField);
  registry.register(jsonField);
  registry.register(richtextField);
  registry.register(mediaField);
  registry.register(relationField);
  registry.register(componentField);
  registry.register(dynamicZoneField);
  registry.register(variantAxisField);
  return registry;
}

export * from "./registry.js";
export { expandVariantCombos, comboKey } from "./variant-axis.js";
export { isToMany } from "./relation.js";

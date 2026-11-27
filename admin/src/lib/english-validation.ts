/**
 * Browser form-validation bubbles ("Please fill out this field.") are drawn in the browser's language —
 * Korean on a Korean Windows — while the admin is English. Swap in English text for every native
 * `required` / `minLength` / `type` / `pattern` / `min`·`max` check (2026-11-10).
 */
type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

function message(el: Field): string {
  const v = el.validity;
  if (v.valueMissing) return el instanceof HTMLSelectElement ? "Please select an item in the list." : "Please fill out this field.";
  if (v.typeMismatch) {
    if (el.type === "email") return "Please enter an email address.";
    if (el.type === "url") return "Please enter a URL.";
    return "Please enter a valid value.";
  }
  if (v.badInput) return el.type === "number" ? "Please enter a number." : "Please enter a valid value.";
  if (v.tooShort && !(el instanceof HTMLSelectElement)) return `Use at least ${el.minLength} characters (currently ${el.value.length}).`;
  if (v.tooLong && !(el instanceof HTMLSelectElement)) return `Use at most ${el.maxLength} characters.`;
  if (v.rangeUnderflow && el instanceof HTMLInputElement) return `Value must be ${el.min} or more.`;
  if (v.rangeOverflow && el instanceof HTMLInputElement) return `Value must be ${el.max} or less.`;
  if (v.stepMismatch) return "Please enter a valid value.";
  if (v.patternMismatch) return el.title ? `Please match the requested format: ${el.title}` : "Please match the requested format.";
  return "";
}

const isField = (t: EventTarget | null): t is Field =>
  t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;

export function installEnglishValidation(): void {
  document.addEventListener(
    "invalid",
    (e) => {
      if (!isField(e.target)) return;
      const el = e.target;
      // a custom message the page set itself wins
      if (el.validity.customError && !el.dataset.enValidity) return;
      el.setCustomValidity("");
      const msg = message(el);
      if (msg) {
        el.dataset.enValidity = "1";
        el.setCustomValidity(msg);
      }
    },
    true,
  );
  const clear = (e: Event) => {
    if (isField(e.target) && e.target.dataset.enValidity) {
      e.target.setCustomValidity("");
      delete e.target.dataset.enValidity;
    }
  };
  document.addEventListener("input", clear, true);
  document.addEventListener("change", clear, true);
}

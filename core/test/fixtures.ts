/** Shared content-type definition fixtures for tests */

/** Product type — includes required, media min, and variant_axis (for T1.6/T1.7 verification) */
export const productDefinition = {
  fields: [
    { name: "title", type: "text", label: "상품명", required: true },
    { name: "price", type: "number", label: "가격", required: true, min: 0 },
    { name: "sku", type: "text", label: "SKU" },
    {
      name: "images",
      type: "media",
      label: "이미지",
      required: true,
      multiple: true,
      min: 2,
    },
    { name: "body", type: "richtext", label: "본문" },
    {
      name: "variants",
      type: "variant_axis",
      label: "옵션",
      axes: [{ name: "색상", options: ["Red", "Blue", "Green"] }],
    },
  ],
  displayField: "title",
};

export const articleDefinition = {
  fields: [
    { name: "title", type: "text", required: true, maxLength: 100 },
    { name: "body", type: "richtext" },
    { name: "publishDate", type: "date" },
  ],
  displayField: "title",
};

export const validRichtextDoc = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "안녕하세요 Prina 본문입니다" }],
    },
  ],
};

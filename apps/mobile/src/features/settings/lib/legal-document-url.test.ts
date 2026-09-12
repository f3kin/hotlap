import { describe, expect, it } from "vite-plus/test";

import { isLegalDocumentUrl } from "./legal-document-url";

describe("isLegalDocumentUrl", () => {
  it.each([
    "https://shwarmadev.github.io/hotlap/legal",
    "https://shwarmadev.github.io/hotlap/legal/",
    "https://shwarmadev.github.io/hotlap/privacy-policy?source=app",
    "https://shwarmadev.github.io/hotlap/terms-of-service#updates",
    "https://shwarmadev.github.io/hotlap/security-policy",
  ])("allows a configured legal document: %s", (url) => {
    expect(isLegalDocumentUrl(url)).toBe(true);
  });

  it.each([
    "https://shwarmadev.github.io/hotlap/download",
    "https://example.com/legal",
    "javascript:alert(1)",
    "not-a-url",
  ])("rejects a URL outside the legal-document allowlist: %s", (url) => {
    expect(isLegalDocumentUrl(url)).toBe(false);
  });
});

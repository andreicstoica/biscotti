import { describe, expect, test } from "vitest";
import { resolveFields } from "../plugins/onepassword/index.ts";

type TestItem = Parameters<typeof resolveFields>[0];

const sampleItem = {
  id: "item-1",
  title: "Amazon",
  category: "Login",
  vaultId: "vault-1",
  notes: "",
  tags: [],
  websites: [],
  version: 1,
  files: [],
  sections: [],
  createdAt: new Date(),
  updatedAt: new Date(),
  fields: [
    { id: "username", title: "username", fieldType: "Text", value: "owner@example.com" },
    { id: "password", title: "password", fieldType: "Concealed", value: "super-secret-pw" },
    {
      id: "TOTP_1",
      title: "one-time password",
      fieldType: "Totp",
      value: "otpauth://totp/Amazon?secret=JBSWY3DPEHPK3PXP",
      details: { type: "Otp", content: { code: "123456", errorMessage: undefined } },
    },
  ],
} as TestItem;

describe("onepassword field resolution", () => {
  test("resolves username, password, and live TOTP code by alias", () => {
    const res = resolveFields(sampleItem, ["username", "password", "totp"]);
    expect("values" in res).toBe(true);
    if ("values" in res) {
      expect(res.values()).toEqual(["owner@example.com", "super-secret-pw", "123456"]);
    }
  });

  test("reports missing field names without leaking any secret values", () => {
    const res = resolveFields(sampleItem, ["username", "cvc"]);
    expect("missing" in res).toBe(true);
    if ("missing" in res) {
      expect(res.missing).toEqual(["cvc"]);
      expect(res.available).toEqual(["username", "password", "totp"]);
      expect(JSON.stringify(res)).not.toContain("super-secret-pw");
      expect(JSON.stringify(res)).not.toContain("123456");
    }
  });
});

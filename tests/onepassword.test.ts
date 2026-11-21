import { describe, expect, test } from "vitest";
import { resolveFields, type FieldLike } from "../plugins/onepassword/index.ts";
import { totp } from "../plugins/secure-fill/index.ts";

const SECRET_URI = "otpauth://totp/Amazon?secret=JBSWY3DPEHPK3PXP";

const loginFields: FieldLike[] = [
  { id: "username", title: "username", fieldType: "Text", value: "owner@example.com" },
  { id: "password", title: "password", fieldType: "Concealed", value: "super-secret-pw" },
  {
    id: "TOTP_1",
    title: "One-Time Password",
    fieldType: "Totp",
    value: SECRET_URI,
    details: { type: "Otp", content: { code: "000000" } },
  },
];

const cardFields: FieldLike[] = [
  { id: "ccnum", title: "number", fieldType: "CreditCardNumber", value: "4111111111111111" },
  { id: "expiry", title: "expiry date", fieldType: "MonthYear", value: "202807" },
  { id: "cvv", title: "verification number", fieldType: "Concealed", value: "999" },
];

describe("onepassword field resolution", () => {
  test("resolves bidirectional aliases and normalized labels", () => {
    let now = 1_700_000_000_000;
    const login = resolveFields(loginFields, ["email", "passcode", "2fa"], () => now);
    expect("values" in login).toBe(true);
    if ("values" in login) {
      expect(login.values()).toEqual(["owner@example.com", "super-secret-pw", totp(SECRET_URI, now)]);
      // Values are computed lazily at fill time, so advancing time produces a fresh TOTP code.
      now += 60_000;
      expect(login.values()[2]).toBe(totp(SECRET_URI, now));
      expect(login.values()[2]).not.toBe("000000");
    }

    const card = resolveFields(cardFields, ["card number", "expiration date", "security code"]);
    expect("values" in card).toBe(true);
    if ("values" in card) {
      expect(card.values()).toEqual(["4111111111111111", "202807", "999"]);
    }
  });

  test("falls back to SDK-computed OTP code when raw URI value is empty", () => {
    const fields: FieldLike[] = [
      { id: "otp", title: "totp", fieldType: "Totp", value: "", details: { type: "Otp", content: { code: "654321" } } },
    ];
    const res = resolveFields(fields, ["totp"]);
    expect("values" in res).toBe(true);
    if ("values" in res) expect(res.values()).toEqual(["654321"]);
  });

  test("reports missing field names and available metadata without exposing values", () => {
    const res = resolveFields(loginFields, ["username", "cvc"]);
    expect("missing" in res).toBe(true);
    if ("missing" in res) {
      expect(res.missing).toEqual(["cvc"]);
      expect(res.available).toEqual(["username", "password", "totp"]);
    }
  });
});

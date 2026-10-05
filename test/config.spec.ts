import { describe, it, expect } from "vitest";
import { loadConfig, writesEnabled, HOSTS } from "../src/config.js";
import { redact } from "../src/klarna.js";

describe("config", () => {
  it("defaults to EU playground", () => {
    const c = loadConfig({ KLARNA_USERNAME: "u", KLARNA_PASSWORD: "p" });
    expect(c.region).toBe("eu");
    expect(c.env).toBe("playground");
    expect(c.baseUrl).toBe("https://api.playground.klarna.com");
    expect(c.authorization).toBe("Basic " + Buffer.from("u:p").toString("base64"));
  });

  it("maps every documented host", () => {
    expect(HOSTS).toEqual({
      production: { eu: "https://api.klarna.com", na: "https://api-na.klarna.com", oc: "https://api-oc.klarna.com" },
      playground: { eu: "https://api.playground.klarna.com", na: "https://api-na.playground.klarna.com", oc: "https://api-oc.playground.klarna.com" },
    });
    expect(loadConfig({ KLARNA_API_KEY: "k", KLARNA_REGION: "OC", KLARNA_ENV: "Production" }).baseUrl).toBe("https://api-oc.klarna.com");
  });

  it("sends an API key as documented: Basic <API key>", () => {
    const c = loadConfig({ KLARNA_API_KEY: "klarna_test_api_abc123" });
    expect(c.authorization).toBe("Basic klarna_test_api_abc123");
  });

  it("prefers username/password when both are set", () => {
    const c = loadConfig({ KLARNA_USERNAME: "u", KLARNA_PASSWORD: "p", KLARNA_API_KEY: "k" });
    expect(c.authorization).toBe("Basic " + Buffer.from("u:p").toString("base64"));
  });

  it("rejects bad region, env and missing credentials", () => {
    expect(() => loadConfig({ KLARNA_USERNAME: "u", KLARNA_PASSWORD: "p", KLARNA_REGION: "us" })).toThrow(/eu, na, oc/);
    expect(() => loadConfig({ KLARNA_USERNAME: "u", KLARNA_PASSWORD: "p", KLARNA_ENV: "live" })).toThrow(/playground or production/);
    expect(() => loadConfig({ KLARNA_USERNAME: "u" })).toThrow(/credentials are not set/);
  });

  it("writes are off unless the flag is exactly true", () => {
    expect(writesEnabled({})).toBe(false);
    expect(writesEnabled({ KLARNA_ENABLE_WRITES: "1" })).toBe(false);
    expect(writesEnabled({ KLARNA_ENABLE_WRITES: "yes" })).toBe(false);
    expect(writesEnabled({ KLARNA_ENABLE_WRITES: "TRUE" })).toBe(true);
    expect(writesEnabled({ KLARNA_ENABLE_WRITES: "true" })).toBe(true);
  });
});

describe("redact", () => {
  it("removes Authorization values and API keys", () => {
    expect(redact("Authorization: Basic dTpwYXNzd29yZA==")).not.toContain("dTpwYXNzd29yZA==");
    expect(redact('{"authorization":"Basic abc"}')).not.toContain("abc");
    expect(redact("key klarna_live_api_SECRETSECRET")).toBe("key klarna_live_[REDACTED]");
    expect(redact("pw is hunter22", ["hunter22"])).toBe("pw is [REDACTED]");
  });
});

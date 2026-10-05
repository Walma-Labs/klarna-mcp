// Configuration from the environment. Read lazily (when the first tool runs),
// so importing the package never demands credentials.
//
//   KLARNA_USERNAME / KLARNA_PASSWORD  API credentials, sent as standard HTTP Basic
//                                      (base64 of "username:password").
//   KLARNA_API_KEY                     Alternative: a klarna_<live|test>_api_... key,
//                                      sent as "Authorization: Basic <API key>" exactly
//                                      as Klarna's authentication page documents it.
//   KLARNA_REGION                      eu (default) | na | oc
//   KLARNA_ENV                         playground (default) | production
//   KLARNA_ENABLE_WRITES               "true" registers the write tools. Anything else: read-only.
//
// Hosts are from https://docs.klarna.com/acquirer/klarna/get-started/integration-resilience/api-urls/

export type Region = "eu" | "na" | "oc";
export type KlarnaEnv = "playground" | "production";

export const HOSTS: Record<KlarnaEnv, Record<Region, string>> = {
  production: {
    eu: "https://api.klarna.com",
    na: "https://api-na.klarna.com",
    oc: "https://api-oc.klarna.com",
  },
  playground: {
    eu: "https://api.playground.klarna.com",
    na: "https://api-na.playground.klarna.com",
    oc: "https://api-oc.playground.klarna.com",
  },
};

export interface KlarnaConfig {
  region: Region;
  env: KlarnaEnv;
  baseUrl: string;
  /** The full Authorization header value. Never log or echo this. */
  authorization: string;
  /** Raw secret values, used only to redact them from error text. Never log. */
  secrets: string[];
}

type Env = Record<string, string | undefined>;

export function parseRegion(raw: string | undefined): Region {
  const v = (raw ?? "eu").trim().toLowerCase();
  if (v === "eu" || v === "na" || v === "oc") return v;
  throw new Error(`KLARNA_REGION must be one of eu, na, oc (got "${raw}")`);
}

export function parseEnv(raw: string | undefined): KlarnaEnv {
  const v = (raw ?? "playground").trim().toLowerCase();
  if (v === "playground" || v === "production") return v;
  throw new Error(`KLARNA_ENV must be playground or production (got "${raw}")`);
}

export function writesEnabled(env: Env = process.env): boolean {
  return (env.KLARNA_ENABLE_WRITES ?? "").trim().toLowerCase() === "true";
}

export function loadConfig(env: Env = process.env): KlarnaConfig {
  const region = parseRegion(env.KLARNA_REGION);
  const kenv = parseEnv(env.KLARNA_ENV);
  const username = env.KLARNA_USERNAME?.trim();
  const password = env.KLARNA_PASSWORD?.trim();
  const apiKey = env.KLARNA_API_KEY?.trim();

  let authorization: string;
  if (username && password) {
    authorization = "Basic " + Buffer.from(`${username}:${password}`, "utf8").toString("base64");
  } else if (apiKey) {
    authorization = `Basic ${apiKey}`;
  } else {
    throw new Error(
      "Klarna credentials are not set. Set KLARNA_USERNAME and KLARNA_PASSWORD " +
      "(or KLARNA_API_KEY) to API credentials from the Klarna Merchant Portal.",
    );
  }
  const secrets = [authorization, authorization.slice("Basic ".length), password ?? "", apiKey ?? ""].filter(Boolean);
  return { region, env: kenv, baseUrl: HOSTS[kenv][region], authorization, secrets };
}

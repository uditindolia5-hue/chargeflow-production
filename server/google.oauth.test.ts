import { describe, expect, it } from "vitest";

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
const redirectUri = process.env.GOOGLE_REDIRECT_URI;

const shouldRun = process.env.RUN_CHARGEFLOW_INTEGRATION_TESTS === "true"
  && Boolean(clientId)
  && Boolean(clientSecret)
  && Boolean(redirectUri);

describe.skipIf(!shouldRun)("Google OAuth configuration", () => {
  it("is accepted by Google's token endpoint", async () => {
    expect(clientId).toBeTruthy();
    expect(clientSecret).toBeTruthy();
    expect(redirectUri).toBe("https://chargeyourev.com/python-api/auth/google/callback");

    const payload = new URLSearchParams({
      client_id: clientId!,
      client_secret: clientSecret!,
      code: "chargeflow-configuration-check",
      redirect_uri: redirectUri!,
      grant_type: "authorization_code",
    });
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: payload,
    });
    const result = (await response.json()) as { error?: string };

    // An invalid one-time code is expected. invalid_client would mean the
    // supplied OAuth client ID/secret pair was rejected by Google.
    expect(response.status).toBe(400);
    expect(result.error).toBe("invalid_grant");
  }, 15_000);
});

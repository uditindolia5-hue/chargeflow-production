import { describe, expect, it } from "vitest";

const shouldRun = process.env.RUN_CHARGEFLOW_INTEGRATION_TESTS === "true"
  && Boolean(process.env.CHARGEFLOW_ADMIN_EMAIL)
  && Boolean(process.env.CHARGEFLOW_ADMIN_PASSWORD);

describe.skipIf(!shouldRun)("production admin authentication", () => {
  it("accepts the configured admin credentials through the Python API", async () => {
    const email = process.env.CHARGEFLOW_ADMIN_EMAIL;
    const password = process.env.CHARGEFLOW_ADMIN_PASSWORD;
    expect(email).toBeTruthy();
    expect(password).toBeTruthy();

    const response = await fetch("http://127.0.0.1:8001/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const result = (await response.json()) as { role?: string; token?: string };
    expect(response.status).toBe(200);
    expect(result.role).toBe("admin");
    expect(result.token).toBeTruthy();
  }, 15_000);

  it("accepts the signed session token at the authenticated endpoint", async () => {
    const loginResponse = await fetch("http://127.0.0.1:8001/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: process.env.CHARGEFLOW_ADMIN_EMAIL, password: process.env.CHARGEFLOW_ADMIN_PASSWORD }),
    });
    const login = (await loginResponse.json()) as { token: string };
    const sessionResponse = await fetch("http://127.0.0.1:8001/auth/me", { headers: { authorization: `Bearer ${login.token}` } });
    expect(sessionResponse.status).toBe(200);
    expect((await sessionResponse.json()).role).toBe("admin");
    const qualityResponse = await fetch("http://127.0.0.1:8001/admin/data-quality", { headers: { authorization: `Bearer ${login.token}` } });
    expect(qualityResponse.status).toBe(200);
    expect((await qualityResponse.json()).status).toBe("ready");
  }, 15_000);
});

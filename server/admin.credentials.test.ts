import { describe, expect, it } from "vitest";

describe("configured ChargeFlow admin credentials", () => {
  it("authenticates against the running Python API", async () => {
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
});

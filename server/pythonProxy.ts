import { spawn, type ChildProcess } from "node:child_process";
import { Readable } from "node:stream";
import type { Express, Request, Response } from "express";

let pythonProcess: ChildProcess | null = null;
const pythonPort = Number(process.env.CHARGEFLOW_PYTHON_PORT ?? "8001");

function ensurePythonApi() {
  if (pythonProcess && !pythonProcess.killed) return;
  pythonProcess = spawn("python3", ["-m", "uvicorn", "backend.main:app", "--host", "127.0.0.1", "--port", String(pythonPort)], {
    stdio: ["ignore", "ignore", process.env.NODE_ENV === "production" ? "ignore" : "inherit"],
  });
  pythonProcess.on("error", (error) => {
    console.error("[Python API] Failed to start recommendation service", error);
    pythonProcess = null;
  });
  pythonProcess.on("exit", () => { pythonProcess = null; });
}

export function registerPythonApiProxy(app: Express) {
  ensurePythonApi();
  app.use("/python-api", async (req: Request, res: Response) => {
    ensurePythonApi();
    const targetPath = req.originalUrl.replace(/^\/python-api/, "") || "/";
    const headers: Record<string, string> = {};
    for (const headerName of ["content-type", "authorization", "cookie", "accept"]) {
      const value = req.get(headerName);
      if (value) headers[headerName] = value;
    }
    try {
      let upstream: Awaited<ReturnType<typeof fetch>> | null = null;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
          upstream = await fetch(`http://127.0.0.1:${pythonPort}${targetPath}`, {
            method: req.method,
            headers,
            body: req.method === "GET" || req.method === "HEAD" ? undefined : JSON.stringify(req.body ?? {}),
          });
          break;
        } catch (error) {
          if (attempt === 49) throw error;
          await new Promise((resolve) => setTimeout(resolve, 100));
          ensurePythonApi();
        }
      }
      if (!upstream) throw new Error("Python API did not return a response");
      res.status(upstream.status);
      upstream.headers.forEach((value, key) => {
        if (key !== "content-encoding" && key !== "transfer-encoding") res.setHeader(key, value);
      });
      if (upstream.body) Readable.fromWeb(upstream.body as never).pipe(res);
      else res.end();
    } catch (error) {
      console.error("[Python API] Proxy request failed", error);
      res.status(503).json({ detail: "The recommendation service is starting. Please retry shortly." });
    }
  });
}

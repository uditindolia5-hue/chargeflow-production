import { describe, expect, it } from "vitest";
import { connect as connectTcp, type Socket } from "node:net";
import { connect as connectTls, type TLSSocket } from "node:tls";

const shouldRun = process.env.RUN_CHARGEFLOW_INTEGRATION_TESTS === "true"
  && Boolean(process.env.CHARGEFLOW_SMTP_HOST)
  && Boolean(process.env.CHARGEFLOW_SMTP_USER)
  && Boolean(process.env.CHARGEFLOW_SMTP_PASSWORD);

type SmtpSocket = Socket | TLSSocket;

function readResponse(socket: SmtpSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (buffer.includes("\r\n")) {
        socket.off("data", onData);
        resolve(buffer);
      }
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
}

function send(socket: SmtpSocket, command: string) {
  socket.write(`${command}\r\n`);
}

async function expectCode(socket: SmtpSocket, code: string) {
  const response = await readResponse(socket);
  expect(response.startsWith(code)).toBe(true);
}

describe.skipIf(!shouldRun)("SMTP verification email configuration", () => {
  it("accepts the configured credentials without sending a message", async () => {
    const host = process.env.CHARGEFLOW_SMTP_HOST!;
    const port = Number(process.env.CHARGEFLOW_SMTP_PORT || 587);
    const username = process.env.CHARGEFLOW_SMTP_USER!;
    const password = process.env.CHARGEFLOW_SMTP_PASSWORD!;
    const tcp = await new Promise<Socket>((resolve, reject) => {
      const socket = connectTcp({ host, port }, () => resolve(socket));
      socket.once("error", reject);
    });
    tcp.setTimeout(15_000);
    try {
      await expectCode(tcp, "220");
      send(tcp, "EHLO chargeflow.local");
      await expectCode(tcp, "250");
      send(tcp, "STARTTLS");
      await expectCode(tcp, "220");
      const tls = await new Promise<TLSSocket>((resolve, reject) => {
        const socket = connectTls({ socket: tcp, host, servername: host, rejectUnauthorized: true }, () => resolve(socket));
        socket.once("error", reject);
      });
      tls.setTimeout(15_000);
      send(tls, "EHLO chargeflow.local");
      await expectCode(tls, "250");
      send(tls, "AUTH LOGIN");
      await expectCode(tls, "334");
      send(tls, Buffer.from(username).toString("base64"));
      await expectCode(tls, "334");
      send(tls, Buffer.from(password).toString("base64"));
      await expectCode(tls, "235");
      send(tls, "QUIT");
      tls.end();
    } finally {
      if (!tcp.destroyed) tcp.destroy();
    }
  }, 30_000);
});

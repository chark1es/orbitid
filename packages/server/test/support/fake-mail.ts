// Local stand-ins for the two email providers, used by the mail tests. Both listen on a random loopback port.
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createNetServer, type Socket } from "node:net";
import type { AddressInfo } from "node:net";

export interface ResendRequest {
  authorization: string | undefined;
  contentType: string | undefined;
  body: { from?: string; to?: string; subject?: string; html?: string; text?: string };
}

/** Minimal Resend API: records each JSON request and answers with the given status/body. */
export async function startFakeResend(options: { status?: number; responseBody?: string } = {}) {
  const requests: ResendRequest[] = [];
  const handle = (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let body: ResendRequest["body"] = {};
      try {
        body = JSON.parse(text) as ResendRequest["body"];
      } catch {
        body = {};
      }
      requests.push({ authorization: req.headers.authorization, contentType: req.headers["content-type"], body });
      res.writeHead(options.status ?? 200, { "content-type": "application/json" });
      res.end(options.responseBody ?? JSON.stringify({ id: "re_fake_message" }));
    });
  };
  const server = createHttpServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/emails`,
    requests,
    last: () => requests[requests.length - 1],
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export interface SmtpMessage {
  /** Raw message as received after DATA, before decoding. */
  raw: string;
  mailFrom: string;
  recipients: string[];
}

/**
 * A tiny ESMTP server speaking just enough for nodemailer: EHLO, MAIL FROM, RCPT TO, DATA, RSET, NOOP, QUIT.
 * It never advertises STARTTLS or AUTH, so a plain `smtp://` connection stays in the clear.
 */
export async function startFakeSmtp() {
  const messages: SmtpMessage[] = [];
  const connections: Socket[] = [];

  const handle = (socket: Socket) => {
    connections.push(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    let inData = false;
    let data = "";
    let mailFrom = "";
    let recipients: string[] = [];
    socket.write("220 fake.invalid ESMTP ready\r\n");

    const reply = (line: string) => socket.write(`${line}\r\n`);

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end === -1) return;
          data += buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          // Undo SMTP dot-stuffing.
          messages.push({ raw: data.replace(/\r\n\.\./g, "\r\n."), mailFrom, recipients: [...recipients] });
          data = "";
          reply("250 2.0.0 Ok: queued as fake");
          continue;
        }
        const index = buffer.indexOf("\r\n");
        if (index === -1) return;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const command = line.toUpperCase();
        if (command.startsWith("EHLO") || command.startsWith("HELO")) {
          socket.write("250-fake.invalid\r\n250-8BITMIME\r\n250 SIZE 10485760\r\n");
        } else if (command.startsWith("MAIL FROM")) {
          mailFrom = /<([^>]*)>/.exec(line)?.[1] ?? "";
          reply("250 2.1.0 Ok");
        } else if (command.startsWith("RCPT TO")) {
          recipients.push(/<([^>]*)>/.exec(line)?.[1] ?? "");
          reply("250 2.1.5 Ok");
        } else if (command.startsWith("DATA")) {
          inData = true;
          data = "";
          reply("354 End data with <CR><LF>.<CR><LF>");
        } else if (command.startsWith("RSET")) {
          mailFrom = "";
          recipients = [];
          reply("250 2.0.0 Ok");
        } else if (command.startsWith("NOOP")) {
          reply("250 2.0.0 Ok");
        } else if (command.startsWith("QUIT")) {
          socket.end("221 2.0.0 Bye\r\n");
        } else {
          reply("250 2.0.0 Ok");
        }
      }
    });
    socket.on("error", () => undefined);
  };

  const server = createNetServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    /** Credential-free URL; `smtp://` so STARTTLS is optional and the fake server can stay plaintext. */
    url: `smtp://127.0.0.1:${port}`,
    messages,
    last: () => messages[messages.length - 1],
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of connections) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** Header block of a raw message, one entry per header line (unfolded). */
export function rawHeaders(raw: string): { name: string; value: string }[] {
  const headerBlock = raw.split("\r\n\r\n")[0] ?? "";
  const lines = headerBlock.split("\r\n");
  const headers: { name: string; value: string }[] = [];
  for (const line of lines) {
    if (/^[\t ]/.test(line) && headers.length) {
      headers[headers.length - 1]!.value += ` ${line.trim()}`;
      continue;
    }
    const index = line.indexOf(":");
    if (index > 0) headers.push({ name: line.slice(0, index), value: line.slice(index + 1).trim() });
  }
  return headers;
}

/**
 * Flattens a raw MIME message into readable text: quoted-printable soft breaks are removed and `=XX` escapes are
 * decoded, and base64 bodies are decoded too, so codes and links can be located regardless of encoding.
 */
export function readableMessage(raw: string): string {
  const [headerBlock = "", ...rest] = raw.split("\r\n\r\n");
  const body = rest.join("\r\n\r\n");
  const decoded = body.replace(/=\r\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  const base64Parts = [...headerBlock.matchAll(/Content-Transfer-Encoding:\s*base64/gi)];
  const plain = base64Parts.length
    ? body.replace(/[A-Za-z0-9+/=\r\n]{40,}/g, (block) => {
        try {
          return Buffer.from(block.replace(/\s/g, ""), "base64").toString("utf8");
        } catch {
          return block;
        }
      })
    : decoded;
  return `${headerBlock}\n\n${plain}`;
}

/** First URL in a message, with trailing punctuation and quoting removed. */
export function linkIn(message: string): string | undefined {
  const match = /https?:\/\/[^\s"'<>]+/.exec(message);
  return match?.[0]?.replace(/[.,)]+$/, "");
}

/** Six-digit code from a message. */
export function codeIn(message: string): string | undefined {
  return /\b(\d{6})\b/.exec(message)?.[1];
}
